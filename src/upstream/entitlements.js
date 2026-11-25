import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

const TIERS = new Set(['Platinum', 'Gold', 'Silver', 'Standard']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The entitlement system gives us two things:
//   - a nightly CSV export (name, tier, contract end, ARR) - the base record
//   - an XML change feed with tier/renewal updates newer than the export
// We merge them (feed wins for tier and renewal) and cache the result. If a refresh
// fails we keep serving the last good copy and flag it as stale.
export function createEntitlements(http, { ttlMs = 60000, logger, now = Date.now } = {}) {
  let cache = null; // { accounts: Map, fetchedAt }
  let inflight = null;

  async function refresh(correlationId) {
    const [csvRes, xmlRes] = await Promise.allSettled([
      http.request('GET', '/exports/accounts.csv', { accept: 'text/csv', correlationId }),
      http.request('GET', '/feeds/entitlements.xml', { accept: 'application/xml', correlationId }),
    ]);
    if (csvRes.status === 'rejected') throw csvRes.reason;

    const accounts = parseExport(csvRes.value.body, logger);
    if (xmlRes.status === 'fulfilled') {
      applyFeed(accounts, xmlRes.value.body, logger);
    } else {
      logger?.warn({ correlationId, err: xmlRes.reason?.message }, 'entitlement feed unavailable, using export only');
    }
    cache = { accounts, fetchedAt: now() };
    return cache;
  }

  async function load(correlationId) {
    if (cache && now() - cache.fetchedAt < ttlMs) return { ...cache, stale: false };
    try {
      inflight ??= refresh(correlationId).finally(() => { inflight = null; });
      return { ...(await inflight), stale: false };
    } catch (err) {
      if (cache) {
        logger?.warn({ correlationId, err: err.message }, 'serving stale entitlements');
        return { ...cache, stale: true };
      }
      throw err;
    }
  }

  return {
    async get(accountId, correlationId) {
      const snap = await load(correlationId);
      const acct = snap.accounts.get(accountId);
      return acct ? { account: acct, stale: snap.stale, fetchedAt: snap.fetchedAt } : null;
    },
    async all(correlationId) {
      return load(correlationId);
    },
    _reset() { cache = null; },
  };
}

export function parseExport(csvText, logger) {
  const rows = parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true });
  const out = new Map();
  for (const r of rows) {
    if (!r.account_id || !TIERS.has(r.support_tier) || !DATE.test(r.contract_end)) {
      logger?.warn({ row: r.account_id }, 'skipping malformed entitlement row');
      continue;
    }
    out.set(r.account_id, {
      id: r.account_id,
      name: r.name,
      supportTier: r.support_tier,
      renewalDate: r.contract_end,
      arrUsd: Number.parseInt(r.arr_usd, 10) || 0,
    });
  }
  return out;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (name) => name === 'account' });

export function applyFeed(accounts, xmlText, logger) {
  const doc = xml.parse(xmlText);
  for (const a of doc?.accounts?.account ?? []) {
    const existing = accounts.get(a['@id']);
    if (!existing) continue; // feed only updates known accounts
    if (TIERS.has(a.tier)) existing.supportTier = a.tier;
    if (DATE.test(String(a.renewal))) existing.renewalDate = String(a.renewal);
    else logger?.warn({ account: a['@id'] }, 'bad renewal date in feed');
  }
  return accounts;
}
