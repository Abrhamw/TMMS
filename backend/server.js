const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
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
app.use('/api', require('./routes/mailbox'));
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
app.use('/api', require('./routes/reports'));
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

module.exports = app;
