'use strict';

const { db } = require('./db');
const { logger } = require('./logger');

const LEASE_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

const handlers = new Map();
const recurring = [];
let worker = null;
let stopped = true;
const workerId = `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function registerHandler(kind, fn) {
  handlers.set(kind, fn);
}

function registerRecurring(kind, everyMs, payloadFn) {
  recurring.push({ kind, everyMs, payloadFn, last: 0 });
}

function enqueue(kind, payload, opts = {}) {
  const now = Date.now();
  const availableAt = new Date(now + (opts.delayMs || 0)).toISOString();
  const dedupeKey = opts.dedupeKey || null;
  try {
    if (dedupeKey) {
      const existing = db.prepare(
        "SELECT id FROM job WHERE dedupe_key = ? AND status IN ('QUEUED','RUNNING','RETRY_WAIT')"
      ).get(dedupeKey);
      if (existing) return existing.id;
    }
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO job (kind, dedupe_key, payload, status, priority, attempts, max_attempts, available_at, created_at)
       VALUES (?, ?, ?, 'QUEUED', ?, 0, ?, ?, ?)`
    ).run(kind, dedupeKey, payload === undefined ? null : JSON.stringify(payload), opts.priority || 0, opts.maxAttempts || 5, availableAt, new Date(now).toISOString());
    logger.info('job.enqueued', { job_id: Number(lastInsertRowid), kind });
    return Number(lastInsertRowid);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) return null;
    throw err;
  }
}

function claim() {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  const row = db.prepare(
    `UPDATE job
       SET status = 'RUNNING', locked_until = ?, locked_by = ?, attempts = attempts + 1,
           started_at = COALESCE(started_at, ?)
     WHERE id = (
       SELECT id FROM job
        WHERE status IN ('QUEUED', 'RETRY_WAIT') AND available_at <= ?
        ORDER BY priority DESC, id ASC LIMIT 1
     )
     AND status IN ('QUEUED', 'RETRY_WAIT')
     RETURNING *`
  ).get(lockUntil, workerId, now.toISOString(), now.toISOString());
  return row || null;
}

function recoverStuck() {
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE job SET status = 'RETRY_WAIT', locked_by = NULL, locked_until = NULL, available_at = ? WHERE status = 'RUNNING' AND locked_until <= ?"
  ).run(now, now);
  return result.changes || 0;
}

async function runOnce() {
  const job = claim();
  if (!job) return false;
  const handler = handlers.get(job.kind);
  const started = Date.now();
  try {
    if (!handler) throw new Error(`No handler registered for job kind '${job.kind}'`);
    const payload = job.payload ? JSON.parse(job.payload) : undefined;
    await handler(payload, job);
    db.prepare("UPDATE job SET status = 'SUCCEEDED', finished_at = ?, locked_by = NULL, locked_until = NULL, last_error = NULL WHERE id = ?")
      .run(new Date().toISOString(), job.id);
    logger.info('job.succeeded', { job_id: job.id, kind: job.kind, duration_ms: Date.now() - started });
  } catch (err) {
    const dead = job.attempts >= job.max_attempts;
    const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, Math.max(0, job.attempts - 1)), MAX_BACKOFF_MS);
    db.prepare(
      "UPDATE job SET status = ?, available_at = ?, locked_by = NULL, locked_until = NULL, last_error = ? WHERE id = ?"
    ).run(dead ? 'DEAD' : 'RETRY_WAIT', new Date(Date.now() + backoffMs).toISOString(), String(err && err.message ? err.message : err).slice(0, 500), job.id);
    logger[dead ? 'error' : 'warn']('job.failed', { job_id: job.id, kind: job.kind, attempts: job.attempts, dead, error: String(err && err.message ? err.message : err) });
  }
  return true;
}

function dueRecurring(now = Date.now()) {
  for (const entry of recurring) {
    if (now - entry.last < entry.everyMs) continue;
    entry.last = now;
    try {
      const payload = entry.payloadFn ? entry.payloadFn() : undefined;
      enqueue(entry.kind, payload, { dedupeKey: `${entry.kind}:${Math.floor(now / entry.everyMs)}` });
    } catch (err) {
      logger.error('job.recurring_error', { kind: entry.kind, error: String(err && err.message ? err.message : err) });
    }
  }
}

function startWorker(opts = {}) {
  if (worker) return;
  stopped = false;
  const interval = opts.intervalMs || 2000;
  const batch = opts.batch || 5;
  const recovered = recoverStuck();
  if (recovered) logger.warn('job.recovered', { count: recovered });
  const tick = async () => {
    if (stopped) return;
    let ran = false;
    try {
      dueRecurring();
      for (let i = 0; i < batch; i += 1) {
        const did = await runOnce();
        if (!did) break;
        ran = true;
      }
    } catch (err) {
      logger.error('job.worker_error', { error: String(err && err.message ? err.message : err) });
    }
    if (!stopped) worker = setTimeout(tick, ran ? 0 : interval);
  };
  worker = setTimeout(tick, interval);
}

async function stopWorker() {
  stopped = true;
  if (worker) {
    clearTimeout(worker);
    worker = null;
  }
}

function stats() {
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM job GROUP BY status').all();
  const out = {};
  for (const row of rows) out[row.status] = row.c;
  return out;
}

async function drain(maxRuns = 1000) {
  let runs = 0;
  while (runs < maxRuns) {
    const did = await runOnce();
    if (!did) break;
    runs += 1;
  }
  return runs;
}

module.exports = {
  registerHandler,
  registerRecurring,
  enqueue,
  claim,
  recoverStuck,
  runOnce,
  startWorker,
  stopWorker,
  dueRecurring,
  stats,
  drain,
  workerId,
};
