import { sign } from './signature.js';

export const BACKOFF_SECONDS = [10, 30, 120, 600, 3600, 21600];

export function createDispatcher(db, { logger, timeoutMs = 5000, now = Date.now, outbox } = {}) {
  const due = db.prepare(`
    SELECT d.id, d.attempts, e.id AS event_id, e.payload, s.url, s.secret
    FROM webhook_deliveries d
    JOIN events e ON e.id = d.event_id
    JOIN webhook_subscriptions s ON s.id = d.subscription_id
    WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND s.status = 'active'
    ORDER BY d.next_attempt_at
    LIMIT 20`);
  const ok = db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_status_code = ?, delivered_at = ?, last_error = NULL WHERE id = ?");
  const retry = db.prepare('UPDATE webhook_deliveries SET status = ?, attempts = attempts + 1, last_status_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?');

  let running = false;

  async function deliver(row) {
    const ts = String(Math.floor(now() / 1000));
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'customer-platform-webhooks/1.0',
          'webhook-id': row.event_id,
          'webhook-timestamp': ts,
          'webhook-signature': sign(row.secret, row.event_id, ts, row.payload),
        },
        body: row.payload,
        redirect: 'manual', // don't let a 30x bounce the payload somewhere else
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 200 && res.status < 300) {
        ok.run(res.status, new Date(now()).toISOString(), row.id);
        logger?.info({ eventId: row.event_id, deliveryId: row.id, status: res.status }, 'webhook delivered');
        return;
      }
      fail(row, res.status, `HTTP ${res.status}`);
    } catch (err) {
      fail(row, null, err.name === 'TimeoutError' ? 'timeout' : err.message);
    }
  }

  function fail(row, status, error) {
    const attempts = row.attempts + 1;
    const dead = attempts > BACKOFF_SECONDS.length;
    const next = new Date(now() + (BACKOFF_SECONDS[attempts - 1] ?? 0) * 1000).toISOString();
    retry.run(dead ? 'dead' : 'pending', status, error, next, row.id);
    logger?.warn({ eventId: row.event_id, deliveryId: row.id, attempts, error, dead }, 'webhook delivery failed');
  }

  async function runOnce() {
    if (running) return 0;
    running = true;
    try {
      const rows = due.all(new Date(now()).toISOString());
      await Promise.all(rows.map(deliver));
      return rows.length;
    } finally {
      running = false;
    }
  }

  let timer;
  const onPublish = () => setImmediate(runOnce);
  return {
    runOnce,
    start(intervalMs) {
      timer = setInterval(runOnce, intervalMs);
      timer.unref();
      outbox?.bus.on('published', onPublish);
    },
    stop() {
      clearInterval(timer);
      outbox?.bus.off('published', onPublish);
    },
  };
}
