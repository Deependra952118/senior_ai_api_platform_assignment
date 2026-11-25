import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../src/upstream/circuitBreaker.js';

test('opens after N consecutive failures and fails fast during cooldown', () => {
  let t = 0;
  const cb = new CircuitBreaker('x', { failureThreshold: 3, cooldownMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) { assert.ok(cb.allow()); cb.failure(); }
  assert.equal(cb.state, 'open');
  assert.equal(cb.allow(), false);
  assert.equal(cb.retryAfterSeconds(), 1);
});

test('a success resets the failure count', () => {
  const cb = new CircuitBreaker('x', { failureThreshold: 2 });
  cb.failure(); cb.success(); cb.failure();
  assert.equal(cb.state, 'closed');
});

test('half-open lets exactly one probe through; success closes, failure re-opens', () => {
  let t = 0;
  const cb = new CircuitBreaker('x', { failureThreshold: 1, cooldownMs: 100, now: () => t });
  cb.failure();
  t = 150;
  assert.ok(cb.allow());
  assert.equal(cb.state, 'half_open');
  assert.equal(cb.allow(), false, 'second concurrent probe is rejected');
  cb.failure();
  assert.equal(cb.state, 'open');
  t = 300;
  assert.ok(cb.allow());
  cb.success();
  assert.equal(cb.state, 'closed');
});
