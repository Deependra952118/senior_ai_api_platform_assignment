// Adapter for the case system (Salesforce-like). Normalises its field naming
// quirks (`Status`, `Comments`) so nothing above this file sees them.

export function createCaseSystem(http) {
  return {
    async list(filters, correlationId) {
      const qs = new URLSearchParams();
      if (filters.status?.length) qs.set('status', filters.status.join(','));
      if (filters.priority?.length) qs.set('priority', filters.priority.join(','));
      if (filters.accountId) qs.set('accountId', filters.accountId);
      const res = await http.request('GET', `/cases?${qs}`, { correlationId });
      return (res.body?.records ?? []).map(normalizeCase);
    },

    async get(id, correlationId) {
      const res = await http.request('GET', `/cases/${encodeURIComponent(id)}`, { correlationId });
      return normalizeCase(res.body);
    },

    // The case system honours Idempotency-Key itself, so this POST is safe to retry.
    async addComment(id, comment, idempotencyKey, correlationId) {
      const res = await http.request('POST', `/cases/${encodeURIComponent(id)}/comments`, {
        body: comment,
        headers: { 'idempotency-key': idempotencyKey },
        retry: true,
        correlationId,
      });
      return normalizeComment(res.body);
    },

    // Conditional update; the upstream rejects it with 412 if `version` is stale.
    async update(id, patch, version, correlationId) {
      const res = await http.request('PATCH', `/cases/${encodeURIComponent(id)}`, {
        body: patch,
        headers: { 'if-match': String(version) },
        retry: false,
        correlationId,
      });
      return normalizeCase(res.body);
    },
  };
}

export function normalizeCase(raw) {
  return {
    id: raw.id,
    accountId: raw.accountId,
    subject: raw.subject ?? '',
    priority: raw.priority,
    status: String(raw.Status ?? raw.status ?? '').toLowerCase(),
    openedAt: raw.openedAt,
    comments: (raw.Comments ?? raw.comments ?? []).map(normalizeComment),
    escalation: raw.escalation ?? null,
    version: raw.version ?? 1,
  };
}

function normalizeComment(c) {
  return {
    id: c.id,
    author: c.author,
    body: c.body,
    visibility: c.visibility ?? 'internal',
    createdAt: c.at ?? c.createdAt,
    ...(c.via ? { via: c.via } : {}),
  };
}
