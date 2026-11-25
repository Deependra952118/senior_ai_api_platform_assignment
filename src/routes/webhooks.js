import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ApiError } from '../errors.js';
import { newSecret } from '../events/signature.js';
import { op } from './customers.js';

export function webhooksRouter({ db, allowPrivateTargets, now }) {
  const r = Router();
  const ins = db.prepare('INSERT INTO webhook_subscriptions (id, url, secret, event_types, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const list = db.prepare('SELECT id, url, event_types, status, created_at FROM webhook_subscriptions ORDER BY created_at');
  const disable = db.prepare("UPDATE webhook_subscriptions SET status = 'disabled' WHERE id = ?");

  r.post('/', op('createWebhookSubscription'), authorize('createWebhookSubscription'), validate('createWebhookSubscription'), (req, res, next) => {
    const { url, eventTypes } = req.valid.body;
    const problem = checkTarget(url, allowPrivateTargets);
    if (problem) return next(new ApiError('validation', problem, { errors: [{ in: 'body', pointer: '/url', message: problem }] }));

    const sub = {
      id: `sub_${randomBytes(10).toString('hex')}`, url, eventTypes, status: 'active',
      createdAt: new Date(now()).toISOString(), secret: newSecret(),
    };
    ins.run(sub.id, url, sub.secret, JSON.stringify(eventTypes), res.locals.principal.sub, sub.createdAt);
    res.locals.audit = { resourceType: 'webhook_subscription', resourceId: sub.id, details: { url, eventTypes } };
    res.status(201).json(sub);
  });

  r.get('/', op('listWebhookSubscriptions'), authorize('listWebhookSubscriptions'), (_req, res) => {
    res.json({ data: list.all().map((s) => ({ id: s.id, url: s.url, eventTypes: JSON.parse(s.event_types), status: s.status, createdAt: s.created_at })) });
  });

  r.delete('/:subscriptionId', op('deleteWebhookSubscription'), authorize('deleteWebhookSubscription'), validate('deleteWebhookSubscription'), (req, res, next) => {
    const { changes } = disable.run(req.valid.params.subscriptionId);
    if (!changes) return next(new ApiError('notFound', 'Subscription not found'));
    res.locals.audit = { resourceType: 'webhook_subscription', resourceId: req.valid.params.subscriptionId };
    res.status(204).end();
  });

  return r;
}

// SSRF guard. Literal-IP and hostname checks only; production would also resolve the
// name and re-check the address at send time (DNS rebinding), or egress via a proxy.
export function checkTarget(raw, allowPrivate) {
  let u;
  try { u = new URL(raw); } catch { return 'url is not a valid URL'; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.username || u.password) return 'url must not contain credentials';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback && allowPrivate)) return 'url must use https';
  if (!allowPrivate && (loopback || isPrivateIp(host) || host.endsWith('.internal') || host.endsWith('.local'))) {
    return 'url must not point to a private or loopback address';
  }
  return null;
}

function isPrivateIp(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) return /^(fc|fd|fe80|::1|::ffff:)/i.test(host);
  return false;
}
