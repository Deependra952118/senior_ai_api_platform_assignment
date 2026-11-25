import { jwtVerify, createRemoteJWKSet } from 'jose';
import { ApiError } from '../errors.js';
import { loadSpec } from '../spec.js';

// Verifies the bearer token and builds `res.locals.principal`:
//   sub      - the human user (or service) the request is for
//   agent    - set when an agent acts on the user's behalf (RFC 8693 `act` claim)
//   clientId - OAuth client that obtained the token
//   scopes   - Set of granted scopes
export function authenticate({ issuer, audience, hsSecret, jwksUrl }) {
  const key = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : new TextEncoder().encode(hsSecret);
  const algorithms = jwksUrl ? ['RS256', 'ES256'] : ['HS256'];

  return async (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return next(new ApiError('unauthorized', 'Bearer token required', { headers: { 'WWW-Authenticate': 'Bearer realm="customer-platform"' } }));
    }
    try {
      const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms, clockTolerance: 30 });
      const scopes = new Set(String(payload.scope ?? '').split(' ').filter(Boolean));
      res.locals.principal = {
        sub: payload.sub,
        agent: payload.act?.sub ?? null,
        clientId: payload.client_id ?? payload.azp ?? null,
        scopes,
      };
      next();
    } catch (err) {
      req.log?.info({ reason: err.code }, 'token rejected');
      next(new ApiError('unauthorized', 'Token is invalid or expired', { headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } }));
    }
  };
}

// Required scopes come from the operation's `security` block in openapi.yaml.
export function authorize(operationId) {
  const { operations } = loadSpec();
  const op = operations.get(operationId)?.op;
  if (!op) throw new Error(`unknown operation ${operationId}`);
  const required = (op.security ?? []).flatMap((s) => s.oauth2 ?? []);

  return (req, res, next) => {
    const { scopes } = res.locals.principal;
    const missing = required.filter((s) => !scopes.has(s));
    if (missing.length) {
      return next(new ApiError('forbidden', `This operation requires scope ${missing.join(' ')}`, { requiredScopes: required }));
    }
    next();
  };
}

export function principalKey(p) {
  return p.agent ? `${p.sub}|agent:${p.agent}` : p.sub;
}
