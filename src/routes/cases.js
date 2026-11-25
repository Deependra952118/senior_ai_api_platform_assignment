import { Router } from 'express';
import { createHash } from 'node:crypto';
import { authorize, principalKey } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ApiError } from '../errors.js';
import { hashRequest } from '../services/idempotency.js';
import { toApiError } from './upstreamErrors.js';
import { op } from './customers.js';

const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };
const ESCALATABLE = new Set(['open', 'pending']);
const STATE_SUNSET = 'Wed, 30 Jun 2027 00:00:00 GMT';

export const etagOf = (c) => `"${createHash('sha1').update(`${c.id}:${c.version}`).digest('hex').slice(0, 16)}"`;

export function casesRouter({ cases, entitlements, idempotency, outbox, cursors, now }) {
  const r = Router();

  const ageHours = (c) => Math.max(0, Math.floor((now() - Date.parse(c.openedAt)) / 3600_000));
  const toSummary = (c, account) => ({
    id: c.id, accountId: c.accountId, subject: c.subject, priority: c.priority, status: c.status,
    openedAt: c.openedAt, ageHours: ageHours(c),
    ...(account ? { account: { id: account.id, name: account.name, supportTier: account.supportTier, renewalDate: account.renewalDate } } : {}),
  });
  const toCase = (c) => ({ ...toSummary(c), comments: c.comments.map((cm) => ({ ...cm, caseId: c.id })), escalation: c.escalation ?? null });

  // ---------------------------------------------------------------- list
  r.get('/', op('listCases'), authorize('listCases'), validate('listCases'), async (req, res, next) => {
    const q = req.valid.query;
    const cid = res.locals.correlationId;
    try {
      if (q.state) {
        res.set('Deprecation', '@1764547200');
        res.set('Sunset', STATE_SUNSET);
        res.set('Link', '<https://docs.platform.example/api/changelog#cases-state>; rel="deprecation"');
        q.status ??= [q.state];
      }
      const includeAccount = q.include?.includes('account');
      const needAccounts = includeAccount || q.supportTier || q.renewalBefore;

      const [list, ents] = await Promise.all([
        cases.list({ status: q.status, priority: q.priority, accountId: q.accountId }, cid),
        needAccounts ? entitlements.all(cid) : null,
      ]);

      const openedBefore = q.openedBefore && Date.parse(q.openedBefore);
      const openedAfter = q.openedAfter && Date.parse(q.openedAfter);
      let rows = list.filter((c) => {
        const t = Date.parse(c.openedAt);
        if (openedBefore && !(t < openedBefore)) return false;
        if (openedAfter && !(t > openedAfter)) return false;
        if (!ents) return true;
        const a = ents.accounts.get(c.accountId);
        if (q.supportTier && !(a && q.supportTier.includes(a.supportTier))) return false;
        if (q.renewalBefore && !(a && a.renewalDate <= q.renewalBefore)) return false;
        return true;
      });

      const sort = q.sort;
      const key = (c) => (sort.endsWith('priority') ? PRIORITY_RANK[c.priority] : Date.parse(c.openedAt));
      const dir = sort.startsWith('-') ? -1 : 1;
      const cmp = (a, b) => (key(a) - key(b)) * dir || a.id.localeCompare(b.id);
      rows.sort(cmp);

      const { cursor, limit, ...filters } = q;
      const queryHash = hashRequest(filters).slice(0, 16);
      if (cursor) {
        const last = cursors.decode(cursor, queryHash);
        const pivot = { id: last.id, priority: last.p, openedAt: last.o };
        rows = rows.filter((c) => cmp(c, pivot) > 0);
      }
      const page = rows.slice(0, limit);
      const tail = page.at(-1);
      const nextCursor = rows.length > limit ? cursors.encode({ q: queryHash, id: tail.id, p: tail.priority, o: tail.openedAt }) : null;

      res.json({
        data: page.map((c) => toSummary(c, includeAccount ? ents.accounts.get(c.accountId) : null)),
        page: { limit, nextCursor },
      });
    } catch (err) {
      next(toApiError(err));
    }
  });

  // ---------------------------------------------------------------- get
  r.get('/:caseId', op('getCase'), authorize('getCase'), validate('getCase'), async (req, res, next) => {
    try {
      const c = await cases.get(req.valid.params.caseId, res.locals.correlationId);
      res.set('ETag', etagOf(c)).json(toCase(c));
    } catch (err) {
      next(toApiError(err, { notFound: `Case ${req.params.caseId} not found` }));
    }
  });

  // ---------------------------------------------------------------- comment
  r.post('/:caseId/comments', op('addCaseComment'), authorize('addCaseComment'), validate('addCaseComment'), async (req, res, next) => {
    const p = res.locals.principal;
    const pk = principalKey(p);
    const caseId = req.valid.params.caseId;
    const key = req.valid.headers['Idempotency-Key'];
    const { body, visibility } = req.valid.body;
    const cid = res.locals.correlationId;
    res.locals.audit.details = { visibility, length: body.length, idempotencyKey: key };

    try {
      const replay = idempotency.begin(pk, key, { method: 'POST', path: req.path, requestHash: hashRequest({ caseId, body, visibility }) });
      if (replay) {
        res.locals.audit.details.replayed = true;
        return res.status(replay.status).set(replay.headers).set('Idempotent-Replayed', 'true').json(replay.body);
      }
    } catch (err) {
      return next(err);
    }

    try {
      const current = await cases.get(caseId, cid);
      if (current.status === 'closed') throw new ApiError('invalidTransition', 'Comments cannot be added to a closed case');

      // Upstream key is namespaced by principal so two users' keys can't collide.
      const upstreamKey = createHash('sha256').update(`${pk}:${key}`).digest('hex').slice(0, 40);
      const comment = await cases.addComment(caseId, {
        author: p.sub, body, visibility, ...(p.agent ? { via: { agent: p.agent } } : {}),
      }, upstreamKey, cid);

      const out = { ...comment, caseId };
      const headers = { Location: `/v1/cases/${caseId}/comments/${comment.id}` };
      idempotency.complete(pk, key, 201, out, headers);
      res.status(201).set(headers).json(out);
    } catch (err) {
      const apiErr = toApiError(err, { notFound: `Case ${caseId} not found` });
      settle(idempotency, pk, key);
      next(apiErr);
    }
  });

  // ---------------------------------------------------------------- escalate
  r.post('/:caseId/escalate', op('escalateCase'), authorize('escalateCase'), validate('escalateCase'), async (req, res, next) => {
    const p = res.locals.principal;
    const pk = principalKey(p);
    const caseId = req.valid.params.caseId;
    const key = req.valid.headers['Idempotency-Key'];
    const ifMatch = req.get('if-match');
    const { reason, note } = req.valid.body;
    const cid = res.locals.correlationId;
    res.locals.audit.details = { reason };

    if (!ifMatch) return next(new ApiError('preconditionRequired', 'Send If-Match with the ETag from GET /v1/cases/{caseId}'));

    if (key) {
      try {
        const replay = idempotency.begin(pk, key, { method: 'POST', path: req.path, requestHash: hashRequest({ caseId, reason, note, ifMatch }) });
        if (replay) return res.status(replay.status).set(replay.headers).set('Idempotent-Replayed', 'true').json(replay.body);
      } catch (err) {
        return next(err);
      }
    }

    try {
      const current = await cases.get(caseId, cid);
      if (ifMatch.replace(/^W\//, '') !== etagOf(current)) {
        throw new ApiError('preconditionFailed', 'The case has changed since you read it; GET it again and retry with the new ETag');
      }
      if (!ESCALATABLE.has(current.status)) {
        throw new ApiError('invalidTransition', `A case in status '${current.status}' cannot be escalated`);
      }
      if ((current.priority === 'P3' || current.priority === 'P4') && reason !== 'security_incident') {
        const ent = await entitlements.get(current.accountId, cid);
        const tier = ent?.account.supportTier;
        if (tier !== 'Platinum' && tier !== 'Gold') {
          throw new ApiError('businessRule', `${current.priority} cases can only be escalated for Platinum or Gold customers (this one is ${tier ?? 'unknown'}) unless the reason is security_incident`);
        }
      }

      const escalation = {
        reason, ...(note ? { note } : {}), escalatedBy: p.sub,
        ...(p.agent ? { via: { agent: p.agent } } : {}),
        escalatedAt: new Date(now()).toISOString(),
      };
      const updated = await cases.update(caseId, { Status: 'escalated', escalation }, current.version, cid);

      outbox.publish('case.escalated', caseId, {
        caseId, accountId: updated.accountId, priority: updated.priority, previousStatus: current.status,
        reason, escalatedBy: p.sub, ...(p.agent ? { via: { agent: p.agent } } : {}), escalatedAt: escalation.escalatedAt,
      });

      const body = toCase(updated);
      const headers = { ETag: etagOf(updated) };
      if (key) idempotency.complete(pk, key, 200, body, headers);
      res.status(200).set(headers).json(body);
    } catch (err) {
      const apiErr = toApiError(err, { notFound: `Case ${caseId} not found` });
      if (key) settle(idempotency, pk, key);
      next(apiErr);
    }
  });

  return r;
}

// Errors release the key: a retry either succeeds or gets the same error again.
// Only successful outcomes are pinned to the key.
function settle(idempotency, pk, key) {
  idempotency.release(pk, key);
}
