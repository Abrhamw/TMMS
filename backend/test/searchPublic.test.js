process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-search-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema } = require('../db');
const { insertRow } = require('../util');
const { requireAuth, auditMiddleware, createSession, hashPassword } = require('../auth');

initSchema();

const NOW = new Date().toISOString();
const regionId = insertRow('region', {
  code: 'SA', name: 'Sululta Area', type: 'CUSTOM', center_lat: 9, center_lng: 38,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const otherRegion = insertRow('region', {
  code: 'OT', name: 'Other Area', type: 'CUSTOM', center_lat: 0, center_lng: 0,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const sub = insertRow('substation', {
  substation_id: 'SS-SUL', name: 'Sululta 400kV', region_id: regionId, latitude: 9.1, longitude: 38.7,
});
const line = insertRow('transmission_line', {
  line_id: 'LN-SUL-230', name: 'Sululta<>Gefersa 230kV', region_id: regionId,
  from_substation_id: sub, to_substation_id: sub, voltage_kv: 230,
});
insertRow('tower', {
  tower_id: 'TW-SUL-1', line_id: line, tower_number: 1, latitude: 9.11, longitude: 38.71, corrosion_rating: 8,
});
insertRow('asset', {
  asset_id: 'XFR-SUL-1', asset_type: 'TRANSFORMER', sub_type: 'AUTO',
  substation_id: sub, name: '400/230kV Auto Transformer',
  serial_number: 'SECRET-SERIAL', manufacturer: 'HiddenCo', model: 'X-9',
  condition_rating: 8, lifecycle_status: 'IN_SERVICE',
});
insertRow('maintenance_schedule', {
  schedule_name: 'Sululta Line Patrol', schedule_code: 'SCH-SUL-1',
  scope_type: 'LINE', frequency: 'MONTHLY', frequency_config: '{}',
  region_id: regionId, line_id: line, next_due_date: NOW, is_active: 1, lead_time_days: 7,
});
insertRow('task', {
  task_number: 'TK-SEARCH-1', title: 'Secret Sululta patrol', task_type: 'INSPECTION',
  priority: 'LOW', status: 'DRAFT', region_id: regionId, due_date: NOW,
  created_at: NOW, updated_at: NOW, source: 'MANUAL',
});
insertRow('task', {
  task_number: 'TK-SEARCH-2', title: 'Other region job', task_type: 'INSPECTION',
  priority: 'LOW', status: 'DRAFT', region_id: otherRegion, due_date: NOW,
  created_at: NOW, updated_at: NOW, source: 'MANUAL',
});
insertRow('person', { first_name: 'Hidden', last_name: 'Person', role: 'STAFF', email: 'hidden@example.com', active: 1 });

const adminPerson = insertRow('person', { first_name: 'Search', last_name: 'Admin', role: 'ADMIN', active: 1 });
const adminId = insertRow('user', {
  username: 'search-admin', password_hash: hashPassword('x'), role: 'ADMIN',
  person_id: adminPerson, active: 1, created_at: NOW,
});
const adminToken = createSession(adminId);
const regionPerson = insertRow('person', { first_name: 'Search', last_name: 'Region', role: 'REGION_DIRECTOR', active: 1 });
const regionUserId = insertRow('user', {
  username: 'search-region', password_hash: hashPassword('x'), role: 'REGION_DIRECTOR',
  region_id: regionId, person_id: regionPerson, active: 1, created_at: NOW,
});
const regionToken = createSession(regionUserId);
const crewPerson = insertRow('person', { first_name: 'Search', last_name: 'Crew', role: 'CREW_MEMBER', active: 1 });
const crewUserId = insertRow('user', {
  username: 'search-crew', password_hash: hashPassword('x'), role: 'CREW_MEMBER',
  region_id: regionId, person_id: crewPerson, active: 1, created_at: NOW,
});
const crewToken = createSession(crewUserId);

const publicSearch = require('../routes/searchPublic');
const authSearch = require('../routes/search');

const app = express();
app.use(express.json());
app.use('/api', publicSearch);
app.use('/api', requireAuth, auditMiddleware, authSearch);

let server;
let base;
test.before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

async function get(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

test('catalog search requires a token', async () => {
  const { status } = await get('/api/search/public?q=sululta');
  assert.strictEqual(status, 401);
});

test('catalog search returns an empty payload for a blank query', async () => {
  const { status, body } = await get('/api/search/public?q=', adminToken);
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { query: '', total: 0, groups: [] });
});

test('catalog search AND-matches across fields and rejects a missing word', async () => {
  const hit = await get('/api/search/public?q=sululta%20230', adminToken);
  const lineGroup = (hit.body.groups || []).find((g) => g.type === 'line');
  assert.ok(lineGroup, JSON.stringify(hit.body));
  assert.ok(lineGroup.items.some((it) => it.title.includes('230')));

  const miss = await get('/api/search/public?q=sululta%20999', adminToken);
  assert.strictEqual(miss.body.total, 0);
});

test('catalog search only returns the six allowed types', async () => {
  const { body } = await get('/api/search/public?q=sululta', adminToken);
  const types = (body.groups || []).map((g) => g.type).sort();
  for (const type of types) {
    assert.ok(['region', 'substation', 'line', 'tower', 'asset', 'schedule'].includes(type), type);
  }
  assert.ok(!types.includes('task'));
  assert.ok(!types.includes('person'));
  assert.ok(!types.includes('crew'));
});

test('catalog search items include a description and never leak serials', async () => {
  const { body } = await get('/api/search/public?q=transformer', adminToken);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('SECRET-SERIAL'));
  assert.ok(!raw.includes('HiddenCo'));
  assert.ok(!raw.includes('condition_rating'));
  for (const g of body.groups || []) {
    for (const it of g.items) {
      assert.ok(typeof it.description === 'string' && it.description.length > 0);
      assert.ok(typeof it.can_open === 'boolean');
    }
  }
});

test('catalog asset results link to the assets hub when the role may open them', async () => {
  const { body } = await get('/api/search/public?q=auto%20transformer', adminToken);
  const assets = (body.groups || []).find((g) => g.type === 'asset');
  assert.ok(assets);
  assert.strictEqual(assets.items[0].can_open, true);
  assert.ok(assets.items[0].href.startsWith('/assets?asset='));
});

test('catalog search matches an asset by parent substation name plus type', async () => {
  const { body } = await get('/api/search/public?q=sululta%20transformer', adminToken);
  const assets = (body.groups || []).find((g) => g.type === 'asset');
  assert.ok(assets, JSON.stringify(body));
  assert.ok(assets.items.some((it) => /transformer/i.test(it.title)));
});

test('a crew member sees schedule descriptions but cannot open them', async () => {
  const { status, body } = await get('/api/search/public?q=sululta%20patrol', crewToken);
  assert.strictEqual(status, 200);
  const schedules = (body.groups || []).find((g) => g.type === 'schedule');
  assert.ok(schedules, JSON.stringify(body));
  assert.ok(schedules.items[0].description);
  assert.strictEqual(schedules.items[0].can_open, false);
  assert.strictEqual(schedules.items[0].href, undefined);
});

test('authenticated search rejects a missing token', async () => {
  const { status } = await get('/api/search?q=sululta');
  assert.strictEqual(status, 401);
});

test('authenticated search AND-matches tasks the caller can see', async () => {
  const admin = await get('/api/search?q=secret%20sululta', adminToken);
  assert.strictEqual(admin.status, 200);
  const tasks = (admin.body.groups || []).find((g) => g.type === 'task');
  assert.ok(tasks);
  assert.ok(tasks.items.some((it) => it.title.includes('Secret Sululta')));

  const region = await get('/api/search?q=other%20region', regionToken);
  assert.strictEqual(region.status, 200);
  const regionTasks = (region.body.groups || []).find((g) => g.type === 'task');
  assert.ok(!regionTasks);
});
