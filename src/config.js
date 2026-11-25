const env = process.env;

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

export function loadConfig(overrides = {}) {
  const mocksPort = int(env.MOCKS_PORT, 4010);
  const base = {
    env: env.NODE_ENV || 'development',
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || 'info',
    dbPath: env.DB_PATH || 'var/platform.db',

    auth: {
      // Local dev uses HS256 with a shared secret. In any real environment this is
      // replaced by JWKS_URL (RS256/ES256 from the IdP) and the secret is unset.
      issuer: env.JWT_ISSUER || 'https://idp.local.test/',
      audience: env.JWT_AUDIENCE || 'customer-platform-api',
      hsSecret: env.JWT_HS_SECRET || 'local-dev-only-secret-change-me-0123456789',
      jwksUrl: env.JWKS_URL || '',
    },

    upstreams: {
      cases: { baseUrl: env.CASES_URL || `http://127.0.0.1:${mocksPort}/crm`, timeoutMs: int(env.CASES_TIMEOUT_MS, 2000), retries: 2 },
      entitlements: { baseUrl: env.ENTITLEMENTS_URL || `http://127.0.0.1:${mocksPort}/erp`, timeoutMs: int(env.ENTITLEMENTS_TIMEOUT_MS, 2000), retries: 2 },
      usage: { baseUrl: env.USAGE_URL || `http://127.0.0.1:${mocksPort}/warehouse`, timeoutMs: int(env.USAGE_TIMEOUT_MS, 1500), retries: 1 },
    },
    breaker: { failureThreshold: int(env.BREAKER_FAILURES, 5), cooldownMs: int(env.BREAKER_COOLDOWN_MS, 10000) },
    entitlementCacheTtlMs: int(env.ENTITLEMENT_CACHE_TTL_MS, 60000),

    rateLimit: {
      user: { capacity: int(env.RL_USER_CAPACITY, 120), refillPerSec: 2 },
      agent: { capacity: int(env.RL_AGENT_CAPACITY, 60), refillPerSec: 1 },
    },

    idempotencyTtlHours: int(env.IDEMPOTENCY_TTL_HOURS, 24),

    webhooks: {
      dispatchIntervalMs: int(env.WEBHOOK_DISPATCH_INTERVAL_MS, 1000),
      timeoutMs: int(env.WEBHOOK_TIMEOUT_MS, 5000),
      allowPrivateTargets: bool(env.WEBHOOK_ALLOW_PRIVATE, true),
      devSubscriberUrl: env.WEBHOOK_DEV_SUBSCRIBER_URL ?? `http://127.0.0.1:${mocksPort}/consumer/webhooks/case-escalated`,
      devSubscriberSecret: env.WEBHOOK_DEV_SECRET || 'whsec_bG9jYWwtZGV2LXdlYmhvb2stc2VjcmV0',
    },

    mocks: { embedded: bool(env.EMBED_MOCKS, true), port: mocksPort, timeShift: bool(env.FIXTURE_TIME_SHIFT, true) },
  };
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] ? deepMerge(a[k], v) : v;
  }
  return out;
}
