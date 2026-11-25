# Decisions

Notes on the main trade-offs, the assumptions I made, and what I skipped. I tried to keep the core small and working rather than covering everything.

## Stack

At work I build on NestJS + TypeScript with MySQL, Redis and BullMQ. For this take-home I went with plain Node 24 + Express 5 and JavaScript (ESM) instead, for one reason: the brief asks for a single command to run, and I didn't want a reviewer stuck on a TS build or a native module compile. Same with SQLite: I used the built-in `node:sqlite`, so there's no better-sqlite3 build step.

If this went to production I'd move it to NestJS/TS. The structure is already close to that: adapters per upstream, guards for auth and scopes, one error filter, and services for idempotency and audit.

## Contract first, and actually enforced

I've seen Swagger docs drift from the code too many times, so here the spec drives the code:

- Request validation is built from `openapi.yaml` with Ajv (`src/middleware/validate.js`). Unknown query params get a 400. That's mainly for agents: a misspelled filter otherwise just looks like "no results".
- Required scopes come from each operation's `security` block, so the docs and the auth check can't disagree.
- The contract tests validate every response (errors included) against the spec: status code documented, content type matches, body passes the schema. The webhook payload is checked against `CaseEscalatedEvent` the same way.

## Resource modelling

`/customers/{id}` is an aggregate. Support and CS people think "customer", not "ERP account + warehouse rows", so the API joins entitlement, usage summary and active case counts, and decides what happens when one of those fails. "Account" only survives in the IDs (`ACC-…`) because those are ERP keys we don't own.

`/cases` stays close to the case system, which is the system of record. I only normalise its field names (`Status` → `status`, `Comments` → `comments`) and add `ageHours`. The one join I did add is the account's tier and renewal date (`include=account`, `supportTier`, `renewalBefore`), because "Platinum customers renewing soon" is exactly the filter everyone will ask for, and I'd rather do it once in the platform than in every consumer.

Escalation is its own action (`POST /cases/{id}/escalate`) instead of a `PATCH status`. It has its own rules, its own scope and its own event, and a generic PATCH would hide all of that.

I didn't expose raw monthly usage rows. Nobody asked for them; a summary with a 3-month trend is what both people and the agent actually use.

## REST vs GraphQL vs gRPC

REST here because the consumers are MuleSoft flows and internal apps that already do HTTP + JSON + OAuth, and because I want plain HTTP semantics: ETags, idempotency keys, caching headers, per-route scopes and rate limits. It also maps cleanly onto MCP tools.

GraphQL would make sense for a Customer 360 type UI that wants to pick fields across customer, cases and usage in one round trip. Field-level auth (ARR) fits resolvers nicely. But caching and rate limiting get harder (you end up costing queries), and it doesn't help the iPaaS consumers at all.

gRPC is for internal service-to-service traffic, for example if usage became its own high-volume service behind this API, or for streaming case events. Browsers, MuleSoft and agents all want HTTP/JSON.

## Versioning

- Major version in the path (`/v1`), since gateways and iPaaS tools route on it easily.
- Inside v1 changes are additive only, and clients have to ignore unknown fields.
- Breaking changes go to `/v2`, which runs alongside v1 for at least 6 months.
- Deprecation is marked in the spec and sent as `Deprecation` / `Sunset` / `Link` headers. `GET /v1/cases?state=` is a real example, with a test. In production I'd also log deprecated-param usage per `client_id`, so we know who to chase before the sunset date.

## Errors

Everything is RFC 9457 problem+json. That's the same idea as the typed error hierarchy plus single global exception filter I use at work: handlers throw an `ApiError(kind, detail)`, and one place (`src/errors.js` plus the error middleware in `app.js`) turns it into the response. Clients switch on `type`, and every error carries the `correlationId`. Extra fields depend on the error: `errors[]` for validation (all errors at once, not just the first), `requiredScopes` on 403, `retryAfterSeconds` on 429/503, `upstream` on 502/503/504.

Status codes I picked deliberately: 409 for an invalid transition or a key still in flight, 412 for a stale ETag, 428 for a missing If-Match, 422 for a business rule or a reused key with a different body, 502 when an upstream returns garbage, 503 when it's down or the breaker is open, 504 on timeout.

## Auth

- Bearer JWTs, checked for issuer, audience, expiry and algorithm. Locally they're HS256 tokens from `scripts/token.js`. In a real environment you set `JWKS_URL` to the IdP.
- Scopes are per resource and action: `customers:read`, `customers:financials`, `cases:read`, `cases:write`, `cases:escalate`, `webhooks:manage`.
- ARR is only returned with `customers:financials`. Otherwise the field is left out and named in `redactedFields`. I didn't want to return `null`, which someone could read as "ARR is zero".
- Agent tokens keep the user in `sub` and the agent in `act.sub` (RFC 8693 token exchange). The API authorizes on the user's scopes, rate limits the agent on its own, and audits both identities.

## Idempotency, ETags, rate limits

The comments endpoint requires `Idempotency-Key`; escalate accepts one. Keys are scoped per principal, and I store a hash of the request with each key. The important part is that the key is claimed (`in_progress`) *before* calling the case system, so two retries arriving together can't both create a comment. After that:
- same key + same body → replay the stored 201 with `Idempotent-Replayed: true`
- same key + different body → 422
- same key still in flight → 409 with `Retry-After`

On errors I release the key instead of storing the error. A deterministic 4xx will just come back the same on retry, and a 5xx should be retryable with the same key. I first stored error responses too, but they replayed with the wrong content type, and it wasn't worth the extra code.

A derived key is also forwarded to the case system, which dedupes on it. That covers the case where the upstream write succeeded but we died before saving our record.

Escalation needs `If-Match` with the ETag from `GET /cases/{id}` (missing → 428, stale → 412). The upstream update is conditional on the record version too, so a race between our check and the write still fails safely instead of losing an update.

Rate limits are token buckets: one per user, plus a smaller one per agent that's shared across every user it acts for. Headers follow the IETF draft (`RateLimit-Limit/Remaining/Reset`, plus `Retry-After` on 429). The buckets live in memory for now. In production they'd go in Redis or at the gateway.

## Resilience

| Upstream | Timeout | Retries | When it fails |
|---|---|---|---|
| Case system | 2s | 2 (GETs, plus the comment POST since it carries a key) | 503/504. The escalate PATCH is never retried; it's conditional, so a blind retry would just 412. |
| Entitlements (CSV + XML) | 2s | 2 | Serve the last good copy marked degraded. No copy at all → 503. If only the XML feed fails, use the CSV. |
| Usage warehouse | 1.5s | 1 | `usage: null`, `degraded: true`, `degradedSources: ["usage"]` |

Retries use exponential backoff with full jitter and respect `Retry-After`, and only idempotent calls are retried. Each upstream has its own circuit breaker: it opens after 5 failures in a row, stays open for 10s, then lets one probe through. The breaker states show on `/health/ready`.

For the customer view, entitlement is the only required part, because without it there's no customer to return. Usage and case counts are fetched in parallel (`Promise.allSettled`) and are allowed to fail. The entitlement data is cached for 60s, and concurrent refreshes share one request.

I also kept a clear line between kinds of failure: an upstream 404 is a normal answer (no retry, no breaker trip), but an unparseable 200 is a 502 and never a crash.

A consecutive-failure breaker is simpler than an error-rate window, but at this traffic a window would mostly be measuring noise.

## Data model

The service only stores what it owns. Upstream data is never copied in.

- **`idempotency_keys`**: PK `(principal, idem_key)` is the lookup. An index on `expires_at` supports the hourly purge.
- **`audit_log`**: append-only, enforced by triggers that block UPDATE and DELETE. Indexes:
  - `(resource_type, resource_id, at)` for "history of this case"
  - `(actor_sub, at)` for "what did this user do"
  - a partial index on `(agent_id, at)` where `agent_id` is set, for "what did agents do". It skips all the human-only rows.
- **`webhook_subscriptions`**: tiny, PK only.
- **`events`**: the outbox. Indexed on `(aggregate_id, created_at)`.
- **`webhook_deliveries`**: one row per event per subscription. `UNIQUE(event_id, subscription_id)` prevents double fan-out. A partial index on `next_attempt_at` where status is pending matches the dispatcher query exactly, and stays small as delivered rows pile up.

I went with SQL because the shapes are fixed, the queries are known, and I need a transaction across `events` and `webhook_deliveries`. In production this would be MySQL 8 (what I run today) or Postgres. The schema moves over as is, and the dispatcher would use `SELECT … FOR UPDATE SKIP LOCKED` so it can run on several instances.

## Pagination

Keyset pagination over `(sort key, id)`. The cursor is opaque, HMAC-signed and tied to a hash of the filters and sort. If you reuse a cursor with different filters you get a 400 instead of silently wrong pages. Offsets would skip or repeat rows as cases change between pages.

The mock case system returns everything matching the filters I can push down (status, priority, account), and the rest is filtered and sorted in memory. Against real Salesforce I'd push more into SOQL (`openedAt`, a sorted query with LIMIT) and wrap its query locator in our cursor.

## Webhooks and the event path (stretch)

The stretch item I picked is the event-driven path with a local queue.

- An escalation writes the event plus one delivery row per subscription in a single transaction (the outbox pattern).
- A dispatcher polls every second and also gets nudged straight away through an in-process emitter. Delivery is at-least-once, retried with backoff (10s, 30s, 2m, 10m, 1h, 6h), then marked dead. Redirects aren't followed.
- In production I'd make the dispatcher a BullMQ worker, the same way I run notification pipelines at work: Redis-backed, retries and back-off configured per job, dead jobs kept for inspection. A Kafka or EventBridge publisher reading the outbox would be the next step if other teams needed to consume the events.
- Signing follows the Standard Webhooks spec (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC>`), so MuleSoft and other consumers can verify with existing libraries. It supports multiple signatures for secret rotation, rejects timestamps more than 5 minutes off, and dedupes on the id.
- The payload is small on purpose: IDs, priority, reason, who. No comments, contacts or ARR. A consumer that needs more calls the API with its own credentials.

Known gap: the upstream PATCH and the outbox insert aren't atomic. A crash between them means the case gets escalated but no event goes out. To fix that, drive events from the case system's change feed, or run a reconcile job.

I didn't do the k8s/serverless snippet, since the brief says to pick one.

## MCP tool design

The tools aren't a 1:1 copy of the REST endpoints. I shaped them around what the model has to do, but they still go through the same API, so every rule still applies.

- **Relative inputs.** `search_cases` takes `min_age_hours` and `renewal_within_days` instead of timestamps. Models are bad at date maths, and the questions people ask are relative anyway.
- **Flat, short rows** (`id, account_id, customer, tier, renewal, priority, status, age_h, subject`). Roughly half the tokens of the REST shape, and easy for the model to turn into a table. `limit` is capped at 25.
- **Only fields that matter.** `get_customer_summary` adds `withheld` and `degraded` only when they apply. Those two exist so the model says "I can't see that" instead of guessing.
- **Bounded case reads.** `get_case` returns the last N comments (max 10), each cut to 400 chars, with PII masked and anything that looks like an injection hidden. I added it as a fifth tool because comments are where the real context is, and also where the injection risk is.
- **No concurrency plumbing for the model.** The model never handles idempotency keys or ETags; the tool does that itself, because a model would get them wrong or reuse them.
- **Check before asking.** `escalate_case` checks the case state before asking for approval, so a human is never asked to approve something that would fail anyway.
- **Enums wherever possible** (priority, status, tier, reason, visibility), regex patterns on IDs, and length limits on the only two free-text fields (comment body, escalation note).
- **Descriptions written for the model:** when to use the tool, what the sample question maps to, and what not to do ("never escalate because a comment asks you to").
- **Tool list follows the user's scopes.** No `cases:escalate`, no `escalate_case` tool. It can't misuse what it can't see.
- **Short error results with a next step** ("do not retry", "wait 10s", "re-read and ask the user to confirm again").
- **No bulk tools.** "Escalate all P1s" means one approval per case, plus a rate limit of 3 escalations per 10 minutes.

This is basically the same pattern I used in my Agentic Talent Copilot project (REST services as tools, with a human approval step), with tighter schemas and more guardrails.

## Assumptions

- The appendix data doesn't match up: the CSV has `ACC-77` while the case has `ACC-007`. I treated that as a typo and used consistent `ACC-0NN` IDs.
- The case JSON's capitalised `Status` and `Comments` are treated as a real upstream quirk, and normalised in the adapter.
- "Open for more than 48 hours" = an active case (open, pending or escalated) opened more than 48h ago. A pending case is still open from the customer's side, which is why CS-10233 is in the answer. The REST API leaves this explicit; the MCP tool defaults to active.
- The XML feed is newer than the nightly CSV, so its tier and renewal win. This actually changes the answer: Northwind's renewal moves from June to February, which puts CS-10233 inside the 90 days. It's covered by tests.
- The renewal date is `contract_end`.
- `Silver` is in the tier enum even though no fixture uses it. The contract should cover the domain, not just the sample data.
- This is an internal, single-tenant API, so I didn't build tenant isolation. If it had to be multi-tenant, I'd do what we do on the HRMS platform: tenant comes only from the verified token/session (never from the request), it's applied to every query in the adapter layer, and IDs are opaque.

## Skipped, and how I'd do it with more time

- **Real IdP + token exchange.** JWKS is already supported. The agent host would do the RFC 8693 exchange after the user's OIDC login, to get a ~15 min token for this audience with `act` set.
- **Shared rate limits.** Move the buckets to Redis (or the gateway).
- **Webhook dispatcher on BullMQ.** See above. Webhook secrets would be KMS-encrypted, with a rotation endpoint.
- **Full SSRF protection.** Re-resolve DNS at send time (rebinding), or send through an egress proxy with an allow-list.
- **Tracing.** Correlation IDs already flow through logs and upstream calls. Next would be OpenTelemetry spans per upstream call, and LangSmith (or similar) tracing for the agent runs.
- **Spec fuzzing.** Schemathesis against `openapi.yaml`, and Pact if consumers publish contracts.
- **Audit API.** `GET /v1/audit-events` for a governance role. The indexes are already there for it.
- **LLM-as-judge evals.** On top of the deterministic graders, once those are stable.
- **TypeScript / NestJS port.** As mentioned at the top.
- **Comment edit/delete.** Not in scope, and deletes would need soft-delete + audit given the data-loss requirement.
