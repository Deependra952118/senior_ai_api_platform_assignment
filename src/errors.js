// RFC 9457 problem details. Every non-2xx response from this API goes through here
// so clients (and the MCP server) can switch on `type` instead of parsing strings.

const BASE = 'https://errors.platform.example/problems';

export const ProblemTypes = {
  validation: { slug: 'validation-error', title: 'Request validation failed', status: 400 },
  unauthorized: { slug: 'unauthorized', title: 'Authentication required', status: 401 },
  forbidden: { slug: 'forbidden', title: 'Insufficient scope', status: 403 },
  notFound: { slug: 'not-found', title: 'Resource not found', status: 404 },
  conflict: { slug: 'conflict', title: 'Conflict', status: 409 },
  invalidTransition: { slug: 'invalid-state-transition', title: 'Case cannot make this transition', status: 409 },
  idempotencyInProgress: { slug: 'idempotency-in-progress', title: 'A request with this Idempotency-Key is still being processed', status: 409 },
  preconditionFailed: { slug: 'precondition-failed', title: 'Resource has changed', status: 412 },
  idempotencyMismatch: { slug: 'idempotency-key-reused', title: 'Idempotency-Key reused with a different request', status: 422 },
  businessRule: { slug: 'business-rule-violation', title: 'Business rule violation', status: 422 },
  preconditionRequired: { slug: 'precondition-required', title: 'If-Match header required', status: 428 },
  rateLimited: { slug: 'rate-limited', title: 'Too many requests', status: 429 },
  internal: { slug: 'internal-error', title: 'Internal server error', status: 500 },
  upstreamUnavailable: { slug: 'upstream-unavailable', title: 'Upstream system unavailable', status: 503 },
  upstreamTimeout: { slug: 'upstream-timeout', title: 'Upstream system timed out', status: 504 },
  upstreamBadResponse: { slug: 'upstream-bad-response', title: 'Upstream system returned an invalid response', status: 502 },
};

export class ApiError extends Error {
  constructor(kind, detail, extra = {}) {
    const def = ProblemTypes[kind] ?? ProblemTypes.internal;
    super(detail || def.title);
    this.kind = kind;
    this.status = extra.status ?? def.status;
    this.detail = detail;
    this.extra = extra;
    this.headers = extra.headers ?? {};
  }
}

export function problemBody(err, correlationId, instance) {
  const def = ProblemTypes[err.kind] ?? ProblemTypes.internal;
  const body = {
    type: `${BASE}/${def.slug}`,
    title: def.title,
    status: err.status ?? def.status,
    detail: err.detail ?? def.title,
    instance,
    correlationId,
  };
  const { errors, upstream, requiredScopes, retryAfterSeconds } = err.extra ?? {};
  if (errors) body.errors = errors;
  if (upstream) body.upstream = upstream;
  if (requiredScopes) body.requiredScopes = requiredScopes;
  if (retryAfterSeconds !== undefined) body.retryAfterSeconds = retryAfterSeconds;
  return body;
}

export function sendProblem(res, err) {
  const body = problemBody(err, res.locals.correlationId, res.req?.originalUrl?.split('?')[0]);
  for (const [k, v] of Object.entries(err.headers ?? {})) res.setHeader(k, v);
  res.status(body.status).type('application/problem+json').send(JSON.stringify(body));
}
