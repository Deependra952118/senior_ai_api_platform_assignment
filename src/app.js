import express from 'express';
import pinoHttp from 'pino-http';
import { correlation } from './middleware/correlation.js';
import { authenticate } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { auditTrail } from './middleware/audit.js';
import { ApiError, sendProblem } from './errors.js';
import { createUpstream } from './upstream/httpClient.js';
import { createCaseSystem } from './upstream/caseSystem.js';
import { createEntitlements } from './upstream/entitlements.js';
import { createUsageWarehouse } from './upstream/usageWarehouse.js';
import { createIdempotencyStore } from './services/idempotency.js';
import { createAuditLog } from './services/audit.js';
import { createCursorCodec } from './services/cursor.js';
import { createOutbox } from './events/outbox.js';
import { createDispatcher } from './events/dispatcher.js';
import { customersRouter } from './routes/customers.js';
import { casesRouter } from './routes/cases.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp({ config, logger, db, now = Date.now }) {
  const http = Object.fromEntries(Object.entries(config.upstreams).map(([name, c]) => [
    name, createUpstream(name, c, { breaker: { ...config.breaker, now }, logger: logger.child({ component: 'upstream' }) }),
  ]));

  const services = {
    cases: createCaseSystem(http.cases),
    entitlements: createEntitlements(http.entitlements, { ttlMs: config.entitlementCacheTtlMs, logger, now }),
    usage: createUsageWarehouse(http.usage),
    idempotency: createIdempotencyStore(db, { ttlHours: config.idempotencyTtlHours, now }),
    audit: createAuditLog(db, { now, logger }),
    cursors: createCursorCodec(config.auth.hsSecret + ':cursor'),
    outbox: createOutbox(db, { now }),
    http,
    now,
    logger,
    db,
  };
  const dispatcher = createDispatcher(db, { logger: logger.child({ component: 'webhooks' }), timeoutMs: config.webhooks.timeoutMs, now, outbox: services.outbox });

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(correlation());
  app.use(pinoHttp({
    logger,
    genReqId: (_req, res) => res.locals.correlationId,
    customProps: (_req, res) => ({ correlationId: res.locals.correlationId, sub: res.locals.principal?.sub, agent: res.locals.principal?.agent ?? undefined }),
    serializers: { req: (r) => ({ method: r.method, url: r.url }), res: (r) => ({ statusCode: r.statusCode }) },
  }));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    next();
  });

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', (_req, res) => {
    const upstreams = Object.fromEntries(Object.entries(http).map(([n, h]) => [n, { circuit: h.breaker.state }]));
    const degraded = Object.values(upstreams).some((u) => u.circuit !== 'closed');
    res.json({ status: degraded ? 'degraded' : 'ok', upstreams });
  });

  const v1 = express.Router();
  v1.use(auditTrail(services.audit));
  v1.use(authenticate(config.auth));
  v1.use(rateLimit(config.rateLimit, now));
  v1.use(express.json({ limit: '32kb' }));
  v1.use('/customers', customersRouter(services));
  v1.use('/cases', casesRouter(services));
  v1.use('/webhook-subscriptions', webhooksRouter({ db, allowPrivateTargets: config.webhooks.allowPrivateTargets, now }));
  app.use('/v1', v1);

  app.use((_req, _res, next) => next(new ApiError('notFound', 'No such endpoint')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e = err;
    if (err.type === 'entity.parse.failed') e = new ApiError('validation', 'Body is not valid JSON', { errors: [{ in: 'body', message: 'invalid JSON' }] });
    else if (err.type === 'entity.too.large') e = new ApiError('validation', 'Body is too large (max 32kb)', { status: 413 });
    else if (!(err instanceof ApiError)) {
      req.log.error({ err }, 'unhandled error');
      e = new ApiError('internal', 'Something went wrong. Quote the correlationId when reporting this.');
    }
    if (e.status >= 500) req.log.warn({ kind: e.kind, detail: e.detail }, 'request failed');
    sendProblem(res, e);
  });

  return { app, services, dispatcher };
}

export function seedDevSubscription(db, { url, secret }, now = Date.now) {
  if (!url) return;
  const exists = db.prepare('SELECT 1 FROM webhook_subscriptions WHERE url = ?').get(url);
  if (exists) return;
  db.prepare('INSERT INTO webhook_subscriptions (id, url, secret, event_types, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('sub_localdevconsumer0001', url, secret, JSON.stringify(['case.escalated']), 'bootstrap', new Date(now()).toISOString());
}
