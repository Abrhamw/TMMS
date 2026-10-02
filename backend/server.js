const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const gzip = require('./gzip');
const { db, initSchema, writeAudit } = require('./db');
const { seedEep, reconcileSeedData } = require('./seed_eep');
const { ensureAssetCatalog, ensureRegisterDemo, ensureCatalogPrices } = require('./assetCatalog');
const { backfill, ensureStandardChecklists, ensureWorkbookChecklists, ensureReportTemplates, ensureCostDemo } = require('./seed');
const { requireAuth, auditMiddleware } = require('./auth');
const { seedTowerComponentStandards } = require('./towerStandards');
const { reconcileAll } = require('./integrity');

const DB_PATH = process.env.TMMS_DB || path.join(__dirname, 'tmms.db');

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
  console.log('Reconciled infrastructure counts:', reconcileAll());
} catch (e) {
  console.error('Startup reconcile failed (continuing):', e.message);
}

const app = express();
app.use(gzip);
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'tmms-backend', time: new Date().toISOString() });
});

app.use('/api/auth', require('./routes/auth'));

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
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`TMMS backend listening on http://localhost:${PORT}`);
});

// Daily schedule generation job
const { runGeneration } = require('./scheduler');
runGeneration();
setInterval(runGeneration, 6 * 3600 * 1000);

// Deliver scheduled (queued) mail whose time has come, even when nobody has the
// mailbox open. Also swept lazily on inbox reads for a snappy feel.
setInterval(() => { try { mailboxRouter.processOutbox(); } catch (_) { /* non-fatal */ } }, 60 * 1000);

// Generate any due scheduled reports and roll each schedule forward. Swept at
// boot and every few minutes so recurring reports appear without user action.
try { reportsRouter.runReportSchedules(); } catch (_) { /* non-fatal */ }
setInterval(() => { try { reportsRouter.runReportSchedules(); } catch (_) { /* non-fatal */ } }, 5 * 60 * 1000);

// Asset-condition monitoring agent: revalue every evidence-bearing asset, log
// condition drift and raise a revaluation report when assets degrade. Idempotent
// (snapshots are only appended on change), so re-running is cheap and quiet.
function runAssetMonitor() {
  try {
    const r = reportsRouter.runAssetMonitor();
    if (r.changed) console.log(`[asset-monitor] evaluated ${r.evaluated}, changed ${r.changed}, degraded ${r.degraded.length}, improved ${r.improved.length}`);
  } catch (_) { /* non-fatal */ }
}
runAssetMonitor();
setInterval(runAssetMonitor, 6 * 3600 * 1000);

module.exports = app;
