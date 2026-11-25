// No-LLM walkthrough: drives the real MCP server over stdio with the tool calls a
// model would make for the sample question, plus the guardrail cases. Useful when
// there is no API key; it is NOT a model transcript.
//   make run   (other terminal)
//   npm run demo:offline
import { mintToken, PERSONAS } from '../scripts/token.js';
import { connectMcp } from './agent.js';

const apiUrl = process.env.PLATFORM_API_URL ?? 'http://localhost:3000';
try { await fetch(`${apiUrl}/health/live`); } catch { console.error(`API not reachable at ${apiUrl}. Start it with: make run`); process.exit(1); }

const show = async (mcp, title, name, args) => {
  console.log(`\n## ${title}\n→ ${name} ${JSON.stringify(args)}`);
  const r = await mcp.client.callTool({ name, arguments: args });
  console.log(`← ${r.isError ? '(isError) ' : ''}${r.content[0].text}`);
};

const lead = await connectMcp({ token: await mintToken({ ...PERSONAS.copilot, ttl: 600 }), apiUrl, approve: 'decline' });
console.log(`tools for sam via support-copilot: ${lead.tools.map((t) => t.name).join(', ')}`);

await show(lead, '1. Sample question', 'search_cases', { priority: ['P1'], support_tier: ['Platinum'], min_age_hours: 48, renewal_within_days: 90 });
await show(lead, '2. Drill into one customer (ARR withheld: no finance scope)', 'get_customer_summary', { account_id: 'ACC-002' });
await show(lead, '3. Case with a prompt-injection comment', 'get_case', { case_id: 'CS-10240', max_comments: 3 });
await show(lead, '4. PII redaction in comments', 'get_case', { case_id: 'CS-10232', max_comments: 1 });
await show(lead, '5. Escalation the human declines', 'escalate_case', { case_id: 'CS-10231', reason: 'renewal_risk', note: 'Backups failing for 4 days, renewal in January' });
await show(lead, '6. Escalating an already-escalated case', 'escalate_case', { case_id: 'CS-10242', reason: 'customer_impact' });
await lead.close();

const limited = await connectMcp({ token: await mintToken({ ...PERSONAS['copilot-limited'], ttl: 600 }), apiUrl, approve: 'decline' });
console.log(`\n## 7. Same agent acting for alice (no cases:escalate)\ntools: ${limited.tools.map((t) => t.name).join(', ')}`);
await limited.close();
console.log('\nEvery call above is in mcp/audit.log and, with the same correlation id, in the API audit_log table.');
