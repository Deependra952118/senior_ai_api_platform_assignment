# Security, governance and guardrails

What I put in place, where it lives in the code, and what's still missing. Where I mention a test, that's the test that proves the control works.

## Identity and the agent's authority

```
 user (sam) --OIDC login--> agent host --token exchange (RFC 8693)--> IdP
                                 |   token: sub=sam, act.sub=support-copilot,
                                 |          scope = sam's scopes (never more), aud=customer-platform-api, ~15 min
                                 v
                         MCP server (stdio)        holds only that token; no service credentials
                                 |  Authorization: Bearer <same token>, X-Correlation-Id: mcp-<uuid>
                                 v
                         Platform API              authorizes on sam's scopes, rate limits the agent,
                                                   audits actor_sub=sam + agent_id=support-copilot
```

- The agent is never a super-user. The MCP server has no credentials of its own. It forwards the user's delegated token, so the agent can do at most what the user could do in the UI. The finance persona sees ARR and the support persona doesn't, whether through the API or through the agent. (Test: `arr-withheld` / `arr-finance` evals, `get_customer_summary withholds ARR`.)
- The MCP server **refuses to start** with a token that has no `act` claim, unless `MCP_ALLOW_UNDELEGATED=1`. That catches someone wiring it up with a personal or service token.
- Tools are filtered by scope. If the user lacks `cases:escalate`, `escalate_case` isn't offered at all. (Test: `lists tools ... escalate hidden`.)
- The API verifies issuer, audience, expiry (30s skew) and algorithm. HS256 is local-only. Real deployments set `JWKS_URL` and asymmetric algorithms.
- Comment and escalation authors always come from the token's `sub`. The request body can't set an author: extra fields are rejected. Agent actions are stamped with `via.agent`. (Test: `missing Idempotency-Key, unknown field...`, `agent-made comments record the agent`.)

## Authorization

- Scopes per operation, read from `openapi.yaml`, so the docs and the enforcement can't disagree.
- Field-level: `arrUsd` needs `customers:financials`. Otherwise it's omitted and named in `redactedFields`.
- 403 responses list `requiredScopes`, so the caller (or the agent) can explain the problem instead of retrying.
- Denied requests (401/403) are audited.

## Protecting against data loss and bad writes

| Risk | Control |
|---|---|
| Duplicate writes from retries (network, iPaaS redelivery, agent loops) | Required `Idempotency-Key` on comments, optional on escalate. The key is claimed before the upstream call. A derived key is forwarded upstream as a second layer. (Tests: idempotency unit + contract tests.) |
| Lost updates / acting on stale data | ETag + `If-Match` required for escalation (428/412). The upstream write is conditional on the version as well. |
| Invalid state changes | Server-side business rules (only open/pending can be escalated; the P3/P4 tier rule). The MCP tool checks state again before asking a human. |
| Silent partial data | The aggregate says `degraded` and `degradedSources` instead of returning zeros. Stale entitlement data is flagged. |
| Lost events | Outbox tables. Event and delivery rows are written in one transaction, retried with backoff, dead-lettered after 6 attempts, and kept. |
| Tampering with history | `audit_log` is append-only, enforced with SQLite triggers on UPDATE and DELETE. No delete endpoints exist for cases or comments. |
| Agent mass-changes | No bulk write tools. Every write needs a human approval. Escalations are rate limited to 3 per 10 minutes per agent. |

For production I'd add MySQL/Postgres with point-in-time backups, the audit log shipped to WORM storage or a SIEM, and DB credentials from a secrets manager.

## Agent guardrails (MCP)

### Human in the loop

`add_case_comment` and `escalate_case` go through `mcp/confirm.js`:
1. If the client supports MCP elicitation, the server asks the human directly with a preview of exactly what will happen, and the model never sees an approval token. The demo host prompts in the terminal. Declining returns `declined_by_user`, and nothing is written. (Tests: `elicitation approve`, `elicitation decline`.)
2. Otherwise (preview mode) the first call returns a preview and a `confirmation_id`. The id is single-use, expires in 5 minutes, and is bound to a hash of the exact tool and arguments, so it can't be reused for a different case or text. (Test: `preview mode: token is single-use and bound to the exact arguments`.)
   - Limitation: in preview mode it's the host or the model that relays the approval. A misbehaving model could approve its own action. Use elicitation, or `MCP_APPROVAL_MODE=deny`, for untrusted hosts. The API's scope checks still cap the damage either way.
3. `MCP_APPROVAL_MODE=deny` makes the server read-only.

The tools also carry MCP annotations (`readOnlyHint`, `destructiveHint` on escalate), so hosts like Claude Desktop add their own confirmation.

### Prompt injection through data

Case subjects and comments are customer- or staff-written, so they're treated as untrusted. Several layers, since no single one is enough:
1. Server `instructions` and the tool descriptions say this content is data, not instructions.
2. Text that looks like it's addressed to an assistant ("ignore previous instructions", "system note", "escalate all cases", role tags…) is **replaced** with a marker, and the tool result carries a `warning` telling the model to report it rather than act on it. (Test: `get_case hides comments that try to instruct the assistant`; evals `injection-direct`, `injection-indirect`.)
3. Zero-width and control characters are stripped first, so the patterns can't be dodged with invisible characters.
4. Even if an injection gets past the filter, the action layer holds: writes need a human, there's no bulk tool, and the escalate tool's description says never to escalate because content asks for it.

The regex filter is a heuristic and will miss paraphrases. Layer 4 is the one that actually stops harm. Production would add a classifier (or a small model) as layer 2.5 and log the flagged texts for review.

### PII and financial data

Emails, phone numbers, card-like numbers and SSN patterns in free text are replaced (`[email]`, `[phone]`, …) before reaching the model. ARR only reaches the model if the user has the finance scope. The write tool's description tells the model not to put contact details or financials into comments. The MCP audit log stores the length and a hash of comment bodies, never the text.

### Output size

Search returns at most 25 rows. Text fields are cut (subject 120, comment 400 chars). Whole responses are capped at 6,000 chars by dropping trailing rows and setting `truncated: true`, so the model knows there's more.

### Per-agent rate limits

In the MCP server, per agent by risk class: reads 30/min, writes 5/min, escalations 3 per 10 min. In the API there's an agent bucket shared across every user the agent acts for, separate from the users' own buckets. A runaway agent can't starve humans and can't get around the limit by switching users. (Tests: `escalations are rate limited per agent`, `agents hit their own rate limit`.)

### Audit of every tool call

`mcp/audit.log` gets one JSON line per call: ts, tool, user, agent, summarised args, outcome (`ok`, `refused`, `pending_confirmation`, `rate_limited`, `error`), latency, and `correlation_id`. The API writes its own audit row with the same correlation id, so "what did the agent do, and what did the API do because of it" is one join. (Test: `every tool call is audited ...`.) The API audits every agent request, reads included, plus every write and every denial.

## Input handling

- Everything is validated against the spec: path patterns (`^CS-\d{4,8}$`), enums, lengths, formats. Unknown query params and body fields are rejected.
- Bodies are capped at 32 KB. Malformed JSON gets a 400 problem response, not a stack trace.
- Upstream responses are parsed defensively. Garbage gets a 502 and the process doesn't crash. CSV and XML rows with bad tiers or dates are skipped and logged.
- The warehouse adapter only sends fixed, parameterised SQL. The mock also refuses anything that isn't a SELECT.

## Webhooks

- HMAC-SHA256 signatures (Standard Webhooks), constant-time comparison, 5-minute timestamp tolerance, dedupe on `webhook-id`. The example receiver in `src/mocks` does all of that against the raw body.
- Secrets are generated server-side, shown once on creation, and never returned again.
- SSRF guard on subscription URLs: https only; no embedded credentials; no private, loopback or link-local IPs (169.254.169.254 included) and no `.internal`/`.local` hosts outside local dev. Redirects aren't followed when delivering.
- Payloads are minimal: no comments, contacts or ARR.

## Transport, logging, secrets

- Structured JSON logs (pino) with a correlation id on every line. The id is propagated to upstreams and returned in errors. The `Authorization` header, cookies and secrets are redacted from logs.
- Response headers: `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` by default (`private, max-age=30` on the customer view), restrictive CSP, no `X-Powered-By`.
- TLS terminates at the gateway or ingress. The service itself speaks plain HTTP locally.
- No real credentials anywhere in the repo. The dev JWT and webhook secrets are obvious placeholders, and `.env` is gitignored.
- The container runs as the non-root `node` user with production dependencies only.

## Known gaps

- Rate limits and the confirmation store are in memory: per process, and reset on restart. In production they'd move to Redis.
- Webhook secrets are stored in plain text in SQLite. They should be KMS-encrypted.
- No DNS-rebinding protection for webhook targets.
- The prompt-injection filter is pattern-based (see above).
- No data retention job for the audit log or events yet. Policy would be something like 1 year hot, then archive.
- Single tenant. For multi-tenant use, the tenant would come only from the verified token and be applied to every upstream query, never taken from the request (same rule I follow on the HRMS platform).
- `npm audit --omit=dev` is clean. The full `npm audit` lists advisories in the newman (Postman CLI) dev toolchain only. They aren't shipped in the image (`npm ci --omit=dev`).
