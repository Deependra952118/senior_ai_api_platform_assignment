// Prints an MCP client config (Claude Desktop, Cursor, Claude Code) pointing at this checkout.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintToken, PERSONAS } from './token.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const persona = process.argv[2] ?? 'copilot';
const token = await mintToken({ ...PERSONAS[persona], ttl: 8 * 3600 });
console.log(JSON.stringify({
  mcpServers: {
    'customer-platform': {
      command: process.execPath,
      args: [path.join(root, 'mcp/server.js')],
      env: { PLATFORM_API_URL: 'http://localhost:3000', PLATFORM_TOKEN: token },
    },
  },
}, null, 2));
