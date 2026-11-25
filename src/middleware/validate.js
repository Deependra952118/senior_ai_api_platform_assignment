import { ApiError } from '../errors.js';
import { loadSpec, compile, resolveRef } from '../spec.js';

// Headers whose absence the route maps to a more specific error (428 for If-Match).
const ROUTE_HANDLED_HEADERS = new Set(['if-match']);

// Builds a validator for one operation straight from openapi.yaml. Parsed values
// end up in req.valid = { params, query, headers, body }.
export function validate(operationId) {
  const { doc, operations } = loadSpec();
  const entry = operations.get(operationId);
  if (!entry) throw new Error(`unknown operation ${operationId}`);

  const params = entry.params.map((p) => resolveRef(doc, p));
  const queryNames = new Set(params.filter((p) => p.in === 'query').map((p) => p.name));
  const bodySchema = entry.op.requestBody?.content?.['application/json']?.schema;
  const bodyValidator = bodySchema && compile(`${operationId}:body`, bodySchema);

  return (req, _res, next) => {
    const errors = [];
    const out = { params: {}, query: {}, headers: {}, body: undefined };

    for (const name of Object.keys(req.query ?? {})) {
      if (!queryNames.has(name)) errors.push({ in: 'query', name, message: 'unknown query parameter' });
    }

    for (const p of params) {
      const schema = resolveRef(doc, p.schema);
      let raw;
      if (p.in === 'path') raw = req.params[p.name];
      else if (p.in === 'query') raw = req.query[p.name];
      else if (p.in === 'header') raw = req.get(p.name);

      if (raw === undefined || raw === '') {
        if (p.required && !(p.in === 'header' && ROUTE_HANDLED_HEADERS.has(p.name.toLowerCase()))) {
          errors.push({ in: p.in, name: p.name, message: 'is required' });
        } else if (schema?.default !== undefined) {
          out[bucket(p.in)][p.name] = schema.default;
        }
        continue;
      }

      const value = coerce(raw, schema);
      const v = compile(`${operationId}:${p.in}:${p.name}`, p.schema);
      if (!v(value)) {
        errors.push(...v.errors.map((e) => ({ in: p.in, name: p.name, message: describe(e) })));
      } else {
        out[bucket(p.in)][p.name] = value;
      }
    }

    if (bodyValidator) {
      if (!req.is('application/json') || req.body === undefined) {
        errors.push({ in: 'body', message: 'JSON body required (Content-Type: application/json)' });
      } else if (!bodyValidator(req.body)) {
        errors.push(...bodyValidator.errors.map((e) => ({ in: 'body', pointer: e.instancePath || '/', message: describe(e) })));
      } else {
        out.body = req.body;
      }
    }

    if (errors.length) {
      return next(new ApiError('validation', `${errors.length} validation error${errors.length > 1 ? 's' : ''}`, { errors }));
    }
    req.valid = out;
    next();
  };
}

const bucket = (where) => ({ path: 'params', query: 'query', header: 'headers' })[where];

function coerce(raw, schema) {
  if (Array.isArray(raw)) raw = raw.join(',');
  if (schema?.type === 'array') return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (schema?.type === 'integer' && /^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function describe(e) {
  if (e.keyword === 'enum') return `must be one of: ${e.params.allowedValues.join(', ')}`;
  if (e.keyword === 'additionalProperties') return `unknown property '${e.params.additionalProperty}'`;
  const where = e.instancePath ? `${e.instancePath} ` : '';
  return `${where}${e.message}`;
}
