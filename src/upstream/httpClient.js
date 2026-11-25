import { CircuitBreaker } from './circuitBreaker.js';

export class UpstreamError extends Error {
  constructor(upstream, reason, { status, retryAfterSeconds, cause } = {}) {
    super(`${upstream} ${reason}${status ? ` (HTTP ${status})` : ''}`);
    this.upstream = upstream;
    this.reason = reason; // timeout | unavailable | circuit_open | bad_response
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.cause = cause;
  }
}

// Upstream answered with a 4xx that callers should handle (404, 409, 412 ...).
export class UpstreamClientError extends Error {
  constructor(upstream, status, body) {
    super(`${upstream} returned ${status}`);
    this.upstream = upstream;
    this.status = status;
    this.body = body;
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createUpstream(name, { baseUrl, timeoutMs, retries }, { breaker, logger, baseDelayMs = 100 } = {}) {
  const cb = breaker instanceof CircuitBreaker ? breaker : new CircuitBreaker(name, breaker);

  // `retry` must only be true for idempotent requests (GETs, or writes that carry
  // an idempotency key the upstream honours). Retrying a plain POST risks duplicates.
  async function request(method, path, { body, headers = {}, correlationId, retry = method === 'GET', accept = 'application/json' } = {}) {
    const maxAttempts = retry ? retries + 1 : 1;
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!cb.allow()) {
        throw new UpstreamError(name, 'circuit_open', { retryAfterSeconds: cb.retryAfterSeconds() });
      }
      const started = Date.now();
      try {
        const res = await fetch(baseUrl + path, {
          method,
          headers: {
            accept,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        const ms = Date.now() - started;

        if (res.status >= 500 || res.status === 429) {
          cb.failure();
          lastErr = new UpstreamError(name, 'unavailable', { status: res.status, retryAfterSeconds: Number(res.headers.get('retry-after')) || undefined });
          logger?.warn({ upstream: name, method, path, status: res.status, ms, attempt, correlationId }, 'upstream error');
          if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) break;
          await sleep(backoff(attempt, baseDelayMs, res.headers.get('retry-after')));
          continue;
        }

        cb.success();
        logger?.debug({ upstream: name, method, path, status: res.status, ms, attempt, correlationId }, 'upstream call');
        const parsed = parse(text, res.headers.get('content-type'));
        if (parsed === PARSE_FAILED) throw new UpstreamError(name, 'bad_response', { status: res.status });
        if (res.status >= 400) throw new UpstreamClientError(name, res.status, parsed);
        return { status: res.status, headers: res.headers, body: parsed };
      } catch (err) {
        if (err instanceof UpstreamClientError || (err instanceof UpstreamError && err.reason === 'bad_response')) throw err;
        cb.failure();
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        lastErr = new UpstreamError(name, timedOut ? 'timeout' : 'unavailable', { cause: err });
        logger?.warn({ upstream: name, method, path, reason: lastErr.reason, attempt, correlationId, ms: Date.now() - started }, 'upstream call failed');
        if (attempt === maxAttempts) break;
        await sleep(backoff(attempt, baseDelayMs));
      }
    }
    throw lastErr;
  }

  return { name, request, breaker: cb };
}

const PARSE_FAILED = Symbol('parse-failed');
function parse(text, contentType = '') {
  if (!text) return null;
  if (!contentType?.includes('json')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return PARSE_FAILED;
  }
}

// Exponential backoff with full jitter; honours Retry-After when the upstream sends one.
export function backoff(attempt, baseMs, retryAfter) {
  const ra = Number(retryAfter);
  if (ra > 0) return Math.min(ra * 1000, 5000);
  const cap = baseMs * 2 ** (attempt - 1);
  return Math.floor(Math.random() * cap) + baseMs / 2;
}
