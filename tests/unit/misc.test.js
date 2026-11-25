import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCursorCodec } from '../../src/services/cursor.js';
import { checkTarget } from '../../src/routes/webhooks.js';
import { openDb } from '../../src/db.js';

test('cursor round-trips and rejects tampering or a different query', () => {
  const c = createCursorCodec('s');
  const tok = c.encode({ q: 'abc', id: 'CS-1' });
  assert.equal(c.decode(tok, 'abc').id, 'CS-1');
  assert.throws(() => c.decode(tok, 'xyz'), /different filter/);
  const [p] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ q: 'abc', id: 'CS-9' })).toString('base64url');
  assert.throws(() => c.decode(`${forged}.${tok.split('.')[1]}`, 'abc'), /tampered/);
  assert.throws(() => c.decode(`${p}`, 'abc'), /tampered/);
});

test('webhook target guard blocks SSRF-style targets outside dev', () => {
  assert.equal(checkTarget('https://hooks.example.com/x', false), null);
  assert.match(checkTarget('http://hooks.example.com/x', false), /https/);
  assert.match(checkTarget('https://10.0.0.5/x', false), /private/);
  assert.match(checkTarget('https://169.254.169.254/latest', false), /private/);
  assert.match(checkTarget('https://localhost/x', false), /private/);
  assert.match(checkTarget('https://user:pw@example.com/', false), /credentials/);
  assert.equal(checkTarget('http://127.0.0.1:4010/x', true), null);
});

test('audit log is append-only at the database level', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO audit_log (at, actor_sub, action, resource_type, outcome) VALUES ('t','a','x','case','success')").run();
  assert.throws(() => db.exec("UPDATE audit_log SET outcome = 'failure'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_log'), /append-only/);
});
