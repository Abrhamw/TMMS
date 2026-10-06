const express = require('express');
const { db, get } = require('../util');
const { verifyPassword, createSession, destroySession, getUserFromToken, getUserCrews, revokeUserSessions } = require('../auth');
const { loginLimiter } = require('../rateLimit');
const { validateBody } = require('../validation');
const { AppError } = require('../errors');

const router = express.Router();

const loginSchema = {
  username: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 150 },
  password: { type: 'string', required: true, minLength: 1, maxLength: 200 },
};

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

router.post('/login', validateBody(loginSchema), (req, res, next) => {
  const { username, password } = req.body;
  const keys = [`ip:${clientIp(req)}`, `user:${username.toLowerCase()}`];
  for (const key of keys) {
    const retry = loginLimiter.check(key);
    if (retry > 0) {
      res.setHeader('Retry-After', String(retry));
      return next(new AppError('TOO_MANY_REQUESTS', `Too many failed sign-in attempts. Try again in ${retry}s.`));
    }
  }
  const user = db.prepare('SELECT * FROM user WHERE lower(username) = lower(?)').get(username);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    for (const key of keys) loginLimiter.fail(key);
    return res.status(401).json({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
  }
  for (const key of keys) loginLimiter.succeed(key);
  const token = createSession(user.id);
  const out = db.prepare(
    `SELECT u.id, u.username, u.role, u.region_id, u.person_id, p.first_name, p.last_name, p.title, p.email
     FROM user u LEFT JOIN person p ON p.id = u.person_id WHERE u.id = ?`
  ).get(user.id);
  const crews = getUserCrews(out);
  out.crew_id = crews.length ? crews[0].id : null;
  out.crew_ids = crews.map((c) => c.id);
  res.json({ token, user: out });
});

router.post('/logout', (req, res) => {
  const token = bearer(req);
  if (token) destroySession(token);
  res.json({ ok: true });
});

router.post('/logout-all', (req, res) => {
  const user = getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  const revoked = revokeUserSessions(user.id);
  res.json({ ok: true, revoked });
});

router.get('/me', (req, res) => {
  const user = getUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  const crews = getUserCrews(user);
  user.crew_id = crews.length ? crews[0].id : null;
  user.crew_ids = crews.map((c) => c.id);
  user.region = user.region_id ? get('region', user.region_id) : null;
  res.json({ user });
});

module.exports = router;
