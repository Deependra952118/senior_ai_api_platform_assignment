// Asks Claude the sample question through the MCP server and saves a transcript.
//
//   make run            (other terminal)
//   export ANTHROPIC_API_KEY=...
//   npm run demo
//   npm run demo -- "Escalate CS-10231 as a renewal risk"        # approval prompt in the terminal
//   npm run demo -- --persona copilot-limited "Escalate CS-10231"
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { mintToken, PERSONAS } from '../scripts/token.js';
import { connectMcp, runAgent, MODEL } from './agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = 'Which Platinum customers have P1 cases open for more than 48 hours and a renewal in the next 90 days?';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const persona = flag('persona') ?? 'copilot';
const approve = flag('approve') ?? 'ask';
const question = argv.join(' ').trim() || SAMPLE;
const apiUrl = process.env.PLATFORM_API_URL ?? 'http://localhost:3000';

try {
  await fetch(`${apiUrl}/health/live`);
} catch {
  console.error(`API not reachable at ${apiUrl}. Start it first with: make run`);
  process.exit(1);
}

const token = await mintToken({ ...PERSONAS[persona], ttl: 900 });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askHuman = async (msg) => /^y(es)?$/i.test((await rl.question(`\n--- APPROVAL NEEDED ---\n${msg}\n[y/N] > `)).trim());

const mcp = await connectMcp({ token, apiUrl, approve, askHuman });
const log = [`# Support Copilot transcript`, '', `- date: ${new Date().toISOString()}`, `- model: ${MODEL}`, `- persona: ${persona} (user=${PERSONAS[persona].sub}, agent=${PERSONAS[persona].agent})`, `- tools: ${mcp.tools.map((t) => t.name).join(', ')}`, '', `**User:** ${question}`, ''];

console.log(`\nUser: ${question}\n`);
const result = await runAgent({
  question,
  mcp,
  onEvent(e) {
    if (e.type === 'tool_call') {
      console.log(`→ ${e.name} ${JSON.stringify(e.input)}`);
      log.push(`**Tool call:** \`${e.name}\` \`${JSON.stringify(e.input)}\``, '');
    } else if (e.type === 'tool_result') {
      const short = e.output.length > 800 ? `${e.output.slice(0, 800)}…` : e.output;
      console.log(`← ${e.isError ? '(error) ' : ''}${short}\n`);
      log.push('```json', short, '```', '');
    }
  },
});
console.log(`Copilot: ${result.answer}\n`);
console.log(`(${result.toolCalls.length} tool calls, ${result.usage.input} input / ${result.usage.output} output tokens)`);
log.push(`**Copilot:** ${result.answer}`, '', `_${result.toolCalls.length} tool calls, ${result.usage.input} input / ${result.usage.output} output tokens, stop_reason=${result.stopReason}_`);
if (mcp.approvals.length) log.push('', '**Approvals:**', ...mcp.approvals.map((a) => `- ${a.approved ? 'APPROVED' : 'DECLINED'}: ${a.message.replace(/\n/g, ' ')}`));

mkdirSync(path.join(here, 'transcripts'), { recursive: true });
const file = path.join(here, 'transcripts', `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(file, `${log.join('\n')}\n`);
console.log(`transcript saved to ${path.relative(process.cwd(), file)}`);
rl.close();
await mcp.close();
