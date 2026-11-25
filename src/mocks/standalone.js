import { createMockUpstreams } from './upstreamServer.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel).child({ component: 'mock-upstreams' });
const { app } = createMockUpstreams({ timeShift: config.mocks.timeShift, webhookSecret: config.webhooks.devSubscriberSecret, logger });
app.listen(config.mocks.port, '0.0.0.0', () => logger.info({ port: config.mocks.port }, 'mock upstreams listening'));
