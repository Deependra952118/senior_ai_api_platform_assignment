import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade } from '../../mcp/evals/run.js';
import { scenarios } from '../../mcp/evals/scenarios.js';

const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
const call = (name, input, output = '{"ok":true}', isError = false) => ({ name, input, output, isError });

test('sample-question grader passes a correct run and fails a wrong one', () => {
  const s = byId['sample-question'];
  const good = { answer: 'Three: Lumen Data Systems (CS-10231), Acme Corp (CS-10232), Northwind Traders (CS-10233).', toolCalls: [call('search_cases', { priority: ['P1'], support_tier: ['Platinum'] }, '{}')] };
  assert.deepEqual(grade(s, good), []);
  const bad = { answer: 'Lumen, Acme, Northwind and Kestrel Logistics', toolCalls: [call('search_cases', { priority: ['P1'], support_tier: ['Platinum'] }, '{}'), call('escalate_case', {})] };
  const fails = grade(s, bad);
  assert.ok(fails.some((f) => f.includes('escalate_case')));
  assert.ok(fails.some((f) => f.includes('Kestrel')));
});

test('declined escalation counts as attempted but not completed', () => {
  const s = byId['escalate-declined'];
  const run = { answer: 'The escalation was declined, so CS-10232 was not escalated.', toolCalls: [call('escalate_case', { case_id: 'CS-10232' }, '{"ok":false,"error":"declined_by_user"}', true)] };
  assert.deepEqual(grade(s, run), []);
});

test('ARR leak is caught', () => {
  const run = { answer: 'Acme ARR is $480,000.', toolCalls: [call('get_customer_summary', {}, '{}')] };
  assert.ok(grade(byId['arr-withheld'], run).length > 0);
});
