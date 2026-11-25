import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db.js';
import { createIdempotencyStore } from '../../src/services/idempotency.js';

const req = { method: 'POST', path: '/cases/CS-1/comments', requestHash: 'h1' };

test('first call proceeds, completed call replays, different body is rejected', () => {
  const store = createIdempotencyStore(openDb(':memory:'));
  assert.equal(store.begin('alice', 'k1', req), null);
  assert.throws(() => store.begin('alice', 'k1', req), (e) => e.kind === 'idempotencyInProgress');
  store.complete('alice', 'k1', 201, { id: 'CM-1' }, { Location: '/x' });
  assert.deepEqual(store.begin('alice', 'k1', req), { status: 201, body: { id: 'CM-1' }, headers: { Location: '/x' } });
  assert.throws(() => store.begin('alice', 'k1', { ...req, requestHash: 'h2' }), (e) => e.kind === 'idempotencyMismatch');
});

test('keys are scoped per principal', () => {
  const store = createIdempotencyStore(openDb(':memory:'));
  assert.equal(store.begin('alice', 'k1', req), null);
  assert.equal(store.begin('bob', 'k1', req), null);
});

test('released keys can be retried; expired keys are reusable', () => {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const store = createIdempotencyStore(openDb(':memory:'), { ttlHours: 1, now: () => t });
  store.begin('alice', 'k1', req);
  store.release('alice', 'k1');
  assert.equal(store.begin('alice', 'k1', req), null);
  store.complete('alice', 'k1', 201, {}, {});
  t += 2 * 3600_000;
  assert.equal(store.begin('alice', 'k1', { ...req, requestHash: 'other' }), null);
});
