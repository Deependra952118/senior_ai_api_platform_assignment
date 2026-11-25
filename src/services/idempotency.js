import { createHash } from 'node:crypto';
import { ApiError } from '../errors.js';
import { tx } from '../db.js';

export const hashRequest = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

// Idempotency records are claimed *before* the upstream call (state = in_progress)
// so two concurrent requests with the same key can't both reach the case system.
export function createIdempotencyStore(db, { ttlHours = 24, now = Date.now } = {}) {
  const iso = (ms) => new Date(ms).toISOString();

  const getStmt = db.prepare('SELECT * FROM idempotency_keys WHERE principal = ? AND idem_key = ?');
  const delStmt = db.prepare('DELETE FROM idempotency_keys WHERE principal = ? AND idem_key = ?');
  const insStmt = db.prepare(`INSERT INTO idempotency_keys
    (principal, idem_key, method, path, request_hash, state, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`);
  const doneStmt = db.prepare(`UPDATE idempotency_keys
    SET state = 'completed', status_code = ?, response_body = ?, response_headers = ?
    WHERE principal = ? AND idem_key = ?`);
  const purgeStmt = db.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?');

  return {
    // Returns null when the caller should proceed, or the stored response to replay.
    begin(principal, key, { method, path, requestHash }) {
      return tx(db, () => {
        const row = getStmt.get(principal, key);
        if (row && row.expires_at < iso(now())) delStmt.run(principal, key);
        else if (row) {
          if (row.request_hash !== requestHash || row.method !== method || row.path !== path) {
            throw new ApiError('idempotencyMismatch', 'This Idempotency-Key was already used with a different request');
          }
          if (row.state === 'in_progress') {
            throw new ApiError('idempotencyInProgress', 'The original request is still in progress; retry shortly', { headers: { 'Retry-After': '1' } });
          }
          return { status: row.status_code, body: JSON.parse(row.response_body), headers: JSON.parse(row.response_headers ?? '{}') };
        }
        const t = now();
        insStmt.run(principal, key, method, path, requestHash, iso(t), iso(t + ttlHours * 3600_000));
        return null;
      });
    },

    complete(principal, key, status, body, headers = {}) {
      doneStmt.run(status, JSON.stringify(body), JSON.stringify(headers), principal, key);
    },

    // Transient failures release the key so the client can retry with it.
    release(principal, key) {
      delStmt.run(principal, key);
    },

    purgeExpired() {
      return purgeStmt.run(iso(now())).changes;
    },
  };
}
