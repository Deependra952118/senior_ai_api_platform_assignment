# AI usage

I work AI-native day to day: Cursor and Claude Code, and at PeopleStrong I maintain an agent skill our coding agents use to generate admin APIs that follow team rules. So I used Claude Code for this assignment the same way I use it at work. I gave it the brief and my constraints, had it do most of the typing, and spent my time on decisions, review and verification.

## How I used it

- **Spec.** I gave it the brief plus the decisions I wanted visible in the contract: customer as an aggregate, cases as a pass-through, problem+json, scopes with ARR restricted to finance, a real deprecation example. It drafted `openapi.yaml`, and I went through it operation by operation.
- **Code.** Generated one module at a time (adapters, middleware, routes, mocks, MCP server), running each piece before moving on. I kept the same structure I'd use in NestJS: an adapter per upstream, auth as guards, one error mapper.
- **Tests.** I wrote the scenario lists (what should happen when usage is down, a key is reused, an ETag is stale, a comment contains an injection). It turned those into test code.
- **Docs.** It wrote first drafts. I rewrote them to say what I actually think and cut the filler.

## What it got wrong

All of these actually came up while building this:

1. **Webhook signatures never verified.** The mock receiver used `express.raw()`, but `express.json()` was registered globally first, so the HMAC was computed over `[object Object]`. The sign/verify unit tests passed. I only caught it in the end-to-end check: the consumer received nothing, and `webhook_deliveries` showed 401s. The fix was to register the raw-body route before the JSON parser. On the plus side, the retry/backoff path worked exactly as intended.
2. **Tests passing alone but failing together.** The fault-injection tests tripped circuit breakers, and the open breakers leaked into later tests ("unknown customer" came back 503 instead of 404). I ran the failing cases in isolation, saw they were fine, and added a breaker reset in `beforeEach`.
3. **403 audit rows had no resource id.** The audit middleware read `req.params` in the `finish` handler, but Express has reset the params by then. I caught it by looking at the audit table after a smoke run, and now the id is captured at the start of each route.
4. **MCP read tools weren't forwarding the correlation id**, so joining the MCP audit log to the API audit log only worked for writes. I found it in review, and there's now a test that does the join.
5. **Stored idempotent error responses** were replayed as `application/json` instead of problem+json. Rather than patch it, I simplified the design: errors release the key, and only successes are stored.
6. **Small things.** `node --test tests/unit/` with a directory doesn't work on Node 24 (it needs a glob), and the fixture time-shift produced millisecond timestamps.

## How I checked the output

- I ran everything, not just read it: curl against every endpoint, fault injection (down / slow / flaky / garbage), then checking the SQLite tables.
- `make test`: 81 tests (unit, contract tests validating every response against the spec, and MCP tests with a real MCP client against the real server and API).
- Postman/newman: 28 requests, 44 assertions, run twice back to back to make sure it's repeatable.
- The spec is linted against the OpenAPI 3.1 schema.
- `make demo-offline` drives the MCP server over real stdio. The output is in `mcp/transcripts/`.
- I checked library APIs against the installed packages rather than trusting memory: the MCP SDK's `registerTool` / `elicitInput`, and whether the Anthropic SDK version supports `fallbacks` and `output_config`.
- I read every file. Generated code looks plausible, and bugs 3 and 4 above both "looked fine".

## Where I didn't trust it

- **Security claims.** Everything in SECURITY.md points to code or a test, or is listed as a known gap.
- **The injection filter.** It's a regex heuristic and I say so. The real protection is the action layer (human approval, no bulk tools, rate limits), and that's what the evals check.
- **Eval numbers.** The LLM evals are only reported from a real `make evals` run. Nothing in TESTEVALS.md is estimated.
