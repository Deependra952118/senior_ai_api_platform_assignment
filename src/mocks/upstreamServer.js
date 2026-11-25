// Local stand-ins for the three upstream systems plus one webhook consumer.
// Mounted under:
//   /crm        case system (JSON REST)
//   /erp        entitlement system (CSV export + XML feed)
//   /warehouse  usage warehouse (SQL statements API over SQLite)
//   /consumer   an example webhook receiver (think: a MuleSoft flow)
//   /__faults   fault injection used by tests and the README demo
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { verify } from '../events/signature.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/fixtures');
const DAY = 86400000;

export function createMockUpstreams({ timeShift = true, now = Date.now, webhookSecret, logger } = {}) {
  const app = express();

  const faults = { cases: { mode: 'ok' }, entitlements: { mode: 'ok' }, usage: { mode: 'ok' } };
  const counters = { cases: 0, entitlements: 0, usage: 0 };
  let state;

  function load() {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8'));
    // Rounded to the minute so shifted timestamps stay readable.
    const shiftMs = timeShift ? Math.round((now() - Date.parse(fixture._anchor)) / 60000) * 60000 : 0;
    const shiftDays = Math.floor(shiftMs / DAY);
    const shiftTs = (iso) => new Date(Date.parse(iso) + shiftMs).toISOString().replace('.000Z', 'Z');
    const shiftDate = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + shiftDays * DAY).toISOString().slice(0, 10);

    const cases = new Map();
    for (const c of fixture.records) {
      cases.set(c.id, {
        ...c,
        openedAt: shiftTs(c.openedAt),
        Comments: c.Comments.map((cm, i) => ({ id: `CM-${c.id.slice(3)}-${i + 1}`, visibility: 'internal', ...cm, at: shiftTs(cm.at) })),
        version: 1,
        escalation: c.Status === 'escalated' ? { reason: 'customer_impact', escalatedBy: 'seed', escalatedAt: shiftTs(c.openedAt) } : null,
      });
    }
    const csv = readFileSync(path.join(FIXTURES, 'entitlements.csv'), 'utf8')
      .replace(/,(\d{4}-\d{2}-\d{2}),/g, (_, d) => `,${shiftDate(d)},`);
    const xml = readFileSync(path.join(FIXTURES, 'entitlement-feed.xml'), 'utf8')
      .replace(/<renewal>(\d{4}-\d{2}-\d{2})<\/renewal>/g, (_, d) => `<renewal>${shiftDate(d)}</renewal>`);

    const wh = new DatabaseSync(':memory:');
    wh.exec(readFileSync(path.join(FIXTURES, 'usage.sql'), 'utf8'));

    state = { cases, csv, xml, wh, commentKeys: new Map(), received: [], seenEventIds: new Set() };
  }
  load();

  // --- example webhook consumer ---------------------------------------------
  // Registered before express.json(): signature checks need the exact raw bytes.
  app.post('/consumer/webhooks/case-escalated', express.raw({ type: '*/*' }), (req, res) => {
    const raw = req.body.toString('utf8');
    const check = verify(webhookSecret, req.headers, raw, { nowSec: Math.floor(now() / 1000) });
    if (!check.ok) {
      logger?.warn({ reason: check.reason }, 'consumer rejected webhook');
      return res.status(401).json({ error: check.reason });
    }
    if (state.seenEventIds.has(check.id)) return res.status(200).json({ duplicate: true });
    state.seenEventIds.add(check.id);
    state.received.push(JSON.parse(raw));
    logger?.info({ eventId: check.id }, 'consumer accepted webhook');
    res.status(204).end();
  });
  app.get('/consumer/webhooks/received', (_req, res) => res.json(state.received));

  app.use(express.json());

  // --- fault injection -------------------------------------------------------
  app.post('/__faults', (req, res) => {
    const { target, mode = 'ok', delayMs = 3000 } = req.body ?? {};
    if (!faults[target]) return res.status(400).json({ error: 'unknown target' });
    faults[target] = { mode, delayMs };
    counters[target] = 0;
    res.json(faults);
  });
  app.get('/__faults', (_req, res) => res.json(faults));
  app.post('/__reset', (_req, res) => {
    for (const k of Object.keys(faults)) faults[k] = { mode: 'ok' };
    load();
    res.json({ ok: true });
  });

  const inject = (target) => async (req, res, next) => {
    const f = faults[target];
    counters[target] += 1;
    if (f.mode === 'down') return res.status(503).json({ error: 'service unavailable' });
    if (f.mode === 'flaky' && counters[target] % 2 === 1) return res.status(503).json({ error: 'temporary failure' });
    if (f.mode === 'slow') await new Promise((r) => setTimeout(r, f.delayMs));
    if (f.mode === 'garbage') return res.type('application/json').send('{"records": [ truncated');
    next();
  };

  // --- case system -----------------------------------------------------------
  const crm = express.Router();
  crm.use(inject('cases'));
  crm.get('/cases', (req, res) => {
    const status = req.query.status?.split(',');
    const priority = req.query.priority?.split(',');
    const records = [...state.cases.values()].filter((c) =>
      (!status || status.includes(c.Status)) &&
      (!priority || priority.includes(c.priority)) &&
      (!req.query.accountId || c.accountId === req.query.accountId));
    res.json({ totalSize: records.length, records });
  });
  crm.get('/cases/:id', (req, res) => {
    const c = state.cases.get(req.params.id);
    return c ? res.json(c) : res.status(404).json({ errorCode: 'NOT_FOUND' });
  });
  crm.post('/cases/:id/comments', (req, res) => {
    const c = state.cases.get(req.params.id);
    if (!c) return res.status(404).json({ errorCode: 'NOT_FOUND' });
    const key = req.get('idempotency-key');
    if (key && state.commentKeys.has(key)) return res.status(201).json(state.commentKeys.get(key));
    const comment = {
      id: `CM-${c.id.slice(3)}-${c.Comments.length + 1}`,
      author: req.body.author,
      body: req.body.body,
      visibility: req.body.visibility ?? 'internal',
      at: new Date().toISOString(),
      ...(req.body.via ? { via: req.body.via } : {}),
    };
    c.Comments.push(comment);
    c.version += 1;
    if (key) state.commentKeys.set(key, comment);
    res.status(201).json(comment);
  });
  crm.patch('/cases/:id', (req, res) => {
    const c = state.cases.get(req.params.id);
    if (!c) return res.status(404).json({ errorCode: 'NOT_FOUND' });
    if (req.get('if-match') !== String(c.version)) return res.status(412).json({ errorCode: 'VERSION_MISMATCH' });
    if (req.body.Status) c.Status = req.body.Status;
    if (req.body.escalation) c.escalation = req.body.escalation;
    c.version += 1;
    res.json(c);
  });
  app.use('/crm', crm);

  // --- entitlement system ----------------------------------------------------
  const erp = express.Router();
  erp.use(inject('entitlements'));
  erp.get('/exports/accounts.csv', (_req, res) => res.type('text/csv').send(state.csv));
  erp.get('/feeds/entitlements.xml', (_req, res) => res.type('application/xml').send(state.xml));
  app.use('/erp', erp);

  // --- usage warehouse -------------------------------------------------------
  const warehouse = express.Router();
  warehouse.use(inject('usage'));
  warehouse.post('/api/v2/statements', (req, res) => {
    const { statement, bindings = {} } = req.body ?? {};
    if (typeof statement !== 'string' || !/^\s*select\b/i.test(statement)) {
      return res.status(422).json({ code: '002003', message: 'Only SELECT statements are allowed' });
    }
    const params = Object.keys(bindings).sort((a, b) => a - b).map((k) => bindings[k].value);
    try {
      const stmt = state.wh.prepare(statement);
      const cols = stmt.columns().map((c) => ({ name: c.name.toUpperCase() }));
      const rows = stmt.all(...params).map((r) => Object.values(r).map((v) => (v === null ? null : String(v))));
      res.json({ statementHandle: randomUUID(), resultSetMetaData: { numRows: rows.length, rowType: cols }, data: rows });
    } catch (e) {
      res.status(422).json({ code: '001003', message: e.message });
    }
  });
  app.use('/warehouse', warehouse);

  return { app, faults, reset: load, state: () => state };
}
