const express = require('express');
const { db, get } = require('../util');
const { verifyPassword, createSession, destroySession, getUserFromToken, getUserCrews } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  const pwd = String(password || '');
  if (!uname || !pwd) return res.status(400).json({ error: 'username and password required' });
  const user = db.prepare('SELECT * FROM user WHERE lower(username) = lower(?)').get(uname);
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid credentials' });
  if (!verifyPassword(pwd, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
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
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) destroySession(token);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const crews = getUserCrews(user);
  user.crew_id = crews.length ? crews[0].id : null;
  user.crew_ids = crews.map((c) => c.id);
  user.region = user.region_id ? get('region', user.region_id) : null;
  res.json({ user });
});

module.exports = router;
