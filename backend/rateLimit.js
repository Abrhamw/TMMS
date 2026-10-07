'use strict';

const { AppError } = require('./errors');

class SlidingWindowLimiter {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 15 * 60 * 1000;
    this.max = opts.max || 10;
    this.blockBaseMs = opts.blockBaseMs || this.windowMs;
    this.maxBlockMs = opts.maxBlockMs || 60 * 60 * 1000;
    this.entries = new Map();
  }

  retryAfterMs(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (entry.blockedUntil && entry.blockedUntil > now) return entry.blockedUntil - now;
    return 0;
  }

  check(key, now = Date.now()) {
    this.prune(now);
    const retry = this.retryAfterMs(key, now);
    return retry > 0 ? Math.ceil(retry / 1000) : 0;
  }

  fail(key, now = Date.now()) {
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + this.windowMs, fails: 0, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count > this.max) {
      entry.fails += 1;
      const blockMs = Math.min(this.blockBaseMs * Math.pow(2, entry.fails - 1), this.maxBlockMs);
      entry.blockedUntil = now + blockMs;
    }
    this.entries.set(key, entry);
    return this.check(key, now);
  }

  succeed(key) {
    this.entries.delete(key);
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      const expired = entry.resetAt <= now && (!entry.blockedUntil || entry.blockedUntil <= now);
      if (expired) this.entries.delete(key);
    }
  }
}

function rateLimit(opts = {}) {
  const limiter = new SlidingWindowLimiter(opts);
  const keyFn = opts.keyFn || ((req) => req.ip);
  const message = opts.message || 'Too many requests. Please try again later.';
  return (req, res, next) => {
    const key = keyFn(req);
    if (key === undefined || key === null || key === '') return next();
    const retry = limiter.check(key);
    if (retry > 0) {
      res.setHeader('Retry-After', String(retry));
      return next(new AppError('TOO_MANY_REQUESTS', message));
    }
    limiter.fail(key);
    return next();
  };
}

const loginLimiter = new SlidingWindowLimiter({ windowMs: 15 * 60 * 1000, max: 5, blockBaseMs: 30 * 1000, maxBlockMs: 30 * 60 * 1000 });

// Coarse safety net over the whole API: a generous per-IP ceiling that stops a
// single client from monopolising the process, configurable for tests/deploys.
function apiLimiterFromEnv(env = process.env) {
  return rateLimit({
    windowMs: Number(env.TMMS_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    max: Number(env.TMMS_RATE_LIMIT_MAX) || 600,
    blockBaseMs: 30 * 1000,
    maxBlockMs: 5 * 60 * 1000,
    keyFn: (req) => req.ip,
    message: 'Too many API requests. Please slow down and retry shortly.',
  });
}

module.exports = { SlidingWindowLimiter, rateLimit, loginLimiter, apiLimiterFromEnv };
