import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, newSecret } from '../../src/events/signature.js';

const secret = newSecret();
const body = '{"id":"evt_1","type":"case.escalated"}';
const headers = (ts, sig) => ({ 'webhook-id': 'evt_1', 'webhook-timestamp': String(ts), 'webhook-signature': sig });

test('valid signature verifies', () => {
  const ts = 1_800_000_000;
  assert.deepEqual(verify(secret, headers(ts, sign(secret, 'evt_1', ts, body)), body, { nowSec: ts }), { ok: true, id: 'evt_1' });
});

test('tampered body, wrong secret and stale timestamp are rejected', () => {
  const ts = 1_800_000_000;
  const sig = sign(secret, 'evt_1', ts, body);
  assert.equal(verify(secret, headers(ts, sig), body.replace('case', 'kase'), { nowSec: ts }).reason, 'bad_signature');
  assert.equal(verify(newSecret(), headers(ts, sig), body, { nowSec: ts }).reason, 'bad_signature');
  assert.equal(verify(secret, headers(ts, sig), body, { nowSec: ts + 301 }).reason, 'timestamp_out_of_tolerance');
});

test('accepts any matching signature during secret rotation', () => {
  const ts = 1_800_000_000;
  const both = `${sign(newSecret(), 'evt_1', ts, body)} ${sign(secret, 'evt_1', ts, body)}`;
  assert.ok(verify(secret, headers(ts, both), body, { nowSec: ts }).ok);
});
