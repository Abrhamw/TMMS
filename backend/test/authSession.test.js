process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-auth-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema, db } = require('../db');
initSchema();

const auth = require('../auth');

const NOW = new Date().toISOString();
const userId = db.prepare(
  'INSERT INTO user (username, password_hash, role, active, created_at) VALUES (?,?,?,?,?)'
).run('sess-user', auth.hashPassword('Secret@123'), 'VIEWER', 1, NOW).lastInsertRowid;

test('new sessions persist only a token hash', () => {
  const raw = auth.createSession(Number(userId));
  const row = db.prepare('SELECT token FROM session WHERE user_id = ?').get(userId);

  assert.notStrictEqual(row.token, raw);
  assert.strictEqual(row.token, auth.hashToken(raw));
  assert.strictEqual(Buffer.from(row.token, 'hex').length, 32);
  assert.strictEqual(auth.getUserFromToken(raw).id, Number(userId));
  assert.strictEqual(auth.getUserFromToken('not-a-real-token'), null);

  auth.destroySession(raw);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM session').get().c, 0);
});

test('migrateSessionTokens hashes legacy plaintext 64-hex tokens exactly once', () => {
  const legacy = 'a'.repeat(64);
  db.prepare('INSERT INTO session (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(legacy, userId, NOW, new Date(Date.now() + 3600000).toISOString());

  assert.strictEqual(auth.migrateSessionTokens(), true);
  const migrated = db.prepare('SELECT token FROM session WHERE user_id = ?').get(userId);
  assert.strictEqual(migrated.token, auth.hashToken(legacy));
  assert.notStrictEqual(migrated.token, legacy);
  assert.strictEqual(auth.getUserFromToken(legacy).id, Number(userId));

  assert.strictEqual(auth.migrateSessionTokens(), false);
  assert.strictEqual(db.prepare('SELECT token FROM session WHERE user_id = ?').get(userId).token, auth.hashToken(legacy));
});
