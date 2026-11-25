import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Schema for the data this service owns. Upstream data (cases, accounts, usage)
// is never copied here; see DECISIONS.md "Data model".
const MIGRATIONS = [
  `
  CREATE TABLE idempotency_keys (
    principal       TEXT NOT NULL,
    idem_key        TEXT NOT NULL,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
    status_code     INTEGER,
    response_body   TEXT,
    response_headers TEXT,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    PRIMARY KEY (principal, idem_key)
  );
  CREATE INDEX idx_idem_expires ON idempotency_keys (expires_at);

  CREATE TABLE audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              TEXT NOT NULL,
    correlation_id  TEXT,
    actor_sub       TEXT NOT NULL,
    agent_id        TEXT,
    client_id       TEXT,
    action          TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    resource_id     TEXT,
    outcome         TEXT NOT NULL,
    http_status     INTEGER,
    details         TEXT
  );
  CREATE INDEX idx_audit_resource ON audit_log (resource_type, resource_id, at);
  CREATE INDEX idx_audit_actor ON audit_log (actor_sub, at);
  CREATE INDEX idx_audit_agent ON audit_log (agent_id, at) WHERE agent_id IS NOT NULL;
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  CREATE TABLE webhook_subscriptions (
    id           TEXT PRIMARY KEY,
    url          TEXT NOT NULL,
    secret       TEXT NOT NULL,
    event_types  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE events (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    aggregate_id  TEXT NOT NULL,
    payload       TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_events_aggregate ON events (aggregate_id, created_at);

  CREATE TABLE webhook_deliveries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id         TEXT NOT NULL REFERENCES events(id),
    subscription_id  TEXT NOT NULL REFERENCES webhook_subscriptions(id),
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT NOT NULL,
    last_status_code INTEGER,
    last_error       TEXT,
    delivered_at     TEXT,
    UNIQUE (event_id, subscription_id)
  );
  CREATE INDEX idx_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
  `,
];

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  let current = row?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
