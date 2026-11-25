import { once } from 'node:events';
import pino from 'pino';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp, seedDevSubscription } from '../src/app.js';
import { createMockUpstreams } from '../src/mocks/upstreamServer.js';
import { mintToken, PERSONAS } from '../scripts/token.js';
import { loadSpec, compile, resolveRef } from '../src/spec.js';

// Fixtures are authored relative to this instant; tests pin the clock to it.
export const ANCHOR = Date.parse('2026-11-25T12:00:00Z');

export async function startHarness({ now = () => ANCHOR, configOverrides = {} } = {}) {
  const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
  const secret = 'whsec_dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2tzLTEyMw==';
  const mocks = createMockUpstreams({ timeShift: false, now, webhookSecret: secret, logger });
  const server = mocks.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const config = loadConfig({
    upstreams: {
      cases: { baseUrl: `${base}/crm`, timeoutMs: 400, retries: 1 },
      entitlements: { baseUrl: `${base}/erp`, timeoutMs: 400, retries: 1 },
      usage: { baseUrl: `${base}/warehouse`, timeoutMs: 400, retries: 1 },
    },
    breaker: { failureThreshold: 4, cooldownMs: 60000 },
    entitlementCacheTtlMs: 0,
    ...configOverrides,
  });
  const db = openDb(':memory:');
  seedDevSubscription(db, { url: `${base}/consumer/webhooks/case-escalated`, secret }, now);
  const { app, services, dispatcher } = createApp({ config, logger, db, now });

  const tokens = {};
  for (const [name, p] of Object.entries(PERSONAS)) tokens[name] = await mintToken(p, config);

  const fault = (target, mode, extra = {}) => fetch(`${base}/__faults`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, mode, ...extra }),
  });

  return {
    app, services, dispatcher, db, mocks, config, tokens, base, fault,
    api: () => request(app),
    mintToken: (claims) => mintToken(claims, config),
    async close() {
      server.closeAllConnections?.();
      server.close();
      db.close();
    },
  };
}

// Checks a supertest response against openapi.yaml: the status must be documented
// for the operation, the content type must match, and the body must satisfy the schema.
export function assertContract(res, operationId) {
  const { doc, operations } = loadSpec();
  const entry = operations.get(operationId);
  if (!entry) throw new Error(`unknown operationId ${operationId}`);
  const status = String(res.status);
  const responseDef = entry.op.responses[status] ?? entry.op.responses[`${status[0]}XX`] ?? entry.op.responses.default;
  if (!responseDef) throw new Error(`${operationId}: status ${status} is not documented (body: ${JSON.stringify(res.body).slice(0, 300)})`);
  const resolved = resolveRef(doc, responseDef);
  const content = resolved.content;
  if (!content) {
    if (res.text) throw new Error(`${operationId} ${status}: spec documents no body but got one`);
    return;
  }
  const ct = (res.headers['content-type'] ?? '').split(';')[0];
  const media = content[ct];
  if (!media) throw new Error(`${operationId} ${status}: content-type ${ct} not in spec (${Object.keys(content)})`);
  const validator = compile(`response:${operationId}:${status}:${ct}`, media.schema);
  if (!validator(res.body)) {
    throw new Error(`${operationId} ${status} body does not match spec: ${JSON.stringify(validator.errors, null, 1)}`);
  }
}

export const bearer = (t) => ({ authorization: `Bearer ${t}` });
