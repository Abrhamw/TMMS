'use strict';

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
].join('; ');

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'Admin@123' },
  { username: 'ceo', password: 'Executive@123' },
  { username: 'exec.tbu', password: 'Executive@123' },
  { username: 'dir.c1', password: 'Region@123' },
  { username: 'mgr.c1.som', password: 'Manager@123' },
  { username: 'ayu', password: 'Crew@123' },
];

function securityHeaders(opts = {}) {
  const production = opts.production === true;
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

function findDemoCredentials(db, verifyPassword) {
  const found = [];
  for (const account of DEMO_ACCOUNTS) {
    const row = db.prepare('SELECT id, username, password_hash, active FROM user WHERE lower(username) = lower(?)').get(account.username);
    if (!row) continue;
    let matches = false;
    try {
      matches = verifyPassword(account.password, row.password_hash);
    } catch (_) {
      matches = false;
    }
    if (matches) found.push(row.username);
  }
  return found;
}

function assertProductionSecrets(opts = {}) {
  const env = opts.env || process.env;
  if (env.NODE_ENV !== 'production') return;
  if (env.TMMS_ALLOW_DEMO_SEED === '1') return;
  const { db } = opts.db ? { db: opts.db } : require('./db');
  const { verifyPassword } = opts.verifyPassword ? { verifyPassword: opts.verifyPassword } : require('./auth');
  const demo = findDemoCredentials(db, verifyPassword);
  if (demo.length) {
    throw new Error(
      `Production startup refused: seeded demo credentials are still active (${demo.join(', ')}). ` +
      'Rotate these accounts or set TMMS_ALLOW_DEMO_SEED=1 to override deliberately.'
    );
  }
}

module.exports = { securityHeaders, assertProductionSecrets, findDemoCredentials, CSP, DEMO_ACCOUNTS };
