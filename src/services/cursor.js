import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.js';

// Opaque keyset cursor: base64url(JSON).signature. Bound to the filter/sort hash so
// a cursor from one query can't be replayed against another.
export function createCursorCodec(secret) {
  const mac = (s) => createHmac('sha256', secret).update(s).digest('base64url').slice(0, 22);

  return {
    encode(data) {
      const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
      return `${payload}.${mac(payload)}`;
    },
    decode(cursor, expectedQueryHash) {
      const [payload, sig] = String(cursor).split('.');
      const ok = payload && sig && sig.length === 22 && timingSafeEqual(Buffer.from(sig), Buffer.from(mac(payload)));
      if (!ok) throw invalid('cursor is malformed or was tampered with');
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (data.q !== expectedQueryHash) throw invalid('cursor was issued for a different filter or sort');
      return data;
    },
  };
}

const invalid = (message) => new ApiError('validation', message, { errors: [{ in: 'query', name: 'cursor', message }] });
