import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createUpstream, UpstreamError, UpstreamClientError } from '../../src/upstream/httpClient.js';

let script = [];
let hits = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  const step = script.shift() ?? { status: 200 };
  setTimeout(() => {
    res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers ?? {}) });
    res.end(step.body ?? '{"ok":true}');
  }, step.delay ?? 0);
});
server.listen(0);
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const client = (opts = {}) => createUpstream('cases', { baseUrl, timeoutMs: 150, retries: 2, ...opts }, { breaker: { failureThreshold: 10 }, baseDelayMs: 5 });
const reset = (s) => { script = s; hits = 0; };

test('retries GET on 503 and succeeds', async () => {
  reset([{ status: 503 }, { status: 503 }, { status: 200 }]);
  const res = await client().request('GET', '/x');
  assert.equal(res.status, 200);
  assert.equal(hits, 3);
});

test('does not retry a POST unless told it is idempotent', async () => {
  reset([{ status: 503 }, { status: 200 }]);
  await assert.rejects(client().request('POST', '/x', { body: {} }), (e) => e instanceof UpstreamError && e.reason === 'unavailable');
  assert.equal(hits, 1);
});

test('times out slow responses and reports reason=timeout', async () => {
  reset([{ status: 200, delay: 400 }, { status: 200, delay: 400 }, { status: 200, delay: 400 }]);
  await assert.rejects(client().request('GET', '/slow'), (e) => e.reason === 'timeout');
});

test('4xx is not retried and surfaces as UpstreamClientError', async () => {
  reset([{ status: 404, body: '{"errorCode":"NOT_FOUND"}' }]);
  await assert.rejects(client().request('GET', '/missing'), (e) => e instanceof UpstreamClientError && e.status === 404);
  assert.equal(hits, 1);
});

test('unparseable JSON is a bad_response, not a crash', async () => {
  reset([{ status: 200, body: '{"half": ' }]);
  await assert.rejects(client().request('GET', '/x'), (e) => e.reason === 'bad_response');
});

test('breaker opens and then fails fast without calling upstream', async () => {
  const c = createUpstream('usage', { baseUrl, timeoutMs: 150, retries: 0 }, { breaker: { failureThreshold: 2, cooldownMs: 60000 } });
  reset([{ status: 500 }, { status: 500 }]);
  await assert.rejects(c.request('GET', '/a'));
  await assert.rejects(c.request('GET', '/a'));
  const before = hits;
  await assert.rejects(c.request('GET', '/a'), (e) => e.reason === 'circuit_open' && e.retryAfterSeconds > 0);
  assert.equal(hits, before);
});
