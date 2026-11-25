// Writes one audit row per request that changes something, per request made by an
// agent (reads included), and per auth failure. Handlers can attach extra context
// via res.locals.audit = { resourceId, details }.
export function auditTrail(audit) {
  return (req, res, next) => {
    res.on('finish', () => {
      const p = res.locals.principal;
      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
      const denied = res.statusCode === 401 || res.statusCode === 403;
      if (!isWrite && !p?.agent && !denied) return;
      const extra = res.locals.audit ?? {};
      audit.record({
        correlationId: res.locals.correlationId,
        actorSub: p?.sub ?? 'anonymous',
        agentId: p?.agent ?? null,
        clientId: p?.clientId ?? null,
        action: res.locals.operationId ?? `${req.method} ${req.route?.path ?? req.path}`,
        resourceType: extra.resourceType ?? resourceTypeOf(req.path),
        resourceId: extra.resourceId ?? req.params?.caseId ?? req.params?.customerId ?? null,
        outcome: res.statusCode < 400 ? 'success' : denied ? 'denied' : 'failure',
        httpStatus: res.statusCode,
        details: extra.details ?? null,
      });
    });
    next();
  };
}

function resourceTypeOf(path) {
  if (path.startsWith('/v1/cases')) return 'case';
  if (path.startsWith('/v1/customers')) return 'customer';
  if (path.startsWith('/v1/webhook')) return 'webhook_subscription';
  return 'other';
}
