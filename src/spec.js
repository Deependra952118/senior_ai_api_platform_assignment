// Loads openapi.yaml once and exposes Ajv validators built from it. The same
// validators drive request validation at runtime and response checks in the
// contract tests, so the spec is the single source of truth for shapes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_PATH = path.join(root, 'openapi.yaml');

let cached;

export function loadSpec() {
  if (cached) return cached;
  const doc = YAML.parse(readFileSync(SPEC_PATH, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, useDefaults: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'openapi.json', components: doc.components }, 'openapi.json');

  const operations = new Map();
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op) continue;
      operations.set(op.operationId, { path: p, method, op, params: [...(item.parameters ?? []), ...(op.parameters ?? [])] });
    }
  }
  cached = { doc, ajv, operations };
  return cached;
}

// Rewrites local refs (#/components/...) so they resolve against the registered
// openapi.json schema instead of the schema being compiled.
export function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `openapi.json${v}` : rewriteRefs(v);
    }
    return out;
  }
  return node;
}

export function resolveRef(doc, obj) {
  let cur = obj;
  while (cur && cur.$ref) {
    cur = cur.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], doc);
  }
  return cur;
}

const compiled = new Map();
export function compile(key, schema) {
  if (!compiled.has(key)) {
    const { ajv } = loadSpec();
    compiled.set(key, ajv.compile(rewriteRefs(schema)));
  }
  return compiled.get(key);
}
