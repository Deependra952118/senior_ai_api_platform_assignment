import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tx } from '../db.js';

// Local stand-in for Kafka/EventBridge: events are written to the `events` table
// and fanned out into `webhook_deliveries` in the same transaction (outbox pattern),
// then the in-process bus nudges the dispatcher so delivery doesn't wait for the
// next poll. A broker would replace the bus; the tables stay as the durable record.
export function createOutbox(db, { now = Date.now } = {}) {
  const bus = new EventEmitter();
  const insEvent = db.prepare('INSERT INTO events (id, type, aggregate_id, payload, created_at) VALUES (?, ?, ?, ?, ?)');
  const subs = db.prepare("SELECT id, event_types FROM webhook_subscriptions WHERE status = 'active'");
  const insDelivery = db.prepare('INSERT INTO webhook_deliveries (event_id, subscription_id, next_attempt_at) VALUES (?, ?, ?)');

  return {
    bus,
    publish(type, aggregateId, data) {
      const event = { id: `evt_${randomBytes(12).toString('hex')}`, type, createdAt: new Date(now()).toISOString(), data };
      tx(db, () => {
        insEvent.run(event.id, type, aggregateId, JSON.stringify(event), event.createdAt);
        for (const s of subs.all()) {
          if (JSON.parse(s.event_types).includes(type)) insDelivery.run(event.id, s.id, event.createdAt);
        }
      });
      bus.emit('published', event);
      return event;
    },
  };
}
