import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDb } from './db.js';
import { createApp, seedDevSubscription } from './app.js';
import { createMockUpstreams } from './mocks/upstreamServer.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const servers = [];

if (config.mocks.embedded) {
  const mocks = createMockUpstreams({ timeShift: config.mocks.timeShift, webhookSecret: config.webhooks.devSubscriberSecret, logger: logger.child({ component: 'mock-upstreams' }) });
  servers.push(mocks.app.listen(config.mocks.port, '127.0.0.1', () => logger.info({ port: config.mocks.port }, 'mock upstreams listening')));
}

const db = openDb(config.dbPath);
seedDevSubscription(db, { url: config.webhooks.devSubscriberUrl, secret: config.webhooks.devSubscriberSecret });
const { app, dispatcher, services } = createApp({ config, logger, db });
dispatcher.start(config.webhooks.dispatchIntervalMs);
const purge = setInterval(() => services.idempotency.purgeExpired(), 3600_000).unref();

servers.push(app.listen(config.port, () => logger.info({ port: config.port }, 'customer platform API listening')));

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  dispatcher.stop();
  clearInterval(purge);
  let open = servers.length;
  for (const s of servers) s.close(() => { if (--open === 0) { db.close(); process.exit(0); } });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
