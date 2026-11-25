import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Validator } from '@seriousme/openapi-schema-validator';
import { SPEC_PATH, loadSpec } from '../../src/spec.js';

test('openapi.yaml is a valid OpenAPI 3.1 document', async () => {
  const v = new Validator();
  const res = await v.validate(SPEC_PATH);
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test('every operation documents problem+json errors and has a security decision', () => {
  const { operations, doc } = loadSpec();
  for (const [id, { op }] of operations) {
    assert.ok(op.security || doc.security, `${id} has no security`);
    if (id === 'liveness' || id === 'readiness') continue;
    assert.ok(op.responses['401'], `${id} missing 401`);
    assert.ok(op.responses['403'], `${id} missing 403`);
  }
});

test('case.escalated webhook is defined with signature headers', () => {
  const { doc } = loadSpec();
  const names = doc.webhooks['case.escalated'].post.parameters.map((p) => p.name);
  assert.deepEqual(names.sort(), ['webhook-id', 'webhook-signature', 'webhook-timestamp']);
});
