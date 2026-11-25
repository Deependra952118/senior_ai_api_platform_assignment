import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ApiError } from '../errors.js';
import { toApiError } from './upstreamErrors.js';

const ACTIVE = ['open', 'pending', 'escalated'];
const DAY = 86400000;

export function customersRouter({ entitlements, usage, cases, now, logger }) {
  const r = Router();

  r.get('/:customerId', op('getCustomer'), authorize('getCustomer'), validate('getCustomer'), async (req, res, next) => {
    const id = req.valid.params.customerId;
    const cid = res.locals.correlationId;
    const { scopes } = res.locals.principal;
    try {
      // Entitlement is the core of the aggregate: without it there is nothing to return.
      const ent = await entitlements.get(id, cid).catch((e) => { throw toApiError(e); });
      if (!ent) throw new ApiError('notFound', `Customer ${id} not found`);

      // Usage and case counts are best-effort.
      const [u, c] = await Promise.allSettled([usage.summary(id, cid), cases.list({ accountId: id, status: ACTIVE }, cid)]);
      const degradedSources = [];
      if (ent.stale) degradedSources.push('entitlements');
      if (u.status === 'rejected') degradedSources.push('usage');
      if (c.status === 'rejected') degradedSources.push('cases');
      if (degradedSources.length) logger.warn({ correlationId: cid, customerId: id, degradedSources }, 'customer view degraded');

      const a = ent.account;
      const body = {
        id: a.id,
        name: a.name,
        supportTier: a.supportTier,
        contract: { renewalDate: a.renewalDate, daysToRenewal: Math.ceil((Date.parse(`${a.renewalDate}T00:00:00Z`) - now()) / DAY) },
        ...(scopes.has('customers:financials') ? { arrUsd: a.arrUsd } : {}),
        usage: u.status === 'fulfilled' ? u.value : null,
        cases: c.status === 'fulfilled'
          ? { active: c.value.length, activeP1: c.value.filter((x) => x.priority === 'P1').length }
          : null,
        degraded: degradedSources.length > 0,
        degradedSources,
        redactedFields: scopes.has('customers:financials') ? [] : ['arrUsd'],
        entitlementAsOf: new Date(ent.fetchedAt).toISOString(),
      };
      res.set('Cache-Control', 'private, max-age=30').json(body);
    } catch (err) {
      next(toApiError(err));
    }
  });

  return r;
}

// Tags the request with its operationId and resource id for logs and the audit
// trail (set here because req.params is gone by the time 'finish' fires).
export const op = (id) => (req, res, next) => {
  res.locals.operationId = id;
  res.locals.audit = { resourceId: req.params.caseId ?? req.params.customerId ?? null };
  next();
};
