// Generates postman/collection.json. Edit here, then: node scripts/build-postman.js
import { writeFileSync } from 'node:fs';

const problemChecks = (status, slug) => `
pm.test('status ${status}', () => pm.response.to.have.status(${status}));
pm.test('problem+json body', () => {
  pm.expect(pm.response.headers.get('Content-Type')).to.include('application/problem+json');
  const b = pm.response.json();
  pm.expect(b.type).to.include('${slug}');
  pm.expect(b.status).to.eql(${status});
  pm.expect(b.correlationId).to.be.a('string');
});`;

const req = (name, method, url, { token = 'token_support', headers = [], body, test, pre } = {}) => ({
  name,
  event: [
    ...(pre ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre.trim().split('\n') } }] : []),
    ...(test ? [{ listen: 'test', script: { type: 'text/javascript', exec: test.trim().split('\n') } }] : []),
  ],
  request: {
    method,
    header: [
      ...(token ? [{ key: 'Authorization', value: `Bearer {{${token}}}` }] : []),
      ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ...headers.map(([key, value]) => ({ key, value })),
    ],
    url: url.startsWith('{{') ? url : `{{baseUrl}}${url}`,
    ...(body ? { body: { mode: 'raw', raw: JSON.stringify(body, null, 2) } } : {}),
  },
});

const collection = {
  info: {
    name: 'Customer Platform API',
    description: 'Functional and regression checks. Run with `npm run test:postman` (mints fresh tokens into environment.local.json first). Requests run in order: the Setup folder resets the mock upstreams so the run is repeatable.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Setup',
      item: [
        req('Reset mock upstreams', 'POST', '{{mocksUrl}}/__reset', { token: null, test: "pm.test('reset ok', () => pm.response.to.have.status(200));" }),
        req('Readiness', 'GET', '/health/ready', { token: null, test: "pm.test('ready', () => pm.expect(pm.response.json().status).to.be.oneOf(['ok','degraded']));" }),
      ],
    },
    {
      name: 'Functional',
      item: [
        req('Customer (support scope, ARR redacted)', 'GET', '/v1/customers/ACC-007', {
          test: `
pm.test('200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('aggregate shape', () => { pm.expect(b.supportTier).to.eql('Platinum'); pm.expect(b.contract.renewalDate).to.match(/^\\d{4}-\\d{2}-\\d{2}$/); pm.expect(b).to.have.property('usage'); });
pm.test('ARR redacted', () => { pm.expect(b).to.not.have.property('arrUsd'); pm.expect(b.redactedFields).to.include('arrUsd'); });
pm.test('rate limit headers', () => pm.expect(pm.response.headers.has('RateLimit-Remaining')).to.be.true);`,
        }),
        req('Customer (finance scope, ARR visible)', 'GET', '/v1/customers/ACC-007', {
          token: 'token_finance',
          test: "pm.test('ARR present', () => pm.expect(pm.response.json().arrUsd).to.be.a('number'));",
        }),
        req('Cases: sample question', 'GET', '/v1/cases?status=open,pending,escalated&priority=P1&supportTier=Platinum&openedBefore={{openedBefore}}&renewalBefore={{renewalBefore}}&include=account', {
          pre: `
pm.collectionVariables.set('openedBefore', new Date(Date.now() - 48*3600e3).toISOString());
pm.collectionVariables.set('renewalBefore', new Date(Date.now() + 90*864e5).toISOString().slice(0,10));`,
          test: `
pm.test('200', () => pm.response.to.have.status(200));
const ids = pm.response.json().data.map(c => c.id).sort();
pm.test('expected three cases', () => pm.expect(ids).to.eql(['CS-10231','CS-10232','CS-10233']));
pm.test('account embedded', () => pm.response.json().data.forEach(c => pm.expect(c.account.supportTier).to.eql('Platinum')));`,
        }),
        req('Cases: page 1', 'GET', '/v1/cases?limit=5&sort=priority', {
          test: `
const b = pm.response.json();
pm.test('5 items + cursor', () => { pm.expect(b.data.length).to.eql(5); pm.expect(b.page.nextCursor).to.be.a('string'); });
pm.collectionVariables.set('cursor', b.page.nextCursor);
pm.collectionVariables.set('page1Ids', JSON.stringify(b.data.map(c => c.id)));`,
        }),
        req('Cases: page 2 via cursor', 'GET', '/v1/cases?limit=5&sort=priority&cursor={{cursor}}', {
          test: `
const ids = pm.response.json().data.map(c => c.id);
const prev = JSON.parse(pm.collectionVariables.get('page1Ids'));
pm.test('no overlap with page 1', () => ids.forEach(id => pm.expect(prev).to.not.include(id)));`,
        }),
        req('Case: get + ETag', 'GET', '/v1/cases/CS-10231', {
          token: 'token_lead',
          test: `
pm.test('200 with ETag', () => { pm.response.to.have.status(200); pm.expect(pm.response.headers.get('ETag')).to.match(/^"[a-f0-9]+"$/); });
pm.collectionVariables.set('etag', pm.response.headers.get('ETag'));`,
        }),
        req('Comment: create', 'POST', '/v1/cases/CS-10231/comments', {
          pre: "pm.collectionVariables.set('idemKey', 'pm-' + pm.variables.replaceIn('{{$guid}}'));",
          headers: [['Idempotency-Key', '{{idemKey}}']],
          body: { body: 'Agent on node 3 upgraded, monitoring tonight\'s run.' },
          test: `
pm.test('201', () => pm.response.to.have.status(201));
pm.test('author is token subject', () => pm.expect(pm.response.json().author).to.eql('alice'));
pm.test('Location header', () => pm.expect(pm.response.headers.get('Location')).to.include('/v1/cases/CS-10231/comments/'));
pm.collectionVariables.set('commentId', pm.response.json().id);`,
        }),
        req('Comment: replay same key', 'POST', '/v1/cases/CS-10231/comments', {
          headers: [['Idempotency-Key', '{{idemKey}}']],
          body: { body: 'Agent on node 3 upgraded, monitoring tonight\'s run.' },
          test: `
pm.test('replayed, same id', () => {
  pm.response.to.have.status(201);
  pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.eql('true');
  pm.expect(pm.response.json().id).to.eql(pm.collectionVariables.get('commentId'));
});`,
        }),
        req('Case: refresh ETag after comment', 'GET', '/v1/cases/CS-10231', {
          token: 'token_lead',
          test: "pm.collectionVariables.set('etag', pm.response.headers.get('ETag'));",
        }),
        req('Escalate: success', 'POST', '/v1/cases/CS-10231/escalate', {
          token: 'token_lead',
          headers: [['If-Match', '{{etag}}']],
          body: { reason: 'renewal_risk', note: 'Backups failing 4 days, renews in January' },
          test: `
pm.test('200 escalated', () => { pm.response.to.have.status(200); pm.expect(pm.response.json().status).to.eql('escalated'); });
pm.test('new ETag', () => pm.expect(pm.response.headers.get('ETag')).to.not.eql(pm.collectionVariables.get('etag')));`,
        }),
        req('Webhook: consumer received signed event', 'GET', '{{mocksUrl}}/consumer/webhooks/received', {
          token: null,
          pre: 'setTimeout(() => {}, 1500);',
          test: `
const events = pm.response.json();
pm.test('case.escalated delivered', () => pm.expect(events.some(e => e.type === 'case.escalated' && e.data.caseId === 'CS-10231')).to.be.true);`,
        }),
      ],
    },
    {
      name: 'Regression: errors',
      item: [
        req('401 without token', 'GET', '/v1/cases', { token: null, test: problemChecks(401, 'unauthorized') }),
        req('403 escalate without scope', 'POST', '/v1/cases/CS-10232/escalate', {
          headers: [['If-Match', '"x"']], body: { reason: 'customer_impact' },
          test: `${problemChecks(403, 'forbidden')}\npm.test('lists scope', () => pm.expect(pm.response.json().requiredScopes).to.include('cases:escalate'));`,
        }),
        req('400 validation (bad enum, limit, unknown param)', 'GET', '/v1/cases?priority=P9&limit=500&colour=red', {
          test: `${problemChecks(400, 'validation-error')}\npm.test('3 field errors', () => pm.expect(pm.response.json().errors.length).to.eql(3));`,
        }),
        req('404 unknown customer', 'GET', '/v1/customers/ACC-999', { test: problemChecks(404, 'not-found') }),
        req('428 escalate without If-Match', 'POST', '/v1/cases/CS-10232/escalate', { token: 'token_lead', body: { reason: 'customer_impact' }, test: problemChecks(428, 'precondition-required') }),
        req('412 escalate with stale ETag', 'POST', '/v1/cases/CS-10232/escalate', { token: 'token_lead', headers: [['If-Match', '"0000000000000000"']], body: { reason: 'customer_impact' }, test: problemChecks(412, 'precondition-failed') }),
        req('Case: ETag for resolved case', 'GET', '/v1/cases/CS-10235', { token: 'token_lead', test: "pm.collectionVariables.set('etagResolved', pm.response.headers.get('ETag'));" }),
        req('409 escalate resolved case', 'POST', '/v1/cases/CS-10235/escalate', { token: 'token_lead', headers: [['If-Match', '{{etagResolved}}']], body: { reason: 'customer_impact' }, test: problemChecks(409, 'invalid-state-transition') }),
        req('422 idempotency key reused with different body', 'POST', '/v1/cases/CS-10231/comments', {
          headers: [['Idempotency-Key', '{{idemKey}}']], body: { body: 'different text' }, test: problemChecks(422, 'idempotency-key-reused'),
        }),
        req('400 comment cannot set author', 'POST', '/v1/cases/CS-10231/comments', {
          headers: [['Idempotency-Key', 'pm-author-spoof-000001']], body: { body: 'hi', author: 'ceo' }, test: problemChecks(400, 'validation-error'),
        }),
        req('Deprecated `state` param announces sunset', 'GET', '/v1/cases?state=resolved', {
          test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('Deprecation + Sunset headers', () => { pm.expect(pm.response.headers.has('Deprecation')).to.be.true; pm.expect(pm.response.headers.get('Sunset')).to.include('2027'); });`,
        }),
        req('Correlation id echoed', 'GET', '/v1/cases?limit=1', {
          headers: [['X-Correlation-Id', 'postman-trace-0001']],
          test: "pm.test('echoed', () => pm.expect(pm.response.headers.get('X-Correlation-Id')).to.eql('postman-trace-0001'));",
        }),
        req('Usage down: fault on', 'POST', '{{mocksUrl}}/__faults', { token: null, body: { target: 'usage', mode: 'down' } }),
        req('Usage down: customer degraded but 200', 'GET', '/v1/customers/ACC-001', {
          test: `
pm.test('200 degraded', () => { pm.response.to.have.status(200); const b = pm.response.json(); pm.expect(b.degraded).to.be.true; pm.expect(b.degradedSources).to.include('usage'); pm.expect(b.usage).to.be.null; });`,
        }),
        req('Usage down: fault off', 'POST', '{{mocksUrl}}/__faults', { token: null, body: { target: 'usage', mode: 'ok' } }),
      ],
    },
  ],
  variable: [],
};

writeFileSync('postman/collection.json', `${JSON.stringify(collection, null, 2)}\n`);
const env = (tokens) => ({
  name: 'Customer Platform - local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:3000', enabled: true },
    { key: 'mocksUrl', value: 'http://localhost:4010', enabled: true },
    ...['token_support', 'token_lead', 'token_finance'].map((k) => ({ key: k, value: tokens?.[k] ?? `run: npm run -s token -- ${{ token_support: 'support-agent', token_lead: 'support-lead', token_finance: 'finance' }[k]}`, type: 'secret', enabled: true })),
  ],
});
writeFileSync('postman/environment.json', `${JSON.stringify(env(), null, 2)}\n`);
export { env };
console.log('wrote postman/collection.json and postman/environment.json');
