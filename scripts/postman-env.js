// Writes postman/environment.local.json with fresh 12h dev tokens (gitignored).
import { writeFileSync, readFileSync } from 'node:fs';
import { mintToken, PERSONAS } from './token.js';

const env = JSON.parse(readFileSync('postman/environment.json', 'utf8'));
const tokens = {
  token_support: await mintToken({ ...PERSONAS['support-agent'], ttl: 43200 }),
  token_lead: await mintToken({ ...PERSONAS['support-lead'], ttl: 43200 }),
  token_finance: await mintToken({ ...PERSONAS.finance, ttl: 43200 }),
};
for (const v of env.values) if (tokens[v.key]) v.value = tokens[v.key];
env.name += ' (generated)';
writeFileSync('postman/environment.local.json', `${JSON.stringify(env, null, 2)}\n`);
console.log('wrote postman/environment.local.json');
