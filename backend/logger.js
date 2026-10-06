'use strict';

const crypto = require('node:crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

let sink = (line) => process.stdout.write(line);

function write(level, msg, fields) {
  if ((LEVELS[level] || LEVELS.info) < threshold) return;
  const record = { ts: new Date().toISOString(), level, msg, ...fields };
  try {
    sink(`${JSON.stringify(record)}\n`);
  } catch (_) {
    /* logging must never crash a request */
  }
}

const logger = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
  setSink(fn) { sink = fn; },
};

const MAX_SAMPLES = 500;
const metrics = {
  requests: 0,
  errors: 0,
  byStatus: new Map(),
  byMethod: new Map(),
  durations: [],
  startedAt: Date.now(),
  observe(fields) {
    this.requests += 1;
    if (fields.status >= 500) this.errors += 1;
    this.byStatus.set(fields.status, (this.byStatus.get(fields.status) || 0) + 1);
    this.byMethod.set(fields.method, (this.byMethod.get(fields.method) || 0) + 1);
    this.durations.push(fields.duration_ms);
    if (this.durations.length > MAX_SAMPLES) this.durations.shift();
  },
  percentile(p) {
    if (!this.durations.length) return 0;
    const sorted = [...this.durations].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  },
  snapshot() {
    return {
      requests: this.requests,
      errors_5xx: this.errors,
      by_status: Object.fromEntries(this.byStatus),
      by_method: Object.fromEntries(this.byMethod),
      latency_ms: { p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99) },
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
    };
  },
};

function requestContext() {
  return (req, res, next) => {
    const id = req.headers['x-request-id'] || crypto.randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1e6;
      const fields = {
        request_id: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(duration * 100) / 100,
      };
      if (req.user) fields.user_id = req.user.id;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      write(level, 'request', fields);
      metrics.observe(fields);
    });
    next();
  };
}

module.exports = { logger, metrics, requestContext, LEVELS };
