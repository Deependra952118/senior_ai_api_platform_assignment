// Mints local dev tokens shaped like the ones the IdP would issue.
//   node scripts/token.js support-agent
//   node scripts/token.js copilot --sub alice
//   node scripts/token.js --sub bob --scopes "cases:read customers:read" --ttl 600
import { SignJWT } from 'jose';
import { loadConfig } from '../src/config.js';

export const PERSONAS = {
  'support-agent': { sub: 'alice', scopes: 'cases:read cases:write customers:read', client: 'support-console' },
  'support-lead': { sub: 'sam', scopes: 'cases:read cases:write cases:escalate customers:read', client: 'support-console' },
  finance: { sub: 'fiona', scopes: 'customers:read customers:financials', client: 'finance-portal' },
  ipaas: { sub: 'svc-mulesoft', scopes: 'cases:read cases:write customers:read', client: 'mulesoft-prod' },
  admin: { sub: 'pat', scopes: 'webhooks:manage', client: 'platform-admin' },
  // Token-exchanged token: the Support Copilot acting for a support lead.
  copilot: { sub: 'sam', scopes: 'cases:read cases:write cases:escalate customers:read', client: 'support-copilot', agent: 'support-copilot' },
  // Same agent acting for a plain support agent: no escalate scope.
  'copilot-limited': { sub: 'alice', scopes: 'cases:read cases:write customers:read', client: 'support-copilot', agent: 'support-copilot' },
  // Agent acting for a finance user: can see ARR, cannot touch cases.
  'copilot-finance': { sub: 'fiona', scopes: 'customers:read customers:financials cases:read', client: 'support-copilot', agent: 'support-copilot' },
};

export async function mintToken({ sub, scopes, client, agent, ttl = 3600 }, config = loadConfig()) {
  const jwt = new SignJWT({ scope: scopes, client_id: client, ...(agent ? { act: { sub: agent } } : {}) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(config.auth.issuer)
    .setAudience(config.auth.audience)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`);
  return jwt.sign(new TextEncoder().encode(config.auth.hsSecret));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const persona = args[0] && !args[0].startsWith('--') ? PERSONAS[args[0]] : {};
  if (args[0] && !args[0].startsWith('--') && !PERSONAS[args[0]]) {
    console.error(`unknown persona ${args[0]}; one of: ${Object.keys(PERSONAS).join(', ')}`);
    process.exit(1);
  }
  const claims = { ...persona, sub: opt('sub') ?? persona.sub ?? 'dev', scopes: opt('scopes') ?? persona.scopes ?? '', ttl: Number(opt('ttl') ?? 3600) };
  if (opt('agent')) claims.agent = opt('agent');
  process.stdout.write(`${await mintToken(claims)}\n`);
}
