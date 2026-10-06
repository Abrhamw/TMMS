const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const gzip = require('./gzip');
const { db, initSchema, appliedMigrations } = require('./db');
const { seedEep, reconcileSeedData } = require('./seed_eep');
const { ensureAssetCatalog, ensureRegisterDemo, ensureCatalogPrices } = require('./assetCatalog');
const { backfill, ensureStandardChecklists, ensureWorkbookChecklists, ensureReportTemplates, ensureCostDemo } = require('./seed');
const { requireAuth, auditMiddleware } = require('./auth');
const { seedTowerComponentStandards } = require('./towerStandards');
const { reconcileAll } = require('./integrity');
const { securityHeaders, assertProductionSecrets } = require('./security');
const { requestContext, logger, metrics } = require('./logger');
const { AppError, isAppError, errorPayload } = require('./errors');
const { stripImmutable } = require('./validation');
const { rateLimit } = require('./rateLimit');
const jobs = require('./jobs');

const DB_PATH = process.env.TMMS_DB || path.join(__dirname, 'tmms.db');
const JSON_LIMIT = process.env.TMMS_JSON_LIMIT || '12mb';
const PRODUCTION = process.env.NODE_ENV === 'production';

function ensureSeeded() {
  if (!fs.existsSync(DB_PATH)) {
    initSchema();
    seedEep();
    return;
  }
  initSchema();
  const count = db.prepare('SELECT COUNT(*) c FROM region').get().c;
  if (count === 0) seedEep();
}

ensureSeeded();
backfill();
ensureStandardChecklists();
ensureWorkbookChecklists();
ensureReportTemplates();
const { migrateRolesAndCrewUsers } = require('./rolesMigrate');
reconcileSeedData();
migrateRolesAndCrewUsers();
ensureAssetCatalog();
ensureRegisterDemo();
ensureCostDemo();
ensureCatalogPrices();
seedTowerComponentStandards();
try {
  logger.info('infrastructure_reconciled', { result: reconcileAll() });
} catch (err) {
  logger.error('reconcile_failed', { error: err.message });
}
assertProductionSecrets();

const app = express();
app.disable('x-powered-by');
app.use(requestContext());
app.use(securityHeaders({ production: PRODUCTION }));
app.use(gzip);
app.use(express.json({ limit: JSON_LIMIT }));
app.use(stripImmutable);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'tmms-backend', time: new Date().toISOString() });
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', service: 'tmms-backend', time: new Date().toISOString() });
});

app.get('/readyz', (req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({
      status: 'ok',
      db: 'ok',
      migrations: appliedMigrations().length,
      jobs: jobs.stats(),
      metrics: metrics.snapshot(),
    });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', db: 'error', error: err.message });
  }
});

app.get('/api/metrics', requireAuth, (req, res) => {
  if (!req.user || req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  res.json({ metrics: metrics.snapshot(), jobs: jobs.stats() });
});

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, keyFn: (req) => req.ip, message: 'Too many authentication requests. Try again later.' }), require('./routes/auth'));

app.use('/api', requireAuth, auditMiddleware);
app.use('/api', require('./routes/dashboard'));
const mailboxRouter = require('./routes/mailbox');
app.use('/api', mailboxRouter);
app.use('/api', require('./routes/core'));
app.use('/api', require('./routes/org'));
app.use('/api', require('./routes/home'));
app.use('/api', require('./routes/comments'));
app.use('/api', require('./routes/assets'));
app.use('/api', require('./routes/crews'));
app.use('/api', require('./routes/tasks'));
app.use('/api', require('./routes/labor'));
app.use('/api', require('./routes/attachments').router);
app.use('/api', require('./routes/schedules'));
app.use('/api', require('./routes/checklists'));
app.use('/api', require('./routes/performance'));
app.use('/api', require('./routes/gps'));
const reportsRouter = require('./routes/reports');
app.use('/api', reportsRouter);
app.use('/api', require('./routes/map'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/catalog'));
app.use('/api', require('./routes/register'));
app.use('/api', require('./routes/infrastructure'));
app.use('/api', require('./routes/search'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json(errorPayload(new AppError('PAYLOAD_TOO_LARGE', 'Request body too large'), req.id));
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json(errorPayload(new AppError('BAD_REQUEST', 'Malformed JSON body'), req.id));
  }
  if (!isAppError(err)) {
    logger.error('unhandled_error', {
      request_id: req.id,
      error: err && err.message,
      stack: PRODUCTION ? undefined : (err && err.stack),
    });
  }
  const status = isAppError(err) ? err.status : 500;
  res.status(status).json(errorPayload(err, req.id));
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  logger.info('server_listening', { port: PORT, production: PRODUCTION, worker: jobs.workerId });
});

const { runGeneration } = require('./scheduler');
jobs.registerHandler('scheduler.generate', () => runGeneration());
jobs.registerHandler('mailbox.outbox', () => mailboxRouter.processOutbox());
jobs.registerHandler('reports.schedules', () => reportsRouter.runReportSchedules());
jobs.registerHandler('reports.assetMonitor', () => {
  const result = reportsRouter.runAssetMonitor();
  if (result && result.changed) logger.info('asset_monitor', result);
});

jobs.registerRecurring('scheduler.generate', 6 * 3600 * 1000);
jobs.registerRecurring('mailbox.outbox', 60 * 1000);
jobs.registerRecurring('reports.schedules', 5 * 60 * 1000);
jobs.registerRecurring('reports.assetMonitor', 6 * 3600 * 1000);
jobs.startWorker({ intervalMs: 2000 });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal });
  const force = setTimeout(() => {
    logger.error('shutdown_forced', { signal });
    process.exit(1);
  }, 15000);
  force.unref();
  server.close(async () => {
    try { await jobs.stopWorker(); } catch (_) { /* non-fatal */ }
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) { /* non-fatal */ }
    try { db.close(); } catch (_) { /* non-fatal */ }
    logger.info('shutdown_complete', { signal });
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
