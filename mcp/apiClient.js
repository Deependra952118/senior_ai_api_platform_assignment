import { randomUUID } from 'node:crypto';

export class ApiProblem extends Error {
  constructor(status, problem) {
    super(problem?.detail ?? `HTTP ${status}`);
    this.status = status;
    this.problem = problem ?? {};
  }
}

// Thin client for the platform API. It only ever sends the user's delegated token;
// the MCP server holds no credentials of its own.
export function createApiClient({ baseUrl, token, fetchImpl = fetch }) {
  async function call(method, path, { query, body, headers = {}, correlationId = `mcp-${randomUUID()}` } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ''))}` : '';
    const res = await fetchImpl(`${baseUrl}${path}${qs}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-correlation-id': correlationId,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiProblem(res.status, data);
    return { status: res.status, data, headers: res.headers, correlationId };
  }
  return { call };
}
