import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// Standard Webhooks signing scheme (https://www.standardwebhooks.com/).
// secret format: whsec_<base64 key>

export function newSecret() {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

function key(secret) {
  return Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
}

export function sign(secret, id, timestamp, body) {
  const mac = createHmac('sha256', key(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

export function verify(secret, headers, rawBody, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_headers' };

  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum) || Math.abs(nowSec - tsNum) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const expected = Buffer.from(sign(secret, id, ts, rawBody).slice(3), 'base64');
  // Several signatures may be present during secret rotation.
  for (const part of sigHeader.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const got = Buffer.from(value, 'base64');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, id };
  }
  return { ok: false, reason: 'bad_signature' };
}
