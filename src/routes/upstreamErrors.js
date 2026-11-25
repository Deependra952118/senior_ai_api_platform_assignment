import { ApiError } from '../errors.js';
import { UpstreamError, UpstreamClientError } from '../upstream/httpClient.js';

const LABEL = { cases: 'Case system', entitlements: 'Entitlement system', usage: 'Usage warehouse' };

// Turns adapter errors into problem responses. `notFound` customises the 404 text.
export function toApiError(err, { notFound } = {}) {
  if (err instanceof ApiError) return err;
  if (err instanceof UpstreamClientError) {
    if (err.status === 404) return new ApiError('notFound', notFound ?? 'Not found');
    if (err.status === 412) return new ApiError('preconditionFailed', 'The case changed while the request was being processed; re-read it and retry');
    return new ApiError('upstreamBadResponse', `${LABEL[err.upstream]} rejected the request`, { upstream: { name: err.upstream, reason: 'bad_response' } });
  }
  if (err instanceof UpstreamError) {
    const retry = err.retryAfterSeconds ?? 5;
    const upstream = { name: err.upstream, reason: err.reason };
    if (err.reason === 'timeout') return new ApiError('upstreamTimeout', `${LABEL[err.upstream]} did not respond in time`, { upstream });
    if (err.reason === 'bad_response') return new ApiError('upstreamBadResponse', `${LABEL[err.upstream]} returned an unreadable response`, { upstream });
    return new ApiError('upstreamUnavailable', `${LABEL[err.upstream]} is unavailable`, {
      upstream, retryAfterSeconds: retry, headers: { 'Retry-After': String(retry) },
    });
  }
  return err;
}
