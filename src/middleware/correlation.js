import { randomUUID } from 'node:crypto';

const VALID = /^[A-Za-z0-9._-]{8,64}$/;

export function correlation() {
  return (req, res, next) => {
    const incoming = req.get('x-correlation-id');
    const id = incoming && VALID.test(incoming) ? incoming : randomUUID();
    res.locals.correlationId = id;
    res.setHeader('X-Correlation-Id', id);
    next();
  };
}
