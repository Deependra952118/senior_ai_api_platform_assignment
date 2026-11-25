// Runs the LLM evals.  Needs the API running (make run) and ANTHROPIC_API_KEY.
//   npm run evals                      all scenarios, 1 trial
//   npm run evals -- --trials 3
//   npm run evals -- --only sample-question,injection-direct
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.js';
import { mintToken, PERSONAS } from '../../scripts/token.js';
import { connectMcp, runAgent, MODEL } from '../agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiUrl = process.env.PLATFORM_API_URL ?? 'http://localhost:3000';
const mocksUrl = process.env.MOCKS_URL ?? 'http://localhost:4010';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const trials = Number(opt('trials') ?? 1);
const only = opt('only')?.split(',');
const selected = scenarios.filter((s) => !only || only.includes(s.id));

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export function grade(s, run) {
  const fails = [];
  const calls = run.toolCalls;
  const names = calls.map((c) => c.name);
  const succeeded = (name) => calls.some((c) => c.name === name && !c.isError && /"ok":true/.test(c.output));
  const c = s.checks;
  for (const n of c.mustCall ?? []) if (!names.includes(n)) fails.push(`did not call ${n}`);
  for (const n of c.mustNotCall ?? []) if (names.includes(n)) fails.push(`called ${n}`);
  for (const n of c.mustNotSucceed ?? []) if (succeeded(n)) fails.push(`${n} completed`);
  for (const [n, max] of Object.entries(c.maxCalls ?? {})) {
    const k = names.filter((x) => x === n).length;
    if (k > max) fails.push(`${n} called ${k}x (max ${max})`);
  }
  for (const { tool, re } of c.argsMatch ?? []) {
    if (!calls.some((x) => x.name === tool && re.test(JSON.stringify(x.input)))) fails.push(`no ${tool} call with args ${re}`);
  }
  for (const re of c.answer ?? []) if (!re.test(run.answer)) fails.push(`answer missing ${re}`);
  for (const re of c.answerNot ?? []) if (re.test(run.answer)) fails.push(`answer contains ${re}`);
  return fails;
}

async function main() {
  try { await fetch(`${apiUrl}/health/live`); } catch { console.error(`API not reachable at ${apiUrl}; run make run first`); process.exit(1); }
  const results = [];
  for (const s of selected) {
    for (let t = 1; t <= trials; t++) {
      await post(`${mocksUrl}/__reset`);
      if (s.fault) await post(`${mocksUrl}/__faults`, s.fault);
      const mcp = await connectMcp({
        token: await mintToken({ ...PERSONAS[s.persona], ttl: 600 }),
        apiUrl,
        approve: s.approve ?? 'decline',
        auditLog: path.join(here, 'results', 'audit.log'),
      });
      const started = Date.now();
      let run;
      try {
        run = await runAgent({ question: s.question, mcp });
      } catch (err) {
        run = { answer: `[error: ${err.message}]`, toolCalls: [], usage: { input: 0, output: 0 }, stopReason: 'error' };
      } finally {
        await mcp.close();
        if (s.fault) await post(`${mocksUrl}/__faults`, { target: s.fault.target, mode: 'ok' });
      }
      const fails = grade(s, run);
      results.push({ id: s.id, category: s.category, trial: t, pass: fails.length === 0, fails, ms: Date.now() - started, tools: run.toolCalls.map((c) => c.name), tokens: run.usage, answer: run.answer, toolCalls: run.toolCalls });
      console.log(`${fails.length ? 'FAIL' : 'pass'}  ${s.id.padEnd(24)} #${t}  ${run.toolCalls.map((c) => c.name).join(' > ') || '(no tools)'}${fails.length ? `\n      - ${fails.join('\n      - ')}` : ''}`);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const tokens = results.reduce((a, r) => ({ input: a.input + r.tokens.input, output: a.output + r.tokens.output }), { input: 0, output: 0 });
  console.log(`\n${passed}/${results.length} passed  (model ${MODEL}, ${tokens.input} input / ${tokens.output} output tokens)`);
  mkdirSync(path.join(here, 'results'), { recursive: true });
  const file = path.join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ model: MODEL, trials, passed, total: results.length, tokens, results }, null, 2));
  console.log(`details: ${path.relative(process.cwd(), file)}`);
  process.exit(passed === results.length ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
