process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-security-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema, db } = require('../db');
initSchema();

const { assertProductionSecrets, findDemoCredentials } = require('../security');
const { hashPassword, verifyPassword, createSession } = require('../auth');
const { rotate } = require('../scripts/rotateCredentials');

const NOW = new Date().toISOString();
function insertUser(username, password, role = 'VIEWER') {
  return Number(db.prepare('INSERT INTO user (username, password_hash, role, active, created_at) VALUES (?,?,?,?,?)')
    .run(username, hashPassword(password), role, 1, NOW).lastInsertRowid);
}

test('findDemoCredentials matches only known demo credentials', () => {
  insertUser('admin', 'Admin@123', 'ADMIN');
  insertUser('not-demo', 'Admin@123');
  assert.deepStrictEqual(findDemoCredentials(db, verifyPassword), ['admin']);
});

test('assertProductionSecrets refuses live demo credentials unless overridden', () => {
  assert.throws(
    () => assertProductionSecrets({ env: { NODE_ENV: 'production' }, db, verifyPassword }),
    /demo credentials/
  );
  assert.doesNotThrow(() => assertProductionSecrets({ env: { NODE_ENV: 'production', TMMS_ALLOW_DEMO_SEED: '1' }, db, verifyPassword }));
  assert.doesNotThrow(() => assertProductionSecrets({ env: { NODE_ENV: 'development' }, db, verifyPassword }));
});

test('rotate replaces the password, revokes sessions and generates one when omitted', () => {
  const userId = insertUser('rotate-me', 'Old@123', 'REGION_MANAGER');
  createSession(userId);
  createSession(userId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM session WHERE user_id = ?').get(userId).c, 2);

  const result = rotate('rotate-me', 'NewPass!23');
  assert.strictEqual(result.status, 'rotated');
  assert.strictEqual(result.sessions_revoked, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM session WHERE user_id = ?').get(userId).c, 0);
  const row = db.prepare('SELECT password_hash FROM user WHERE id = ?').get(userId);
  assert.strictEqual(verifyPassword('NewPass!23', row.password_hash), true);
  assert.strictEqual(verifyPassword('Old@123', row.password_hash), false);

  const generated = rotate('rotate-me');
  assert.strictEqual(generated.status, 'rotated');
  assert.ok(typeof generated.password === 'string' && generated.password.length >= 20);
  assert.strictEqual(rotate('missing-user').status, 'not-found');
});
