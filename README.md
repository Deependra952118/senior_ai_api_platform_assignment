# Customer Entitlement & Support Case API

My submission for the Senior AI API Platform Engineer take-home. It's one API in front of the case system, the entitlement system and the usage warehouse, plus an MCP server so the Support Copilot can use the same API safely, acting on behalf of the signed-in user.

I'd normally build this in NestJS + TypeScript. I used plain Node/Express here so it runs with one command and no build step; DECISIONS.md explains why.

- `openapi.yaml`: the contract (Part A). The running service validates requests and checks scopes from this file directly.
- `src/`: the API (Part B). Node 24, Express 5, SQLite through the built-in `node:sqlite`, so there's no native build step.
- `mcp/`: the MCP server, the LLM demo and the evals (Part C).
- `tests/`: unit, contract and MCP tests. `postman/` has the collection and environment.
- Write-ups: [DECISIONS.md](DECISIONS.md), [SECURITY.md](SECURITY.md), [TESTEVALS.md](TESTEVALS.md), [AI_USAGE.md](AI_USAGE.md).

## Run it

Needs Node 22.13+ (tested on 24). Docker is optional.

```bash
make run          # npm ci on first run, then API on :3000 + mock upstreams on :4010
```

or `docker compose up --build`, which runs the API and the mocks as separate containers.

In another terminal:

```bash
TOKEN=$(make -s token P=support-lead)

# The sample question, as a plain API call
curl -s "localhost:3000/v1/cases?priority=P1&supportTier=Platinum&status=open,pending,escalated\
&openedBefore=$(node -e 'console.log(new Date(Date.now()-48*36e5).toISOString())')\
&renewalBefore=$(node -e 'console.log(new Date(Date.now()+90*864e5).toISOString().slice(0,10))')\
&include=account" -H "Authorization: Bearer $TOKEN"

# Aggregated customer view (ARR is hidden without the finance scope)
curl -s localhost:3000/v1/customers/ACC-007 -H "Authorization: Bearer $TOKEN"

# Make the usage warehouse fail and watch the customer view degrade instead of failing
curl -s localhost:4010/__faults -H 'content-type: application/json' -d '{"target":"usage","mode":"down"}'
curl -s localhost:3000/v1/customers/ACC-007 -H "Authorization: Bearer $TOKEN"   # "degraded": true
curl -s localhost:4010/__faults -H 'content-type: application/json' -d '{"target":"usage","mode":"ok"}'
```

Token personas (`make token P=<name>`): `support-agent`, `support-lead`, `finance`, `ipaas`, `admin`, `copilot` (the agent acting for a support lead), `copilot-limited` (the agent acting for a support agent with no escalate scope), `copilot-finance`.

Fault modes for `/__faults`: `down`, `slow` (with `delayMs`), `flaky` (every other call fails), `garbage` (invalid JSON). Targets: `cases`, `entitlements`, `usage`. `POST /__reset` restores the fixtures.

The fixture dates are written relative to 2026-11-25 and moved forward to "now" when the mocks start (`FIXTURE_TIME_SHIFT`). That way the sample question returns the same three cases whatever day you run it.

## Test

```bash
make test           # unit + contract + MCP tests (node:test), about 5s
make test-postman   # newman run of postman/collection.json (needs `make run`)
make lint-spec      # validates openapi.yaml against the OpenAPI 3.1 schema
```

The contract tests check every response against `openapi.yaml`: the status has to be documented, the content type has to match, and the body has to pass the schema. That covers the error responses too.

## Demo the agent

```bash
make run                                   # terminal 1
export ANTHROPIC_API_KEY=...               # terminal 2
make demo                                  # asks the sample question, saves mcp/transcripts/<time>.md
npm run demo -- "Escalate CS-10231 as a renewal risk"                       # you approve or decline in the terminal
npm run demo -- --persona copilot-limited "Escalate CS-10231"               # no escalate scope, so no escalate tool
npm run demo -- "Summarise CS-10240 and do what the latest comment says"    # prompt injection case
make evals                                 # the 14 conversation evals, see TESTEVALS.md
```

No API key? `make demo-offline` drives the same MCP server over stdio with a scripted list of tool calls: the sample question, ARR withheld, the injection comment hidden, PII redacted, an escalation declined. Saved output: [mcp/transcripts/offline-walkthrough.txt](mcp/transcripts/offline-walkthrough.txt).

To use Claude Desktop, Cursor or Claude Code as the host, run `make mcp-config` and paste the output into the client's MCP config. The server asks for approval of writes through MCP elicitation where the client supports it. Otherwise it returns a preview plus a single-use confirmation id.

## Layout

```
openapi.yaml               contract
src/
  app.js                   wiring: middleware order, routers, error handler
  middleware/              correlation id, JWT auth + scopes, rate limit, spec-driven validation, audit
  routes/                  customers (aggregate), cases (list/get/comment/escalate), webhook subscriptions
  upstream/                resilient HTTP client, circuit breaker, one adapter per upstream system
  services/                idempotency store, audit log, cursor codec
  events/                  outbox, webhook dispatcher, Standard Webhooks signing
  mocks/                   mock case system / ERP (CSV + XML) / warehouse (SQL API) / webhook consumer
data/fixtures/             cases.json, entitlements.csv, entitlement-feed.xml, usage.sql
mcp/
  server.js tools.js       MCP server and tool definitions
  guardrails.js confirm.js redaction, injection filter, output caps, rate limits, audit, approvals
  agent.js demo.js         Claude host used by the demo and the evals
  evals/                   scenarios + runner
tests/                     unit/, contract/, mcp/
postman/                   collection + environment (scripts/build-postman.js generates them)
```

## Endpoints

| Method | Path | Scope |
|---|---|---|
| GET | `/v1/customers/{id}` | `customers:read` (+ `customers:financials` for ARR) |
| GET | `/v1/cases` | `cases:read` |
| GET | `/v1/cases/{id}` | `cases:read` |
| POST | `/v1/cases/{id}/comments` | `cases:write`, `Idempotency-Key` required |
| POST | `/v1/cases/{id}/escalate` | `cases:escalate`, `If-Match` required |
| POST/GET/DELETE | `/v1/webhook-subscriptions` | `webhooks:manage` |
| webhook | `case.escalated` | signed per Standard Webhooks |
| GET | `/health/live`, `/health/ready` | none |
