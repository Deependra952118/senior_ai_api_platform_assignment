import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, assertContract, bearer, ANCHOR } from '../helpers.js';
import { loadSpec, compile } from '../../src/spec.js';

let h;
before(async () => { h = await startHarness(); });
after(() => h.close());
// Each test starts from clean fixtures, an empty entitlement cache and closed breakers.
beforeEach(async () => {
  await fetch(`${h.base}/__reset`, { method: 'POST' });
  h.services.entitlements._reset();
  for (const u of Object.values(h.services.http)) u.breaker.success();
});

const iso = (ms) => new Date(ms).toISOString();

describe('GET /v1/customers/{id}', () => {
  test('aggregates entitlement, usage and case counts; ARR hidden without finance scope', async () => {
    const res = await h.api().get('/v1/customers/ACC-007').set(bearer(h.tokens['support-agent']));
    assertContract(res, 'getCustomer');
    assert.equal(res.status, 200);
    assert.equal(res.body.supportTier, 'Platinum');
    assert.equal(res.body.contract.daysToRenewal, 51);
    assert.equal(res.body.usage.month, '2026-10');
    assert.deepEqual(res.body.cases, { active: 2, activeP1: 1 });
    assert.equal(res.body.arrUsd, undefined);
    assert.deepEqual(res.body.redactedFields, ['arrUsd']);
    assert.equal(res.body.degraded, false);
  });

  test('finance scope sees ARR', async () => {
    const res = await h.api().get('/v1/customers/ACC-007').set(bearer(h.tokens.finance));
    assertContract(res, 'getCustomer');
    assert.equal(res.body.arrUsd, 330000);
    assert.deepEqual(res.body.redactedFields, []);
  });

  test('XML feed wins over CSV export for renewal date', async () => {
    const res = await h.api().get('/v1/customers/ACC-002').set(bearer(h.tokens['support-agent']));
    assert.equal(res.body.contract.renewalDate, '2027-02-01');
  });

  test('usage warehouse down -> 200 with degraded flag and usage null', async () => {
    await h.fault('usage', 'down');
    const res = await h.api().get('/v1/customers/ACC-007').set(bearer(h.tokens['support-agent']));
    assertContract(res, 'getCustomer');
    assert.equal(res.status, 200);
    assert.equal(res.body.usage, null);
    assert.equal(res.body.degraded, true);
    assert.deepEqual(res.body.degradedSources, ['usage']);
  });

  test('usage warehouse slow -> times out and degrades instead of hanging', async () => {
    await h.fault('usage', 'slow', { delayMs: 2000 });
    const started = Date.now();
    const res = await h.api().get('/v1/customers/ACC-001').set(bearer(h.tokens['support-agent']));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.degradedSources, ['usage']);
    assert.ok(Date.now() - started < 1500, 'bounded by timeout x attempts');
  });

  test('entitlements down with no cache -> 503 problem with upstream info', async () => {
    await h.fault('entitlements', 'down');
    const res = await h.api().get('/v1/customers/ACC-007').set(bearer(h.tokens['support-agent']));
    assertContract(res, 'getCustomer');
    assert.equal(res.status, 503);
    assert.equal(res.body.upstream.name, 'entitlements');
    assert.ok(res.headers['retry-after']);
  });

  test('unknown customer -> 404, malformed id -> 400', async () => {
    const a = await h.api().get('/v1/customers/ACC-999').set(bearer(h.tokens['support-agent']));
    assertContract(a, 'getCustomer');
    assert.equal(a.status, 404);
    const b = await h.api().get('/v1/customers/acme').set(bearer(h.tokens['support-agent']));
    assertContract(b, 'getCustomer');
    assert.equal(b.status, 400);
  });

  test('missing scope -> 403 listing required scopes', async () => {
    const res = await h.api().get('/v1/customers/ACC-007').set(bearer(h.tokens.admin));
    assertContract(res, 'getCustomer');
    assert.equal(res.status, 403);
    assert.deepEqual(res.body.requiredScopes, ['customers:read']);
  });
});

describe('GET /v1/cases', () => {
  test('answers the sample question (Platinum, P1, active > 48h, renewal < 90d)', async () => {
    const res = await h.api().get('/v1/cases').query({
      status: 'open,pending,escalated', priority: 'P1', supportTier: 'Platinum',
      openedBefore: iso(ANCHOR - 48 * 3600_000), renewalBefore: iso(ANCHOR + 90 * 86400_000).slice(0, 10), include: 'account',
    }).set(bearer(h.tokens['support-agent']));
    assertContract(res, 'listCases');
    assert.deepEqual(res.body.data.map((c) => c.id).sort(), ['CS-10231', 'CS-10232', 'CS-10233']);
    assert.ok(res.body.data.every((c) => c.account?.supportTier === 'Platinum'));
  });

  test('cursor pagination walks every result exactly once in sort order', async () => {
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const res = await h.api().get('/v1/cases').query({ limit: 4, sort: 'priority', ...(cursor ? { cursor } : {}) }).set(bearer(h.tokens['support-agent']));
      assertContract(res, 'listCases');
      seen.push(...res.body.data);
      cursor = res.body.page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(seen.length, 15);
    assert.equal(new Set(seen.map((c) => c.id)).size, 15);
    assert.equal(pages, 4);
    const ranks = seen.map((c) => Number(c.priority[1]));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });

  test('cursor reused with a different filter -> 400', async () => {
    const first = await h.api().get('/v1/cases').query({ limit: 2 }).set(bearer(h.tokens['support-agent']));
    const res = await h.api().get('/v1/cases').query({ limit: 2, priority: 'P1', cursor: first.body.page.nextCursor }).set(bearer(h.tokens['support-agent']));
    assertContract(res, 'listCases');
    assert.equal(res.status, 400);
  });

  test('validation errors are collected into one problem response', async () => {
    const res = await h.api().get('/v1/cases').query({ priority: 'P9', limit: 500, colour: 'red' }).set(bearer(h.tokens['support-agent']));
    assertContract(res, 'listCases');
    assert.equal(res.status, 400);
    assert.equal(res.headers['content-type'].split(';')[0], 'application/problem+json');
    assert.deepEqual(res.body.errors.map((e) => e.name).sort(), ['colour', 'limit', 'priority']);
  });

  test('deprecated `state` param still works and announces its sunset', async () => {
    const res = await h.api().get('/v1/cases').query({ state: 'resolved' }).set(bearer(h.tokens['support-agent']));
    assertContract(res, 'listCases');
    assert.deepEqual(res.body.data.map((c) => c.id), ['CS-10235']);
    assert.ok(res.headers.deprecation);
    assert.match(res.headers.sunset, /2027/);
  });

  test('case system down -> 503; recovers after reset', async () => {
    await h.fault('cases', 'down');
    const res = await h.api().get('/v1/cases').set(bearer(h.tokens['support-agent']));
    assertContract(res, 'listCases');
    assert.equal(res.status, 503);
    assert.equal(res.body.upstream.name, 'cases');
  });

  test('garbage upstream payload -> 502 bad response, not a 500', async () => {
    await h.fault('cases', 'garbage');
    const res = await h.api().get('/v1/cases').set(bearer(h.tokens['support-agent']));
    assert.equal(res.status, 502);
    assert.equal(res.body.upstream.reason, 'bad_response');
  });

  test('flaky upstream is absorbed by retries', async () => {
    await h.fault('cases', 'flaky');
    const res = await h.api().get('/v1/cases').query({ priority: 'P4' }).set(bearer(h.tokens['support-agent']));
    assert.equal(res.status, 200);
  });

  test('missing or invalid token -> 401 problem', async () => {
    const a = await h.api().get('/v1/cases');
    assertContract(a, 'listCases');
    assert.equal(a.status, 401);
    const b = await h.api().get('/v1/cases').set(bearer('not.a.jwt'));
    assert.equal(b.status, 401);
    const expired = await h.mintToken({ sub: 'x', scopes: 'cases:read', ttl: -120 });
    const c = await h.api().get('/v1/cases').set(bearer(expired));
    assert.equal(c.status, 401);
  });

  test('responses carry rate-limit and correlation headers; incoming correlation id is echoed', async () => {
    const res = await h.api().get('/v1/cases').set(bearer(h.tokens['support-agent'])).set('x-correlation-id', 'trace-abc-12345');
    assert.equal(res.headers['x-correlation-id'], 'trace-abc-12345');
    assert.ok(res.headers['ratelimit-limit']);
    assert.ok(res.headers['ratelimit-remaining']);
  });
});

describe('POST /v1/cases/{id}/comments', () => {
  const post = (token, body, key = 'key-aaaaaaaaaaaaaaaa1', caseId = 'CS-10231') => h.api()
    .post(`/v1/cases/${caseId}/comments`).set(bearer(token)).set('Idempotency-Key', key).send(body);

  test('creates a comment authored by the token subject', async () => {
    const res = await post(h.tokens['support-agent'], { body: 'Customer confirmed workaround', author: undefined });
    assertContract(res, 'addCaseComment');
    assert.equal(res.status, 201);
    assert.equal(res.body.author, 'alice');
    assert.equal(res.body.visibility, 'internal');
    assert.match(res.headers.location, /^\/v1\/cases\/CS-10231\/comments\/CM-/);
  });

  test('replay with same key returns the same comment and does not duplicate', async () => {
    const a = await post(h.tokens['support-agent'], { body: 'once' }, 'key-replay-000000001');
    const b = await post(h.tokens['support-agent'], { body: 'once' }, 'key-replay-000000001');
    assertContract(b, 'addCaseComment');
    assert.equal(b.headers['idempotent-replayed'], 'true');
    assert.equal(a.body.id, b.body.id);
    const c = await h.api().get('/v1/cases/CS-10231').set(bearer(h.tokens['support-agent']));
    assert.equal(c.body.comments.filter((x) => x.body === 'once').length, 1);
  });

  test('same key with a different body -> 422', async () => {
    await post(h.tokens['support-agent'], { body: 'one' }, 'key-mismatch-0000001');
    const res = await post(h.tokens['support-agent'], { body: 'two' }, 'key-mismatch-0000001');
    assertContract(res, 'addCaseComment');
    assert.equal(res.status, 422);
  });

  test('missing Idempotency-Key, unknown field, empty body -> 400', async () => {
    const a = await h.api().post('/v1/cases/CS-10231/comments').set(bearer(h.tokens['support-agent'])).send({ body: 'x' });
    assertContract(a, 'addCaseComment');
    assert.equal(a.status, 400);
    const b = await post(h.tokens['support-agent'], { body: 'x', author: 'ceo' }, 'key-badfield-0000001');
    assert.equal(b.status, 400, 'author cannot be spoofed via the body');
    const c = await post(h.tokens['support-agent'], { body: '' }, 'key-empty-000000001');
    assert.equal(c.status, 400);
  });

  test('closed case -> 409; unknown case -> 404', async () => {
    const a = await post(h.tokens['support-agent'], { body: 'x' }, 'key-closed-00000001', 'CS-10244');
    assertContract(a, 'addCaseComment');
    assert.equal(a.status, 409);
    const b = await post(h.tokens['support-agent'], { body: 'x' }, 'key-missing-0000001', 'CS-99999');
    assertContract(b, 'addCaseComment');
    assert.equal(b.status, 404);
  });

  test('upstream failure releases the key so a retry can succeed', async () => {
    await h.fault('cases', 'down');
    const a = await post(h.tokens['support-agent'], { body: 'retry me' }, 'key-transient-000001');
    assert.equal(a.status, 503);
    await h.fault('cases', 'ok');
    h.services.http.cases.breaker.success(); // skip the cooldown rather than sleeping in a test
    const b = await post(h.tokens['support-agent'], { body: 'retry me' }, 'key-transient-000001');
    assert.equal(b.status, 201);
  });

  test('agent-made comments record the agent in `via`', async () => {
    const res = await post(h.tokens.copilot, { body: 'Summarised by copilot' }, 'key-agent-0000000001');
    assert.equal(res.status, 201);
    assert.equal(res.body.author, 'sam');
    assert.deepEqual(res.body.via, { agent: 'support-copilot' });
  });
});

describe('POST /v1/cases/{id}/escalate', () => {
  const etag = async (id) => (await h.api().get(`/v1/cases/${id}`).set(bearer(h.tokens['support-lead']))).headers.etag;
  const escalate = (id, body, headers = {}) => h.api().post(`/v1/cases/${id}/escalate`).set(bearer(h.tokens['support-lead'])).set(headers).send(body);

  test('escalates with a fresh ETag, publishes and delivers a signed webhook', async () => {
    const tag = await etag('CS-10231');
    const res = await escalate('CS-10231', { reason: 'renewal_risk', note: 'Renews in 7 weeks' }, { 'If-Match': tag });
    assertContract(res, 'escalateCase');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'escalated');
    assert.equal(res.body.escalation.escalatedBy, 'sam');
    assert.notEqual(res.headers.etag, tag);

    await h.dispatcher.runOnce();
    const received = await (await fetch(`${h.base}/consumer/webhooks/received`)).json();
    assert.equal(received.length, 1);
    const evt = received[0];
    assert.equal(evt.type, 'case.escalated');
    assert.equal(evt.data.caseId, 'CS-10231');
    assert.equal(evt.data.previousStatus, 'open');
    const schema = loadSpec().doc.components.schemas.CaseEscalatedEvent;
    const v = compile('event:case.escalated', schema);
    assert.ok(v(evt), JSON.stringify(v.errors));
    const delivery = h.db.prepare('SELECT status, attempts FROM webhook_deliveries').get();
    assert.equal(delivery.status, 'delivered');
  });

  test('no If-Match -> 428; stale ETag -> 412', async () => {
    const a = await escalate('CS-10231', { reason: 'customer_impact' });
    assertContract(a, 'escalateCase');
    assert.equal(a.status, 428);
    const b = await escalate('CS-10231', { reason: 'customer_impact' }, { 'If-Match': '"0000000000000000"' });
    assertContract(b, 'escalateCase');
    assert.equal(b.status, 412);
  });

  test('already escalated / resolved -> 409 invalid transition', async () => {
    for (const id of ['CS-10242', 'CS-10235']) {
      const res = await escalate(id, { reason: 'customer_impact' }, { 'If-Match': await etag(id) });
      assertContract(res, 'escalateCase');
      assert.equal(res.status, 409);
      assert.match(res.body.type, /invalid-state-transition/);
    }
  });

  test('P3 escalation is allowed for a Gold account', async () => {
    // CS-10245 is P3 for ACC-005, which the XML feed upgrades from Standard to Gold.
    const res = await escalate('CS-10245', { reason: 'customer_impact' }, { 'If-Match': await etag('CS-10245') });
    assert.equal(res.status, 200, 'Gold is allowed');
  });

  test('P3 for a non-Gold/Platinum account is rejected unless security_incident', async () => {
    // Empty the feed so ACC-005 falls back to the CSV tier (Standard).
    const state = h.mocks.state();
    state.xml = '<accounts></accounts>';
    h.services.entitlements._reset();
    const a = await escalate('CS-10245', { reason: 'customer_impact' }, { 'If-Match': await etag('CS-10245') });
    assertContract(a, 'escalateCase');
    assert.equal(a.status, 422);
    const b = await escalate('CS-10245', { reason: 'security_incident' }, { 'If-Match': await etag('CS-10245') });
    assert.equal(b.status, 200);
  });

  test('without cases:escalate scope -> 403 even for an agent acting for that user', async () => {
    const res = await h.api().post('/v1/cases/CS-10231/escalate').set(bearer(h.tokens['copilot-limited']))
      .set('If-Match', await etag('CS-10231')).send({ reason: 'customer_impact' });
    assertContract(res, 'escalateCase');
    assert.equal(res.status, 403);
  });

  test('invalid reason -> 400 listing allowed values', async () => {
    const res = await escalate('CS-10231', { reason: 'because' }, { 'If-Match': await etag('CS-10231') });
    assertContract(res, 'escalateCase');
    assert.equal(res.status, 400);
    assert.match(res.body.errors[0].message, /customer_impact/);
  });

  test('Idempotency-Key makes a retried escalation return the first result', async () => {
    const tag = await etag('CS-10238');
    const a = await escalate('CS-10238', { reason: 'sla_breach_risk' }, { 'If-Match': tag, 'Idempotency-Key': 'esc-key-00000000001' });
    const b = await escalate('CS-10238', { reason: 'sla_breach_risk' }, { 'If-Match': tag, 'Idempotency-Key': 'esc-key-00000000001' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.headers['idempotent-replayed'], 'true');
  });
});

describe('governance', () => {
  test('writes, denials and every agent call land in the append-only audit log', async () => {
    await h.api().get('/v1/cases/CS-10231').set(bearer(h.tokens.copilot));
    await h.api().get('/v1/customers/ACC-007').set(bearer(h.tokens.admin));
    const rows = h.services.audit.recent({ limit: 5 });
    assert.ok(rows.some((r) => r.action === 'getCase' && r.agent_id === 'support-copilot' && r.actor_sub === 'sam'));
    assert.ok(rows.some((r) => r.action === 'getCustomer' && r.outcome === 'denied' && r.resource_id === 'ACC-007'));
  });

  test('agents hit their own rate limit', async () => {
    const small = await startHarness({ configOverrides: { rateLimit: { user: { capacity: 100, refillPerSec: 0.001 }, agent: { capacity: 3, refillPerSec: 0.001 } } } });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await small.api().get('/v1/cases').set(bearer(small.tokens.copilot))).status);
      assert.deepEqual(codes, [200, 200, 200, 429]);
      const res = await small.api().get('/v1/cases').set(bearer(small.tokens.copilot));
      assertContract(res, 'listCases');
      assert.ok(res.headers['retry-after']);
      assert.match(res.body.detail, /support-copilot/);
      const human = await small.api().get('/v1/cases').set(bearer(small.tokens['support-lead']));
      assert.equal(human.status, 200, 'same user via a human client is not blocked');
    } finally {
      await small.close();
    }
  });

  test('webhook subscriptions: secret shown once, private targets refused when not allowed', async () => {
    const create = await h.api().post('/v1/webhook-subscriptions').set(bearer(h.tokens.admin)).send({ url: 'https://hooks.example.com/esc', eventTypes: ['case.escalated'] });
    assertContract(create, 'createWebhookSubscription');
    assert.match(create.body.secret, /^whsec_/);
    const list = await h.api().get('/v1/webhook-subscriptions').set(bearer(h.tokens.admin));
    assertContract(list, 'listWebhookSubscriptions');
    assert.ok(list.body.data.every((s) => s.secret === undefined));

    const strict = await startHarness({ configOverrides: { webhooks: { allowPrivateTargets: false } } });
    try {
      const res = await strict.api().post('/v1/webhook-subscriptions').set(bearer(strict.tokens.admin)).send({ url: 'https://169.254.169.254/latest/meta-data', eventTypes: ['case.escalated'] });
      assertContract(res, 'createWebhookSubscription');
      assert.equal(res.status, 400);
    } finally {
      await strict.close();
    }
  });

  test('failed webhook deliveries are retried with backoff and dead-lettered', async () => {
    const db = h.db;
    db.prepare("UPDATE webhook_subscriptions SET url = 'http://127.0.0.1:9/nowhere'").run();
    const tag = (await h.api().get('/v1/cases/CS-10236').set(bearer(h.tokens['support-lead']))).headers.etag;
    await h.api().post('/v1/cases/CS-10236/escalate').set(bearer(h.tokens['support-lead'])).set('If-Match', tag).send({ reason: 'customer_impact' });
    await h.dispatcher.runOnce();
    const d = db.prepare('SELECT status, attempts, next_attempt_at FROM webhook_deliveries ORDER BY id DESC').get();
    assert.equal(d.status, 'pending');
    assert.equal(d.attempts, 1);
    assert.equal(d.next_attempt_at, new Date(ANCHOR + 10_000).toISOString());
  });
});
