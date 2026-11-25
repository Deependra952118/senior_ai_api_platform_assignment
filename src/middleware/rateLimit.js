import { ApiError } from '../errors.js';

// In-memory token buckets. Agents get their own (smaller) bucket shared across all
// users they act for, so one runaway agent can't starve humans and can't dodge the
// limit by switching users. Users get a per-user bucket. A multi-instance deployment
// would move this to Redis or the gateway (see DECISIONS.md).
export function rateLimit({ user, agent }, now = Date.now) {
  const buckets = new Map();

  function take(key, { capacity, refillPerSec }) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.last) / 1000) * refillPerSec);
    b.last = t;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    const resetSec = Math.ceil((capacity - b.tokens) / refillPerSec);
    return { allowed, limit: capacity, remaining: Math.floor(b.tokens), resetSec, retryAfter: Math.ceil((1 - b.tokens) / refillPerSec) };
  }

  return (req, res, next) => {
    const p = res.locals.principal;
    const checks = [take(`user:${p.sub}`, user)];
    if (p.agent) checks.push(take(`agent:${p.agent}`, agent));
    // Report the tighter of the buckets.
    const r = checks.reduce((a, b) => (b.remaining < a.remaining || !b.allowed ? b : a));
    res.setHeader('RateLimit-Limit', r.limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, r.remaining));
    res.setHeader('RateLimit-Reset', r.resetSec);
    if (checks.some((c) => !c.allowed)) {
      return next(new ApiError('rateLimited', p.agent ? `Rate limit exceeded for agent ${p.agent}` : 'Rate limit exceeded', {
        retryAfterSeconds: r.retryAfter,
        headers: { 'Retry-After': String(r.retryAfter) },
      }));
    }
    next();
  };
}
