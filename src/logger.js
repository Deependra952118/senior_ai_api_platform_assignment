import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'customer-platform-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', '*.secret', 'secret'],
      censor: '[redacted]',
    },
  });
}
