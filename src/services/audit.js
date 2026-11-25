export function createAuditLog(db, { now = Date.now, logger } = {}) {
  const ins = db.prepare(`INSERT INTO audit_log
    (at, correlation_id, actor_sub, agent_id, client_id, action, resource_type, resource_id, outcome, http_status, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    record(e) {
      try {
        ins.run(new Date(now()).toISOString(), e.correlationId ?? null, e.actorSub, e.agentId ?? null, e.clientId ?? null,
          e.action, e.resourceType, e.resourceId ?? null, e.outcome, e.httpStatus ?? null, e.details ? JSON.stringify(e.details) : null);
      } catch (err) {
        // Never fail the request because the audit write failed, but make it loud.
        logger?.error({ err: err.message, action: e.action }, 'audit write failed');
      }
    },
    recent({ resourceId, agentId, limit = 50 } = {}) {
      const where = [];
      const args = [];
      if (resourceId) { where.push('resource_id = ?'); args.push(resourceId); }
      if (agentId) { where.push('agent_id = ?'); args.push(agentId); }
      const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, limit);
    },
  };
}
