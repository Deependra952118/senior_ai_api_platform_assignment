import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHarness, ANCHOR } from '../helpers.js';
import { createPlatformMcpServer, decodeIdentity } from '../../mcp/server.js';
import { createApiClient } from '../../mcp/apiClient.js';
import { createAuditSink, createToolRateLimiter, DEFAULT_LIMITS } from '../../mcp/guardrails.js';

let h;
let apiServer;
let baseUrl;
before(async () => {
  h = await startHarness();
  apiServer = h.app.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
});
after(async () => { apiServer.close(); await h.close(); });
beforeEach(async () => {
  await fetch(`${h.base}/__reset`, { method: 'POST' });
  h.services.entitlements._reset();
});

// Connects an MCP client to a fresh server for the given token.
// `elicit` = undefined -> client has no elicitation capability (preview mode).
async function connect(token, { elicit, limits, approvalMode = 'elicit' } = {}) {
  const audit = createAuditSink(null);
  const server = createPlatformMcpServer({
    api: createApiClient({ baseUrl, token }),
    identity: decodeIdentity(token),
    approvalMode,
    audit,
    limiter: createToolRateLimiter(limits ?? DEFAULT_LIMITS),
    now: () => ANCHOR,
  });
  const client = new Client({ name: 'test-host', version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  const prompts = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return elicit === 'approve' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, json: JSON.parse(r.content[0].text), raw: r.content[0].text };
  };
  return { client, call, audit, prompts };
}

describe('tool surface', () => {
  test('lists tools with tight schemas; escalate hidden from users without the scope', async () => {
    const lead = await connect(h.tokens.copilot);
    const names = (await lead.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add_case_comment', 'escalate_case', 'get_case', 'get_customer_summary', 'search_cases']);
    const { tools } = await lead.client.listTools();
    const esc = tools.find((t) => t.name === 'escalate_case');
    assert.deepEqual(esc.inputSchema.properties.reason.enum, ['customer_impact', 'sla_breach_risk', 'renewal_risk', 'executive_request', 'security_incident']);
    assert.equal(esc.annotations.destructiveHint, true);

    const agent = await connect(h.tokens['copilot-limited']);
    assert.ok(!(await agent.client.listTools()).tools.some((t) => t.name === 'escalate_case'));
  });
});

describe('reads', () => {
  test('search_cases answers the sample question in one compact call', async () => {
    const { call } = await connect(h.tokens.copilot);
    const r = await call('search_cases', { priority: ['P1'], support_tier: ['Platinum'], min_age_hours: 48, renewal_within_days: 90 });
    assert.deepEqual(r.json.cases.map((c) => c.id).sort(), ['CS-10231', 'CS-10232', 'CS-10233']);
    assert.ok(r.raw.length < 1500, `response is ${r.raw.length} chars`);
    assert.ok(!r.raw.includes('arr'), 'no financial fields leak into case rows');
  });

  test('get_case hides comments that try to instruct the assistant', async () => {
    const { call } = await connect(h.tokens.copilot);
    const r = await call('get_case', { case_id: 'CS-10240' });
    assert.doesNotMatch(r.raw, /ignore previous instructions/i);
    assert.match(r.json.warning, /hidden/);
    assert.match(r.json.comments[0].text, /^\[hidden/);
  });

  test('get_case redacts emails and phone numbers in comments', async () => {
    const { call } = await connect(h.tokens.copilot);
    const r = await call('get_case', { case_id: 'CS-10232' });
    assert.doesNotMatch(r.raw, /acme\.example|555/);
    assert.match(r.json.comments[0].text, /\[email\].*\[phone\]/);
  });

  test('get_customer_summary withholds ARR without finance scope', async () => {
    const { call } = await connect(h.tokens.copilot);
    const r = await call('get_customer_summary', { account_id: 'ACC-007' });
    assert.equal(r.json.arr_usd, undefined);
    assert.deepEqual(r.json.withheld, ['arr_usd']);
    assert.equal(r.json.days_to_renewal, 51);
  });

  test('degraded upstream is reported, not hidden', async () => {
    await h.fault('usage', 'down');
    const { call } = await connect(h.tokens.copilot);
    const r = await call('get_customer_summary', { account_id: 'ACC-001' });
    assert.deepEqual(r.json.degraded, ['usage']);
    assert.equal(r.json.usage, null);
    await h.fault('usage', 'ok');
    h.services.http.usage.breaker.success();
  });

  test('output is capped even for broad searches', async () => {
    const { call } = await connect(h.tokens.copilot);
    const r = await call('search_cases', { status: ['open', 'pending', 'escalated', 'resolved', 'closed'], limit: 25 });
    assert.ok(r.raw.length <= 6000);
  });

  test('invalid arguments are rejected by the schema before reaching the API', async () => {
    const { client } = await connect(h.tokens.copilot);
    const r = await client.callTool({ name: 'search_cases', arguments: { priority: ['urgent'] } });
    assert.equal(r.isError, true);
  });

  test('API authorization errors come back as actionable tool errors', async () => {
    const token = await h.mintToken({ sub: 'carol', scopes: 'customers:read', client: 'support-copilot', agent: 'support-copilot' });
    const { call } = await connect(token);
    const r = await call('search_cases', { priority: ['P1'] });
    assert.equal(r.isError, true);
    assert.equal(r.json.error, 'forbidden');
    assert.match(r.json.hint, /permission/);
  });
});

describe('writes need a human', () => {
  test('elicitation approve -> comment posted as the user via the agent', async () => {
    const s = await connect(h.tokens.copilot, { elicit: 'approve' });
    const r = await s.call('add_case_comment', { case_id: 'CS-10231', body: 'Upgrade to 7.4 scheduled for tonight.' });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.author, 'sam');
    assert.equal(s.prompts.length, 1);
    assert.match(s.prompts[0], /CS-10231/);
  });

  test('elicitation decline -> nothing written', async () => {
    const s = await connect(h.tokens.copilot, { elicit: 'decline' });
    const r = await s.call('escalate_case', { case_id: 'CS-10231', reason: 'renewal_risk' });
    assert.equal(r.json.error, 'declined_by_user');
    const c = await s.call('get_case', { case_id: 'CS-10231' });
    assert.equal(c.json.status, 'open');
  });

  test('preview mode: token is single-use and bound to the exact arguments', async () => {
    const s = await connect(h.tokens.copilot); // no elicitation support
    const first = await s.call('add_case_comment', { case_id: 'CS-10231', body: 'hello' });
    assert.equal(first.json.status, 'confirmation_required');
    const id = first.json.confirmation_id;

    const swapped = await s.call('add_case_comment', { case_id: 'CS-10231', body: 'something else', confirmation_id: id });
    assert.equal(swapped.json.error, 'confirmation_mismatch');

    const again = await s.call('add_case_comment', { case_id: 'CS-10231', body: 'hello' });
    const ok = await s.call('add_case_comment', { case_id: 'CS-10231', body: 'hello', confirmation_id: again.json.confirmation_id });
    assert.equal(ok.json.ok, true);
    const reuse = await s.call('add_case_comment', { case_id: 'CS-10231', body: 'hello', confirmation_id: again.json.confirmation_id });
    assert.equal(reuse.json.error, 'confirmation_unknown');
  });

  test('escalating a non-escalatable case is refused before asking the human', async () => {
    const s = await connect(h.tokens.copilot, { elicit: 'approve' });
    const r = await s.call('escalate_case', { case_id: 'CS-10242', reason: 'customer_impact' });
    assert.equal(r.json.error, 'not_escalatable');
    assert.equal(s.prompts.length, 0);
  });

  test('approved escalation goes through with ETag and publishes the event', async () => {
    const s = await connect(h.tokens.copilot, { elicit: 'approve' });
    const r = await s.call('escalate_case', { case_id: 'CS-10233', reason: 'renewal_risk', note: 'Replication lag, renewal in 68 days' });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.status, 'escalated');
    const evt = h.db.prepare("SELECT payload FROM events WHERE aggregate_id = 'CS-10233'").get();
    assert.equal(JSON.parse(evt.payload).data.via.agent, 'support-copilot');
  });

  test('read-only deployment refuses all writes', async () => {
    const s = await connect(h.tokens.copilot, { elicit: 'approve', approvalMode: 'deny' });
    const r = await s.call('add_case_comment', { case_id: 'CS-10231', body: 'x' });
    assert.equal(r.json.error, 'writes_disabled');
    assert.equal(s.prompts.length, 0);
  });
});

describe('rate limits and audit', () => {
  test('escalations are rate limited per agent', async () => {
    const s = await connect(h.tokens.copilot, { elicit: 'decline', limits: { ...DEFAULT_LIMITS, escalate: { capacity: 2, perSeconds: 600 } } });
    const out = [];
    for (let i = 0; i < 3; i++) out.push((await s.call('escalate_case', { case_id: 'CS-10231', reason: 'customer_impact' })).json.error);
    assert.deepEqual(out, ['declined_by_user', 'declined_by_user', 'rate_limited']);
  });

  test('every tool call is audited with user, agent and correlation id; comment text is not logged', async () => {
    const s = await connect(h.tokens.copilot, { elicit: 'approve' });
    await s.call('search_cases', { priority: ['P1'] });
    await s.call('add_case_comment', { case_id: 'CS-10231', body: 'secret-ish text' });
    assert.equal(s.audit.entries.length, 2);
    const [search, comment] = s.audit.entries;
    assert.equal(search.user, 'sam');
    assert.equal(search.agent, 'support-copilot');
    assert.equal(comment.outcome, 'ok');
    assert.doesNotMatch(JSON.stringify(comment), /secret-ish/);
    assert.equal(comment.args.body.chars, 15);

    // The same correlation id shows up in the API's audit log, so the two can be joined.
    const apiRow = h.db.prepare("SELECT * FROM audit_log WHERE correlation_id = ? AND action = 'addCaseComment'").get(comment.correlation_id);
    assert.equal(apiRow.agent_id, 'support-copilot');
    assert.equal(apiRow.actor_sub, 'sam');
  });
});
