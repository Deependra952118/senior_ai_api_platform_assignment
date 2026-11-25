import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExport, applyFeed, createEntitlements } from '../../src/upstream/entitlements.js';

const CSV = `account_id,name,support_tier,contract_end,arr_usd
ACC-001,Acme Corp,Platinum,2027-01-15,480000
ACC-002,Northwind,Platinum,2027-06-30,920000
ACC-003,Broken,Diamond,2027-01-01,1
ACC-004,Bad Date,Gold,soon,5`;
const XML = `<accounts><account id="ACC-002"><tier>Platinum</tier><renewal>2027-02-01</renewal></account>
<account id="ACC-999"><tier>Gold</tier><renewal>2027-01-01</renewal></account></accounts>`;

test('CSV export parses and skips malformed rows', () => {
  const m = parseExport(CSV);
  assert.deepEqual([...m.keys()], ['ACC-001', 'ACC-002']);
  assert.equal(m.get('ACC-001').arrUsd, 480000);
});

test('XML feed overrides renewal/tier and ignores unknown accounts', () => {
  const m = applyFeed(parseExport(CSV), XML);
  assert.equal(m.get('ACC-002').renewalDate, '2027-02-01');
  assert.equal(m.has('ACC-999'), false);
});

test('serves stale cache when refresh fails, throws when there is no cache', async () => {
  let t = 0;
  let down = false;
  const http = {
    async request(_m, path) {
      if (down) throw new Error('boom');
      return { body: path.endsWith('.csv') ? CSV : XML };
    },
  };
  const ents = createEntitlements(http, { ttlMs: 10, now: () => t });
  assert.equal((await ents.get('ACC-001')).stale, false);
  down = true;
  t = 100;
  const stale = await ents.get('ACC-001');
  assert.equal(stale.stale, true);
  assert.equal(stale.account.name, 'Acme Corp');
  ents._reset();
  await assert.rejects(ents.get('ACC-001'));
});
