#!/usr/bin/env node
// MCP server (stdio) for the Support Copilot. Wraps the platform REST API.
//
// Identity: the host passes the *user's* delegated token in PLATFORM_TOKEN (obtained
// by RFC 8693 token exchange: user token -> token for audience customer-platform-api
// with act.sub = the agent). The server never holds a service credential, so the
// agent can do exactly what the user can do, and the API sees both identities.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './apiClient.js';
import { buildTools, instrument, SERVER_INSTRUCTIONS } from './tools.js';
import { createToolRateLimiter, createAuditSink, createConfirmationStore } from './guardrails.js';
import { createConfirm } from './confirm.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function decodeIdentity(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return { sub: payload.sub, agent: payload.act?.sub ?? null, scopes: String(payload.scope ?? '').split(' ').filter(Boolean) };
  } catch {
    return null;
  }
}

export function createPlatformMcpServer({ api, identity, approvalMode = 'elicit', audit, limiter = createToolRateLimiter(), now, log = () => {} }) {
  const server = new McpServer({ name: 'customer-platform', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });
  const confirm = createConfirm({ server, mode: approvalMode, store: createConfirmationStore(), log });

  for (const tool of buildTools({ api, now })) {
    // Don't advertise tools the user's scopes can never use (less for the model to misuse).
    if (tool.name === 'escalate_case' && !identity.scopes.includes('cases:escalate')) continue;
    if (tool.name === 'add_case_comment' && !identity.scopes.includes('cases:write')) continue;
    server.registerTool(tool.name, tool.config, instrument(tool, { limiter, audit, identity, confirm }));
  }
  return server;
}

async function main() {
  const token = process.env.PLATFORM_TOKEN;
  const log = (m) => process.stderr.write(`[customer-platform-mcp] ${m}\n`);
  if (!token) {
    log('PLATFORM_TOKEN is not set. Mint one with: npm run -s token -- copilot');
    process.exit(1);
  }
  const identity = decodeIdentity(token);
  if (!identity) {
    log('PLATFORM_TOKEN is not a JWT');
    process.exit(1);
  }
  if (!identity.agent && process.env.MCP_ALLOW_UNDELEGATED !== '1') {
    log('PLATFORM_TOKEN has no act claim, i.e. it is not a delegated (on-behalf-of) token. Refusing to start.');
    process.exit(1);
  }

  const server = createPlatformMcpServer({
    api: createApiClient({ baseUrl: process.env.PLATFORM_API_URL ?? 'http://localhost:3000', token }),
    identity,
    approvalMode: process.env.MCP_APPROVAL_MODE ?? 'elicit',
    audit: createAuditSink(process.env.MCP_AUDIT_LOG ?? path.join(here, 'audit.log')),
    log,
  });
  await server.connect(new StdioServerTransport());
  log(`ready: user=${identity.sub} agent=${identity.agent} scopes=${identity.scopes.join(',')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
