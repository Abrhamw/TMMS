# Chain-of-Command Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the real Transmission Substation Operation chain of command so task assignment/visibility follows the org tree, with Operational Technology holding cross-region functional authority.

**Architecture:** Add `crew.org_unit_id` linking each crew to its owning org unit. A new `backend/authority.js` resolves a user's authorized crew set by org subtree, plus a functional (crew-type) scope for OT/Relay units. Task and crew routes consult this module instead of raw region checks. The org tree is seeded with a `DIV-OT` division and three center-crew pools; a boot reconcile migrates legacy manager roles to `REGION_MANAGER` and backfills crew ownership.

**Tech Stack:** Node.js >= 22.5.0, Express 5, `node:sqlite` (`DatabaseSync`), React 19 + Vite 7, commonjs backend / ESM frontend.

## Global Constraints

- Backend is CommonJS; frontend is ESM. Do not mix.
- Database access goes through `db.prepare(...)` from `backend/db.js`; helpers `list/get/insertRow/updateRow/safeDelete/withTx` come from `backend/util.js`.
- `withTx` is NOT reentrant. Never call it inside another `withTx`.
- Never mutate the real `backend/tmms.db` for tests. Copy or `VACUUM INTO` a scratch DB and point `TMMS_DB` at it.
- Never run `pkill`/`killall`. Stop scratch servers by their background terminal id.
- Do not commit `backend/tmms.db*`, `backend/uploads/`, or `frontend/dist/`. Do not `git add -A`.
- No new npm dependencies. Tests are plain `node` scripts under `/tmp/chain/` using `node:assert`.
- Existing 57-check regression suite must stay green.
- `REGION_MANAGER` is the canonical department-head role. `SUBSTATION_MANAGER`, `TRANSMISSION_MANAGER`, `RELAY_SCADA_MANAGER` remain accepted aliases.
- Functional crew types: `RELAY_AND_PROTECTION`, `SCADA_RTU`, `TELECOM`, `OPGW`.
- OT unit types: `RELAY_SCADA_TELECOM`, `OPERATIONAL_TECHNOLOGY`.

---

## File Structure

- Create: `backend/authority.js` — org-subtree + functional crew authority resolver (single responsibility: "who may touch which crew/task").
- Modify: `backend/db.js` — add `crew.org_unit_id` migration.
- Modify: `backend/auth.js` — `REGION_MANAGER_PERMS`, role aliases.
- Modify: `backend/routes/tasks.js` — use authority for visibility, assignment, verification SoD.
- Modify: `backend/routes/crews.js` — `assignable`/`org_unit` in detail, authority-scoped list/view/write, eligibility filter.
- Modify: `backend/routes/org.js` — `UNIT_TYPES`, `unitDetail` crews by `org_unit_id`.
- Modify: `backend/seed_eep.js` — `DIV-OT`, OT head, center crews, backfills, role migration.
- Modify: `backend/server.js` — run crew/user account provisioning after reconcile (ordering).
- Modify: `frontend/src/auth.js` — mirror permission change.
- Modify: `frontend/src/pages/Organization.jsx` — unit-type labels/counts.
- Modify: `frontend/src/components/TaskWorkPanel.jsx`, `frontend/src/pages/Tasks.jsx` — filter assignable crews.
- Modify: `frontend/src/pages/Settings.jsx`, `frontend/src/pages/Login.jsx` — legacy labels + demo hints.
- Tests: `/tmp/chain/authority.test.js`, `/tmp/chain/migrate.test.js`, `/tmp/chain/e2e.js` (not committed).

---

## Task 1: Add `crew.org_unit_id` schema migration

**Files:**
- Modify: `backend/db.js` (add migration after the existing `crew` migrations around line 549)
- Test: `/tmp/chain/migrate.test.js`

**Interfaces:**
- Consumes: `migrate(table, column, alterSql)` (already in `db.js`).
- Produces: `crew.org_unit_id INTEGER REFERENCES org_unit(id)` column.

- [ ] **Step 1: Write the failing test**

```js
// /tmp/chain/migrate.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const dir = '/tmp/chain';
fs.mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/migrate.db`;
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch {} }

// Pre-create an OLD crew table with no org_unit_id so initSchema must migrate it.
const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(dbPath);
raw.exec('CREATE TABLE crew (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, crew_code TEXT, region_id INTEGER)');
raw.close();

process.env.TMMS_DB = dbPath;
const { db, initSchema } = require('/workspace/backend/db');
initSchema();

const cols = db.prepare('PRAGMA table_info(crew)').all().map((c) => c.name);
assert.ok(cols.includes('org_unit_id'), 'crew.org_unit_id should exist after initSchema');
console.log('PASS migrate: crew.org_unit_id present');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/chain/migrate.test.js`
Expected: FAIL with `AssertionError: crew.org_unit_id should exist after initSchema`

- [ ] **Step 3: Write minimal implementation**

In `backend/db.js`, immediately after the line:
`migrate('crew', 'status_override', 'ALTER TABLE crew ADD COLUMN status_override TEXT');`
add:

```js
  migrate('crew', 'org_unit_id', 'ALTER TABLE crew ADD COLUMN org_unit_id INTEGER REFERENCES org_unit(id)');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node /tmp/chain/migrate.test.js`
Expected: `PASS migrate: crew.org_unit_id present`

- [ ] **Step 5: Commit**

```bash
git add backend/db.js
git commit -m "feat(db): link crews to owning org unit"
```

---

## Task 2: Authority resolver module

**Files:**
- Create: `backend/authority.js`
- Test: `/tmp/chain/authority.test.js`

**Interfaces:**
- Consumes: `db` from `./db`; `isGlobal`, `isCrewUser` from `./auth`.
- Produces:
  - `FUNCTIONAL_CREW_TYPES: Set<string>`, `OT_UNIT_TYPES: Set<string>`, `LEGACY_MANAGER_ROLES: Set<string>`
  - `isManager(user): boolean`
  - `unitSubtree(unitId): number[]`
  - `userUnitId(user): number|null`
  - `isFunctionalCrew(crew): boolean`
  - `userHasFunctionalScope(user): boolean`
  - `authorizedCrewIds(user): Set<number>`
  - `canAssignCrew(user, crewId): boolean`
  - `canViewCrew(user, crew): boolean`
  - `canManageUnit(user, unitId): boolean`
  - `taskVisible(user, task): boolean`

- [ ] **Step 1: Write the failing test**

```js
// /tmp/chain/authority.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const dir = '/tmp/chain';
fs.mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/authority.db`;
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch {} }

process.env.TMMS_DB = dbPath;
const { db, initSchema } = require('/workspace/backend/db');
initSchema();
const a = require('/workspace/backend/authority');

const ins = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);
const region = ins("INSERT INTO region (code,name,center_lat,center_lng) VALUES ('C1','C1',9,38)");
const uRoot = ins("INSERT INTO org_unit (unit_code,name,unit_type) VALUES ('DIV','Division','DIVISION')");
const uSom = ins("INSERT INTO org_unit (unit_code,name,unit_type,parent_id) VALUES ('DEPT-SOM','SOM','SUBSTATION_MAINTENANCE',?)", uRoot);
const uTlom = ins("INSERT INTO org_unit (unit_code,name,unit_type,parent_id) VALUES ('DEPT-TLOM','TLOM','TRANSMISSION_MAINTENANCE',?)", uRoot);
const uOt = ins("INSERT INTO org_unit (unit_code,name,unit_type) VALUES ('DIV-OT','OT','OPERATIONAL_TECHNOLOGY')");
const pSom = ins("INSERT INTO person (first_name,last_name,role,org_unit_id) VALUES ('S','M','MANAGER',?)", uSom);
const pTlom = ins("INSERT INTO person (first_name,last_name,role,org_unit_id) VALUES ('T','M','MANAGER',?)", uTlom);
const pOt = ins("INSERT INTO person (first_name,last_name,role,org_unit_id) VALUES ('O','T','MANAGER',?)", uOt);
const pCrew = ins("INSERT INTO person (first_name,last_name,role) VALUES ('C','L','CREW_LEAD')");
const crewSom = ins("INSERT INTO crew (name,crew_code,crew_type,region_id,org_unit_id) VALUES ('SOM','CREW-SOM','SUBSTATION',?,?)", region, uSom);
const crewTlom = ins("INSERT INTO crew (name,crew_code,crew_type,region_id,org_unit_id) VALUES ('TLOM','CREW-TLOM','LINE',?,?)", region, uTlom);
const crewRly = ins("INSERT INTO crew (name,crew_code,crew_type,region_id,org_unit_id) VALUES ('RLY','CREW-RLY','RELAY_AND_PROTECTION',?,?)", region, uOt);

const user = (id, role, person) => ({ id, role, person_id: person, region_id: region, crew_id: null });
const somMgr = user(1, 'REGION_MANAGER', pSom);
const tlomMgr = user(2, 'REGION_MANAGER', pTlom);
const otMgr = user(3, 'REGION_MANAGER', pOt);
const crewLead = { id: 4, role: 'CREW_LEAD', person_id: pCrew, region_id: region, crew_id: crewRly };
const admin = { id: 5, role: 'ADMIN', person_id: null, region_id: null, crew_id: null };

assert.deepStrictEqual([...a.unitSubtree(uRoot)].sort((x, y) => x - y), [uRoot, uSom, uTlom].sort((x, y) => x - y));
assert.strictEqual(a.canAssignCrew(somMgr, crewSom), true, 'SOM manager owns SOM crew');
assert.strictEqual(a.canAssignCrew(somMgr, crewTlom), false, 'SOM manager not TLOM crew');
assert.strictEqual(a.canAssignCrew(tlomMgr, crewTlom), true);
assert.strictEqual(a.canAssignCrew(otMgr, crewRly), true, 'OT manager functional crew');
assert.strictEqual(a.canAssignCrew(otMgr, crewSom), false, 'OT manager not non-functional crew');
assert.strictEqual(a.canAssignCrew(crewLead, crewRly), true, 'crew user own crew');
assert.strictEqual(a.canAssignCrew(crewLead, crewSom), false);
assert.strictEqual(a.canAssignCrew(admin, crewSom), true);
assert.strictEqual(a.canManageUnit(somMgr, uSom), true);
assert.strictEqual(a.canManageUnit(somMgr, uTlom), false);
assert.strictEqual(a.taskVisible(somMgr, { id: 1, crew_id: crewTlom, region_id: region }), false);
assert.strictEqual(a.taskVisible(somMgr, { id: 2, crew_id: null, region_id: region }), true, 'unassigned in region');
assert.strictEqual(a.taskVisible(crewLead, { id: 3, crew_id: crewRly, region_id: region }), true);
assert.strictEqual(a.taskVisible(crewLead, { id: 4, crew_id: crewSom, region_id: region }), false);
console.log('PASS authority: subtree, functional scope, visibility');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/chain/authority.test.js`
Expected: FAIL with `Cannot find module '/workspace/backend/authority'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/authority.js`:

```js
const { db } = require('./db');
const { isGlobal, isCrewUser } = require('./auth');

const FUNCTIONAL_CREW_TYPES = new Set(['RELAY_AND_PROTECTION', 'SCADA_RTU', 'TELECOM', 'OPGW']);
const OT_UNIT_TYPES = new Set(['RELAY_SCADA_TELECOM', 'OPERATIONAL_TECHNOLOGY']);
const LEGACY_MANAGER_ROLES = new Set(['SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER']);

function isManager(user) {
  return !!user && (user.role === 'REGION_MANAGER' || LEGACY_MANAGER_ROLES.has(user.role));
}

function unitSubtree(rootId) {
  if (!rootId) return [];
  return db.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM org_unit WHERE id = ?
       UNION
       SELECT o.id FROM org_unit o JOIN sub s ON o.parent_id = s.id
     ) SELECT id FROM sub`
  ).all(Number(rootId)).map((r) => r.id);
}

function userUnitId(user) {
  if (!user) return null;
  if (user.person_id) {
    const p = db.prepare('SELECT org_unit_id FROM person WHERE id = ?').get(user.person_id);
    if (p && p.org_unit_id) return p.org_unit_id;
  }
  if (user.crew_id) {
    const c = db.prepare('SELECT org_unit_id FROM crew WHERE id = ?').get(user.crew_id);
    if (c && c.org_unit_id) return c.org_unit_id;
  }
  return null;
}

function isFunctionalCrew(crew) {
  return !!crew && FUNCTIONAL_CREW_TYPES.has(crew.crew_type);
}

function userHasFunctionalScope(user) {
  if (!isManager(user)) return false;
  const unitId = userUnitId(user);
  if (!unitId) return false;
  const u = db.prepare('SELECT unit_type FROM org_unit WHERE id = ?').get(unitId);
  return !!u && OT_UNIT_TYPES.has(u.unit_type);
}

function allCrews() {
  return db.prepare('SELECT id, region_id, org_unit_id, crew_type FROM crew').all();
}

function authorizedCrewIds(user) {
  if (!user) return new Set();
  const all = allCrews();
  if (isGlobal(user)) return new Set(all.map((c) => c.id));
  if (isCrewUser(user)) return new Set(user.crew_id ? [user.crew_id] : []);
  if (isManager(user)) {
    const ids = new Set();
    const unitId = userUnitId(user);
    if (unitId) {
      const subtree = new Set(unitSubtree(unitId));
      for (const c of all) if (c.org_unit_id && subtree.has(c.org_unit_id)) ids.add(c.id);
    }
    if (userHasFunctionalScope(user)) {
      for (const c of all) if (isFunctionalCrew(c)) ids.add(c.id);
    }
    return ids;
  }
  return new Set(all.filter((c) => c.region_id === user.region_id).map((c) => c.id));
}

function canAssignCrew(user, crewId) {
  if (crewId === null || crewId === undefined) return false;
  return authorizedCrewIds(user).has(Number(crewId));
}

function canViewCrew(user, crew) {
  if (!crew || !user) return false;
  if (isGlobal(user)) return true;
  if (isCrewUser(user)) return user.crew_id === crew.id;
  if (isManager(user)) return authorizedCrewIds(user).has(crew.id);
  return crew.region_id === user.region_id;
}

function canManageUnit(user, unitId) {
  if (!user || unitId === null || unitId === undefined) return false;
  if (isGlobal(user)) return true;
  if (!isManager(user)) return false;
  const mine = userUnitId(user);
  if (!mine) return false;
  return new Set(unitSubtree(mine)).has(Number(unitId));
}

function taskVisible(user, t) {
  if (!t || !user) return false;
  if (isGlobal(user)) return true;
  if (isCrewUser(user)) return !!t.crew_id && t.crew_id === user.crew_id;
  if (isManager(user)) {
    if (t.crew_id) return authorizedCrewIds(user).has(t.crew_id);
    if (t.created_by && user.person_id && t.created_by === user.person_id) return true;
    return t.region_id === user.region_id;
  }
  return t.region_id === user.region_id;
}

module.exports = {
  FUNCTIONAL_CREW_TYPES,
  OT_UNIT_TYPES,
  LEGACY_MANAGER_ROLES,
  isManager,
  unitSubtree,
  userUnitId,
  isFunctionalCrew,
  userHasFunctionalScope,
  authorizedCrewIds,
  canAssignCrew,
  canViewCrew,
  canManageUnit,
  taskVisible,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node /tmp/chain/authority.test.js`
Expected: `PASS authority: subtree, functional scope, visibility`

- [ ] **Step 5: Commit**

```bash
git add backend/authority.js
git commit -m "feat(authz): add org-subtree and functional crew authority resolver"
```

---

## Task 3: Unify manager permissions and migrate role names

**Files:**
- Modify: `backend/auth.js` (around `ROLE_PERMS`, lines 101-122)
- Modify: `backend/seed_eep.js` (`C1_MANAGERS`, lines 145-150)
- Test: `/tmp/chain/perms.test.js`

**Interfaces:**
- Consumes: `ROLE_PERMS`.
- Produces: `REGION_MANAGER_PERMS` set granting `task:execute`, `gps:write`, `attachment:write`; legacy manager roles map to it.

- [ ] **Step 1: Write the failing test**

```js
// /tmp/chain/perms.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const dir = '/tmp/chain';
fs.mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/perms.db`;
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.TMMS_DB = dbPath;
const { initSchema } = require('/workspace/backend/db');
initSchema();
const { ROLE_PERMS, hasPerm, REGION_MANAGER_PERMS } = require('/workspace/backend/auth');
for (const role of ['REGION_MANAGER', 'SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER']) {
  const u = { role };
  assert.strictEqual(hasPerm(u, 'task:execute'), true, `${role} can execute`);
  assert.strictEqual(hasPerm(u, 'gps:write'), true, `${role} can write gps`);
  assert.strictEqual(hasPerm(u, 'attachment:write'), true, `${role} can attach`);
  assert.strictEqual(hasPerm(u, 'task:assign'), true, `${role} can assign`);
}
assert.ok(REGION_MANAGER_PERMS.has('task:verify'));
console.log('PASS perms: manager roles execute/assign/verify');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/chain/perms.test.js`
Expected: FAIL with `AssertionError: REGION_MANAGER can execute` (and `REGION_MANAGER_PERMS` undefined).

- [ ] **Step 3: Write minimal implementation**

In `backend/auth.js`, after the `OPERATIONS_WORKFLOW` declaration and before `ROLE_PERMS`, add:

```js
// Department heads run the operational lifecycle AND capture field evidence
// for checklists they own (execution, GPS, attachments), but the full
// lead/submit flow stays with crew leads.
const REGION_MANAGER_PERMS = new Set([
  ...READ_PERMS, ...OPERATIONS_WORKFLOW, 'task:execute', 'gps:write', 'attachment:write',
]);
```

Then replace the `REGION_MANAGER` and three alias entries in `ROLE_PERMS` with:

```js
  REGION_MANAGER: REGION_MANAGER_PERMS,
  // Legacy department-head role names remain valid aliases.
  SUBSTATION_MANAGER: REGION_MANAGER_PERMS,
  TRANSMISSION_MANAGER: REGION_MANAGER_PERMS,
  RELAY_SCADA_MANAGER: REGION_MANAGER_PERMS,
```

Add `REGION_MANAGER_PERMS` to `module.exports`.

In `backend/seed_eep.js`, change the `userRole` of all three `C1_MANAGERS` entries from `SUBSTATION_MANAGER` / `TRANSMISSION_MANAGER` / `RELAY_SCADA_MANAGER` to `REGION_MANAGER`:

```js
  { username: 'mgr.c1.som', password: 'Manager@123', userRole: 'REGION_MANAGER', first_name: 'Getnet', last_name: 'Tesfaye', personRole: 'MANAGER', title: 'Manager, Substation Operation & Maintenance', email: 'c1ssom@eep-tmms.com.et' },
  { username: 'mgr.c1.tlom', password: 'Manager@123', userRole: 'REGION_MANAGER', first_name: 'Fikadu', last_name: 'Bekele', personRole: 'MANAGER', title: 'Manager, Transmission Line & OPGW Maintenance', email: 'tlom@eep-tmms.com.et' },
  { username: 'mgr.c1.rs', password: 'Manager@123', userRole: 'REGION_MANAGER', first_name: 'Molla', last_name: 'Kebede', personRole: 'MANAGER', title: 'Manager, RTU Telecom SCADA & Protection', email: 'c1rtsp@eep-tmms.com.et' },
```

Also change the four `ensureUser` calls near the end of `seedEep()` (lines ~209-211) so their `role` argument is `'REGION_MANAGER'`:

```js
  ensureUser({ username: 'mgr.c1.som', password: 'Manager@123', role: 'REGION_MANAGER', regionId: regionByCode.C1, personId: c1Ids['mgr.c1.som'] });
  ensureUser({ username: 'mgr.c1.tlom', password: 'Manager@123', role: 'REGION_MANAGER', regionId: regionByCode.C1, personId: c1Ids['mgr.c1.tlom'] });
  ensureUser({ username: 'mgr.c1.rs', password: 'Manager@123', role: 'REGION_MANAGER', regionId: regionByCode.C1, personId: c1Ids['mgr.c1.rs'] });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node /tmp/chain/perms.test.js`
Expected: `PASS perms: manager roles execute/assign/verify`

- [ ] **Step 5: Commit**

```bash
git add backend/auth.js backend/seed_eep.js
git commit -m "feat(authz): grant region managers field execution and unify role name"
```

---

## Task 4: Enforce authority on task visibility and assignment

**Files:**
- Modify: `backend/routes/tasks.js` (imports ~line 5; remove local `taskVisible` ~line 37; `POST /tasks` ~line 339; `PUT /tasks/:id` ~line 377; `POST /tasks/bulk` ~line 256; `POST /tasks/:id/state` assign ~line 521)
- Test: extend `/tmp/chain/authority.test.js` (already covers `taskVisible`), plus manual route check in Task 12.

**Interfaces:**
- Consumes: `canAssignCrew`, `taskVisible` from `../authority`.
- Produces: 403 on assigning a crew outside authority; task lists/reads scoped by authority.

- [ ] **Step 1: Wire the resolver**

In `backend/routes/tasks.js`, add to the requires:

```js
const { canAssignCrew, taskVisible } = require('../authority');
```

Delete the local `function taskVisible(user, t) { ... }` definition (lines 37-41). The imported one replaces it.

- [ ] **Step 2: Enforce on create**

In `POST /tasks`, after `if (!isGlobal(req.user)) fields.region_id = req.user.region_id;`, add:

```js
  if (fields.crew_id !== undefined && fields.crew_id !== null && !canAssignCrew(req.user, fields.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
  }
```

- [ ] **Step 3: Enforce on update**

In `PUT /tasks/:id`, replace the existing crew region block:

```js
  if (fields.crew_id !== undefined && fields.crew_id !== null) {
    const crew = get('crew', Number(fields.crew_id));
    if (!crew) return res.status(400).json({ error: 'Crew not found' });
    const regionId = fields.region_id ?? t.region_id;
    if (crew.region_id !== regionId) return res.status(400).json({ error: 'Crew does not belong to the task region' });
  }
```

with:

```js
  if (fields.crew_id !== undefined && fields.crew_id !== null) {
    const crew = get('crew', Number(fields.crew_id));
    if (!crew) return res.status(400).json({ error: 'Crew not found' });
    if (!canAssignCrew(req.user, crew.id)) {
      return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
    }
  }
```

- [ ] **Step 4: Enforce on bulk assign**

In `POST /tasks/bulk`, inside the `for (const id of ids)` validation loop, after the `taskVisible` check, add:

```js
    if (action === 'assign' && !canAssignCrew(req.user, Number(value))) {
      return res.status(403).json({ error: `Crew ${value} is outside your authority` });
    }
```

- [ ] **Step 5: Enforce on state assign**

In `POST /tasks/:id/state`, replace the assign validation block:

```js
  if (action === 'assign' && req.body.crew_id) {
    const crew = get('crew', Number(req.body.crew_id));
    if (!crew) return res.status(400).json({ error: 'Crew not found' });
    if (Number.isFinite(t.region_id) && crew.region_id !== t.region_id) {
      return res.status(400).json({ error: 'Crew does not belong to the task region' });
    }
  }
```

with:

```js
  if (action === 'assign' && req.body.crew_id) {
    const crew = get('crew', Number(req.body.crew_id));
    if (!crew) return res.status(400).json({ error: 'Crew not found' });
    if (!canAssignCrew(req.user, crew.id)) {
      return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
    }
  }
```

- [ ] **Step 6: Verify syntax and run authority test**

Run:
```bash
node --check backend/routes/tasks.js
node /tmp/chain/authority.test.js
```
Expected: no syntax error; `PASS authority: subtree, functional scope, visibility`

- [ ] **Step 7: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(tasks): enforce crew authority on visibility and assignment"
```

---

## Task 5: Segregation of duties at verification

**Files:**
- Modify: `backend/routes/tasks.js` (`POST /tasks/:id/state`, after the GPS verification block ~line 517)
- Test: covered by `/tmp/chain/e2e.js` (Task 12).

**Interfaces:**
- Consumes: `checklist_execution.executed_by`.
- Produces: 409 when the authenticated verifier executed the latest submitted checklist.

- [ ] **Step 1: Add the guard**

In `POST /tasks/:id/state`, immediately after the GPS-enforcement `if (action === 'verify' && t.checklist_template_id) { ... }` block and before "Validate referenced entities", add:

```js
  // Segregation of duties: whoever performed the latest submitted checklist
  // cannot also verify/complete the same task.
  if (action === 'verify') {
    const lastExec = db.prepare(
      "SELECT executed_by FROM checklist_execution WHERE task_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).get(id);
    if (lastExec && lastExec.executed_by && req.user.person_id && lastExec.executed_by === req.user.person_id) {
      return res.status(409).json({
        error: 'Segregation of duties: the verifier cannot be the person who executed the checklist',
      });
    }
  }
```

- [ ] **Step 2: Verify syntax**

Run: `node --check backend/routes/tasks.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(tasks): block verifier from verifying own checklist execution"
```

---

## Task 6: Crew routes honor authority

**Files:**
- Modify: `backend/routes/crews.js` (imports; `crewDetail` ~line 9; `GET /crews` ~line 95; `GET /crews/eligibility` ~line 105; `GET /crews/:id` ~line 130; `POST/PUT /crews` ~lines 142-182)
- Test: covered by `/tmp/chain/e2e.js` (Task 12).

**Interfaces:**
- Consumes: `authorizedCrewIds`, `canAssignCrew`, `canViewCrew`, `canManageUnit`, `isManager` from `../authority`.
- Produces: `crewDetail(c, user)` adds `org_unit` and `assignable`; `/crews` returns an `assignable` flag and union of authorized crews; eligibility restricted to authorized crews; create/update `org_unit_id` restricted to the manager's subtree.

- [ ] **Step 1: Import and extend `crewDetail`**

At the top of `backend/routes/crews.js`, add:

```js
const { authorizedCrewIds, canAssignCrew, canViewCrew, canManageUnit, isManager } = require('../authority');
```

Change the signature to `function crewDetail(c, user = null) {` and, before `return out;`, add:

```js
  out.org_unit = c.org_unit_id ? get('org_unit', c.org_unit_id) : null;
  out.assignable = user ? canAssignCrew(user, c.id) : true;
```

- [ ] **Step 2: Scope the crew list and add the flag**

Replace `GET /crews` body:

```js
router.get('/crews', (req, res) => {
  let rows = scopeRows(req.user, list('crew'), (c) => c.region_id);
  if (isManager(req.user)) {
    const ids = authorizedCrewIds(req.user);
    const byId = new Map(rows.map((c) => [c.id, c]));
    for (const c of list('crew')) if (ids.has(c.id) && !byId.has(c.id)) rows.push(c);
  }
  const { region_id, q } = req.query;
  if (region_id) rows = rows.filter((c) => c.region_id === Number(region_id));
  if (q) rows = rows.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  res.json(rows.map((c) => crewDetail(c, req.user)));
});
```

- [ ] **Step 3: Restrict eligibility to authorized crews**

In `GET /crews/eligibility`, after the existing `if (region_id) rows = ...` line, add:

```js
  if (isManager(req.user)) {
    const ids = authorizedCrewIds(req.user);
    rows = rows.filter((c) => ids.has(c.id));
  }
```

Change the mapping to `const result = rows.map((c) => { const detail = crewDetail(c, req.user); ...` (only the `crewDetail` call changes) and add `assignable: true,` to the returned object (they are pre-filtered to authorized crews).

- [ ] **Step 4: Use `canViewCrew` on detail**

In `GET /crews/:id`, replace `if (!checkRegion(req, res, c.region_id)) return;` with:

```js
  if (!canViewCrew(req.user, c)) return res.status(403).json({ error: 'Forbidden: crew is outside your scope' });
```

and change `const detail = crewDetail(c);` to `const detail = crewDetail(c, req.user);`.

- [ ] **Step 5: Restrict `org_unit_id` on create/update**

In `POST /crews`, after the existing `const { members, status, status_override, ...fields } = req.body || {};` destructure, add:

```js
  if (fields.org_unit_id !== undefined && fields.org_unit_id !== null && !canManageUnit(req.user, fields.org_unit_id)) {
    return res.status(403).json({ error: 'Forbidden: org unit is outside your authority' });
  }
```

In `PUT /crews/:id`, after `const c = get('crew', Number(req.params.id));` and its not-found check, replace `if (!checkRegion(req, res, c.region_id)) return;` with `if (!canViewCrew(req.user, c)) return res.status(403).json({ error: 'Forbidden: crew is outside your scope' });`.

Then, after the existing `const { members, status, status_override, ...fields } = req.body || {};` destructure and before the `try {`, add:

```js
  if (fields.org_unit_id !== undefined && fields.org_unit_id !== null && !canManageUnit(req.user, fields.org_unit_id)) {
    return res.status(403).json({ error: 'Forbidden: org unit is outside your authority' });
  }
```

Finally, replace both remaining `res.json(crewDetail(get('crew', ...)))` calls with `res.json(crewDetail(get('crew', ...), req.user))` and the `res.status(201).json(crewDetail(get('crew', id)))` with `res.status(201).json(crewDetail(get('crew', id), req.user))`.

- [ ] **Step 6: Verify syntax**

Run: `node --check backend/routes/crews.js`
Expected: no output (success).

Note: `checkRegion` may now be unused in this file; leave the import if other handlers still use it, otherwise remove it from the destructured require to keep lint-clean.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/crews.js
git commit -m "feat(crews): scope crew access and writable org unit by authority"
```

---

## Task 7: Org unit types and crew grouping

**Files:**
- Modify: `backend/routes/org.js` (`UNIT_TYPES` ~line 7; `unitDetail` ~line 12)
- Test: `/tmp/chain/org.test.js`

**Interfaces:**
- Consumes: `list/get` from `../util`.
- Produces: `unitDetail` lists crews by `crew.org_unit_id`; `UNIT_TYPES` accepts all seeded department types plus `OPERATIONAL_TECHNOLOGY`.

- [ ] **Step 1: Write the failing test**

```js
// /tmp/chain/org.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const dir = '/tmp/chain';
fs.mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/org.db`;
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.TMMS_DB = dbPath;
const { db, initSchema } = require('/workspace/backend/db');
initSchema();
const region = Number(db.prepare("INSERT INTO region (code,name,center_lat,center_lng) VALUES ('C1','C1',9,38)").run().lastInsertRowid);
const u = Number(db.prepare("INSERT INTO org_unit (unit_code,name,unit_type,region_id) VALUES ('DEPT-C1-SOM','SOM','SUBSTATION_MAINTENANCE',?)").run(region).lastInsertRowid);
db.prepare("INSERT INTO crew (name,crew_code,crew_type,region_id,org_unit_id) VALUES ('SOM Crew','CREW-C1-SOM','SUBSTATION',?,?)").run(region, u);
const units = db.prepare('SELECT unit_code, name, unit_type, parent_id, region_id, manager_person_id FROM org_unit').all();
const { UNIT_TYPES } = require('/workspace/backend/routes/org');
assert.ok(UNIT_TYPES.includes('OPERATIONAL_TECHNOLOGY'), 'OT unit type accepted');
assert.ok(UNIT_TYPES.includes('SUBSTATION_MAINTENANCE'), 'seeded dept type accepted');
console.log('PASS org: unit types include seeded departments and OT');
```

This test asserts only the exported `UNIT_TYPES`; export it from `org.js` (see implementation). The grouping change is exercised end to end in Task 12.

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/chain/org.test.js`
Expected: FAIL with `UNIT_TYPES is not a function` / `undefined` (not exported).

- [ ] **Step 3: Write minimal implementation**

In `backend/routes/org.js`, replace `UNIT_TYPES` with:

```js
const UNIT_TYPES = [
  'CORPORATE', 'BUSINESS_UNIT', 'DIVISION', 'REGION_DIRECTORATE',
  'DEPARTMENT', 'SUBSTATION_UNIT',
  'SUBSTATION_MAINTENANCE', 'TRANSMISSION_MAINTENANCE', 'RELAY_SCADA_TELECOM',
  'OPERATIONAL_TECHNOLOGY',
];
```

In `unitDetail`, replace:

```js
  out.crews = db.prepare('SELECT * FROM crew WHERE region_id = ? ORDER BY name').all(u.region_id);
```

with:

```js
  out.crews = db.prepare('SELECT * FROM crew WHERE org_unit_id = ? ORDER BY name').all(u.id);
```

At the bottom, change `module.exports = router;` to:

```js
module.exports = router;
module.exports.UNIT_TYPES = UNIT_TYPES;
```

(Express routers are functions, so attaching a property is safe and does not affect `app.use`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node /tmp/chain/org.test.js`
Expected: `PASS org: unit types include seeded departments and OT`

- [ ] **Step 5: Commit**

```bash
git add backend/routes/org.js
git commit -m "feat(org): group crews by owning unit and accept seeded unit types"
```

---

## Task 8: Seed OT division, center crews, and bootstrap reconcile

**Files:**
- Modify: `backend/seed_eep.js` (add OT persona + helpers; extend `reconcileSeedData`)
- Modify: `backend/server.js` (run `migrateRolesAndCrewUsers` after `reconcileSeedData`)
- Test: `/tmp/chain/seed.test.js`

**Interfaces:**
- Consumes: `db`, `ensurePerson`/`ensureUser`/`ensureOrgUnit`/`ensureCrew`/`insert`.
- Produces: org unit `DIV-OT` (type `OPERATIONAL_TECHNOLOGY`, manager `dir.ot`); crews `CREW-RC-SPECIAL`, `CREW-C1-SPECIAL`, `CREW-OT-RLY`, `CREW-OT-SCADA`; `reconcileSeedData()` also migrates legacy roles and backfills `crew.org_unit_id`.

- [ ] **Step 1: Write the failing test**

```js
// /tmp/chain/seed.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const dir = '/tmp/chain';
fs.mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/seed.db`;
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.TMMS_DB = dbPath;
const { db, initSchema } = require('/workspace/backend/db');
initSchema();
const { seedEep, reconcileSeedData } = require('/workspace/backend/seed_eep');
seedEep();
reconcileSeedData();
const ot = db.prepare("SELECT * FROM org_unit WHERE unit_code = 'DIV-OT'").get();
assert.ok(ot, 'DIV-OT exists');
assert.strictEqual(ot.unit_type, 'OPERATIONAL_TECHNOLOGY');
const codes = db.prepare('SELECT crew_code, org_unit_id FROM crew').all();
const byCode = Object.fromEntries(codes.map((c) => [c.crew_code, c]));
for (const code of ['CREW-RC-SPECIAL', 'CREW-C1-SPECIAL', 'CREW-OT-RLY', 'CREW-OT-SCADA']) {
  assert.ok(byCode[code], `${code} exists`);
  assert.ok(byCode[code].org_unit_id, `${code} linked to a unit`);
}
assert.ok(byCode['CREW-C1-SOM'].org_unit_id, 'C1 SOM backfilled');
assert.ok(byCode['CREW-C1-TLOM'].org_unit_id, 'C1 TLOM backfilled');
assert.ok(byCode['CREW-C1-RTSP'].org_unit_id, 'C1 RTSP backfilled');
assert.ok(db.prepare("SELECT id FROM user WHERE username = 'dir.ot' AND role = 'REGION_MANAGER'").get(), 'dir.ot user');
console.log('PASS seed: OT division, center crews, backfill');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/chain/seed.test.js`
Expected: FAIL with `AssertionError: DIV-OT exists`

- [ ] **Step 3: Add the OT persona and center-crew helper**

In `backend/seed_eep.js`, after the `C1_MANAGERS` array, add:

```js
const OT_PERSONA = {
  username: 'dir.ot', password: 'Executive@123', userRole: 'REGION_MANAGER',
  first_name: 'Tewodros', last_name: 'Alemu', personRole: 'MANAGER',
  title: 'Director, Operational Technology', email: 'ot@eep-tmms.com.et',
};

function ensureCenterCrew({ name, code, crewType, regionId, orgUnitId, lead, member }) {
  const leadId = ensurePerson({ first_name: lead.first_name, last_name: lead.last_name, role: lead.role, title: lead.title, email: lead.email, org_unit_id: orgUnitId });
  const memberId = ensurePerson({ first_name: member.first_name, last_name: member.last_name, role: member.role, title: member.title, email: member.email, org_unit_id: orgUnitId });
  ensureUser({ username: lead.username, password: lead.password, role: 'CREW_LEAD', regionId, personId: leadId });
  const existing = db.prepare('SELECT id FROM crew WHERE crew_code = ?').get(code);
  let cid;
  if (existing) {
    cid = existing.id;
    db.prepare('UPDATE crew SET org_unit_id = COALESCE(org_unit_id, ?) WHERE id = ?').run(orgUnitId, cid);
  } else {
    cid = insert('crew', ['name', 'crew_code', 'crew_type', 'region_id', 'leader_person_id', 'home_base', 'status', 'org_unit_id'], {
      name, crew_code: code, crew_type: crewType, region_id: regionId, leader_person_id: leadId,
      home_base: 'Central Depot', status: 'AVAILABLE', org_unit_id: orgUnitId,
    });
  }
  if (!db.prepare('SELECT id FROM crew_member WHERE crew_id = ? AND person_id = ?').get(cid, leadId)) {
    insert('crew_member', ['crew_id', 'person_id', 'role', 'skill_level', 'active'], { crew_id: cid, person_id: leadId, role: 'CREW_LEADER', skill_level: 'SENIOR', active: 1 });
  }
  if (!db.prepare('SELECT id FROM crew_member WHERE crew_id = ? AND person_id = ?').get(cid, memberId)) {
    insert('crew_member', ['crew_id', 'person_id', 'role', 'skill_level', 'active'], { crew_id: cid, person_id: memberId, role: 'LINEMAN', skill_level: 'SENIOR', active: 1 });
  }
  return cid;
}
```

- [ ] **Step 4: Add OT division + center crews + backfill + role migration**

In `backend/seed_eep.js`, before `reconcileSeedData`, add:

```js
function migrateLegacyManagerRoles() {
  const roles = ['SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER'];
  const n = db.prepare(`UPDATE user SET role = 'REGION_MANAGER' WHERE role IN (${roles.map(() => '?').join(',')})`).run(...roles).changes;
  if (n) console.log(`[seed_eep] migrated ${n} legacy manager role(s) to REGION_MANAGER`);
}

function ensureOperationalTechnology() {
  const tso = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIV-TSO-EXEC');
  const regCoord = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIV-REGCOORD');
  const dirC1 = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIR-C1');
  const c1 = db.prepare('SELECT id FROM region WHERE code = ?').get('C1');
  if (!tso || !c1) return;

  const otPid = ensurePerson({ first_name: OT_PERSONA.first_name, last_name: OT_PERSONA.last_name, role: OT_PERSONA.personRole, title: OT_PERSONA.title, email: OT_PERSONA.email });
  const otUnit = ensureOrgUnit({ code: 'DIV-OT', name: 'Operational Technology', unitType: 'OPERATIONAL_TECHNOLOGY', parentId: tso, managerPersonId: otPid });
  db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(otUnit, otPid);
  ensureUser({ username: OT_PERSONA.username, password: OT_PERSONA.password, role: OT_PERSONA.userRole, regionId: c1.id, personId: otPid });

  if (regCoord) {
    ensureCenterCrew({
      name: 'Region Coordination Special Works Crew', code: 'CREW-RC-SPECIAL', crewType: 'MAINTENANCE',
      regionId: c1.id, orgUnitId: regCoord.id,
      lead: { username: 'crew.rcspecial.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'RC', last_name: 'Special Lead', title: 'Region Coordination Special Works Lead', email: 'rcspecial.lead@eep-tmms.com.et' },
      member: { role: 'MEMBER', first_name: 'RC', last_name: 'Special Member', title: 'Special Works Technician', email: 'rcspecial.member@eep-tmms.com.et' },
    });
  }
  if (dirC1) {
    ensureCenterCrew({
      name: 'Central 1 Regional Special Works Crew', code: 'CREW-C1-SPECIAL', crewType: 'MAINTENANCE',
      regionId: c1.id, orgUnitId: dirC1.id,
      lead: { username: 'crew.c1special.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'C1', last_name: 'Special Lead', title: 'Central 1 Special Works Lead', email: 'c1special.lead@eep-tmms.com.et' },
      member: { role: 'MEMBER', first_name: 'C1', last_name: 'Special Member', title: 'Special Works Technician', email: 'c1special.member@eep-tmms.com.et' },
    });
  }
  ensureCenterCrew({
    name: 'OT Relay & Protection Crew', code: 'CREW-OT-RLY', crewType: 'RELAY_AND_PROTECTION',
    regionId: c1.id, orgUnitId: otUnit,
    lead: { username: 'crew.otrly.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'OT', last_name: 'Relay Lead', title: 'OT Relay & Protection Lead', email: 'otrly.lead@eep-tmms.com.et' },
    member: { role: 'MEMBER', first_name: 'OT', last_name: 'Relay Member', title: 'Protection Technician', email: 'otrly.member@eep-tmms.com.et' },
  });
  ensureCenterCrew({
    name: 'OT SCADA & RTU Crew', code: 'CREW-OT-SCADA', crewType: 'SCADA_RTU',
    regionId: c1.id, orgUnitId: otUnit,
    lead: { username: 'crew.otscada.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'OT', last_name: 'SCADA Lead', title: 'OT SCADA & RTU Lead', email: 'otscada.lead@eep-tmms.com.et' },
    member: { role: 'MEMBER', first_name: 'OT', last_name: 'SCADA Member', title: 'RTU Technician', email: 'otscada.member@eep-tmms.com.et' },
  });
}

const CREW_UNIT_MAP = [
  ['CREW-C1-SOM', 'DEPT-C1-SOM'],
  ['CREW-C1-TLOM', 'DEPT-C1-TLOM'],
  ['CREW-C1-RTSP', 'DEPT-C1-RS'],
];

function backfillCrewOrgUnits() {
  let n = 0;
  for (const [crewCode, unitCode] of CREW_UNIT_MAP) {
    const unit = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get(unitCode);
    if (!unit) continue;
    n += db.prepare('UPDATE crew SET org_unit_id = ? WHERE crew_code = ? AND (org_unit_id IS NULL OR org_unit_id != ?)').run(unit.id, crewCode, unit.id).changes;
  }
  const dirC1 = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIR-C1');
  const dirUser = db.prepare('SELECT person_id FROM user WHERE username = ?').get('dir.c1');
  if (dirC1 && dirUser && dirUser.person_id) {
    db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ? AND org_unit_id IS NULL').run(dirC1.id, dirUser.person_id);
  }
  if (n) console.log(`[seed_eep] backfilled ${n} crew org-unit link(s)`);
}
```

Then replace `reconcileSeedData` with:

```js
function reconcileSeedData() {
  migrateLegacyManagerRoles();
  ensureOperationalTechnology();
  backfillCrewOrgUnits();
  reconcileSeedUsers();
  reconcileCrewAccountPasswords();
  repairCrewData();
}
```

- [ ] **Step 5: Fix boot ordering**

In `backend/server.js`, swap lines so reconcile runs before crew-account provisioning:

```js
reconcileSeedData();
migrateRolesAndCrewUsers();
```

(Replace the current `migrateRolesAndCrewUsers(); reconcileSeedData();` order. `migrateRolesAndCrewUsers` is currently required on line 29; move its `require` above if needed.)

- [ ] **Step 6: Run test to verify it passes**

Run: `node /tmp/chain/seed.test.js`
Expected: `PASS seed: OT division, center crews, backfill`

- [ ] **Step 7: Commit**

```bash
git add backend/seed_eep.js backend/server.js
git commit -m "feat(seed): add OT division, center crews, and crew-ownership reconcile"
```

---

## Task 9: Frontend permission mirror

**Files:**
- Modify: `frontend/src/auth.js` (lines 20-45)

**Interfaces:**
- Consumes: none.
- Produces: `ROLE_PERMS.REGION_MANAGER` (and aliases) include `task:execute`, `gps:write`, `attachment:write`.

- [ ] **Step 1: Write the change**

In `frontend/src/auth.js`, after `OPERATIONS_WORKFLOW`, add:

```js
const REGION_MANAGER_PERMS = [...READ_PERMS, ...OPERATIONS_WORKFLOW, 'task:execute', 'gps:write', 'attachment:write'];
```

Replace the four entries `REGION_MANAGER`, `SUBSTATION_MANAGER`, `TRANSMISSION_MANAGER`, `RELAY_SCADA_MANAGER` in `ROLE_PERMS` with:

```js
  REGION_MANAGER: REGION_MANAGER_PERMS,
  SUBSTATION_MANAGER: REGION_MANAGER_PERMS,
  TRANSMISSION_MANAGER: REGION_MANAGER_PERMS,
  RELAY_SCADA_MANAGER: REGION_MANAGER_PERMS,
```

- [ ] **Step 2: Verify build**

Run: `npm run build` (workdir `frontend`)
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/auth.js
git commit -m "feat(frontend): mirror region manager execution permissions"
```

---

## Task 10: Frontend org labels

**Files:**
- Modify: `frontend/src/pages/Organization.jsx` (`UNIT_TYPE_LABEL` ~lines 6-13; `counts` ~lines 43-53)

**Interfaces:**
- Consumes: `/org-tree`, `/org-units` (now crew-grouped).
- Produces: labels for the seeded department types, OT, and correct department counts.

- [ ] **Step 1: Add labels and fix counts**

Replace `UNIT_TYPE_LABEL` with:

```js
const UNIT_TYPE_LABEL = {
  CORPORATE: 'Corporate HQ',
  BUSINESS_UNIT: 'Business Unit',
  DIVISION: 'Division',
  REGION_DIRECTORATE: 'Regional Directorate',
  DEPARTMENT: 'Department',
  SUBSTATION_UNIT: 'Substation Unit',
  SUBSTATION_MAINTENANCE: 'Substation O&M Department',
  TRANSMISSION_MAINTENANCE: 'Transmission Line & OPGW Department',
  RELAY_SCADA_TELECOM: 'RTU / Telecom / SCADA & Protection',
  OPERATIONAL_TECHNOLOGY: 'Operational Technology',
};
```

Replace the `departments` count line with:

```js
      departments: flat.filter((u) => ['DEPARTMENT', 'SUBSTATION_MAINTENANCE', 'TRANSMISSION_MAINTENANCE', 'RELAY_SCADA_TELECOM', 'OPERATIONAL_TECHNOLOGY'].includes(u.unit_type)).length,
```

- [ ] **Step 2: Verify build**

Run: `npm run build` (workdir `frontend`)
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Organization.jsx
git commit -m "feat(org-ui): label OT and seeded department unit types"
```

---

## Task 11: Frontend assignable crew pickers

**Files:**
- Modify: `frontend/src/components/TaskWorkPanel.jsx` (crew fetch ~line 32; assign select ~line 117)
- Modify: `frontend/src/pages/Tasks.jsx` (crew fetch ~line 62; bulk assign picker ~line 206)
- Modify: `frontend/src/pages/Settings.jsx` (ROLES option render ~line 296)
- Modify: `frontend/src/pages/Login.jsx` (DEMO list ~lines 6-20)

**Interfaces:**
- Consumes: `/crews` `assignable` flag.
- Produces: only authorized crews offered for assignment; legacy role options labelled; OT/center demo logins listed.

- [ ] **Step 1: Filter in TaskWorkPanel**

In `frontend/src/components/TaskWorkPanel.jsx`, after the state declarations, add:

```js
  const assignableCrews = crews.filter((c) => c.assignable !== false);
```

Replace the assign `<select>` options:

```jsx
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
```

with:

```jsx
                {assignableCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
```

- [ ] **Step 2: Filter in Tasks bulk assign**

In `frontend/src/pages/Tasks.jsx`, near the other derived values, add:

```js
  const assignableCrews = crews.filter((c) => c.assignable !== false);
```

At the bulk-assign picker (around line 206, the `<select>` that feeds `act('assign', ...)`), replace:

```jsx
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
```

with:

```jsx
                {assignableCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
```

Leave the filter dropdown (line ~181) using `crews` so managers can still filter by any visible crew.

- [ ] **Step 3: Label legacy roles in Settings**

In `frontend/src/pages/Settings.jsx`, after the `ROLES` array, add:

```js
const LEGACY_ROLES = new Set(['SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER']);
```

Replace line 296:

```jsx
                    {ROLES.map((r) => <option key={r}>{r}</option>)}
```

with:

```jsx
                    {ROLES.map((r) => <option key={r}>{LEGACY_ROLES.has(r) ? `${r} (legacy)` : r}</option>)}
```

- [ ] **Step 4: Add demo logins**

In `frontend/src/pages/Login.jsx`, insert after the `dir.c1` entry:

```js
  ['dir.ot', 'Executive@123', 'REGION_MANAGER', 'executive'],
```

and after the `crew.c1` entry:

```js
  ['crew.otrly.lead', 'Crew@123', 'CREW_LEAD', 'crew'],
  ['crew.c1special.lead', 'Crew@123', 'CREW_LEAD', 'crew'],
```

- [ ] **Step 5: Verify build**

Run: `npm run build` (workdir `frontend`)
Expected: build succeeds with no unused-variable errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/TaskWorkPanel.jsx frontend/src/pages/Tasks.jsx frontend/src/pages/Settings.jsx frontend/src/pages/Login.jsx
git commit -m "feat(ui): limit assignable crews and surface OT/center personas"
```

---

## Task 12: End-to-end enforcement test

**Files:**
- Create: `/tmp/chain/e2e.js` (not committed)
- Uses: a `VACUUM INTO` snapshot of the dev DB

**Interfaces:**
- Consumes: running backend + real demo accounts.
- Produces: asserts the spec's eight scenarios.

- [ ] **Step 1: Write the harness**

```js
// /tmp/chain/e2e.js
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const dir = '/tmp/chain-e2e';
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, 'tmms.db');
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch {} }

// 1. Consistent snapshot of the dev DB without touching it.
const src = new DatabaseSync('/workspace/backend/tmms.db', { readOnly: true });
src.exec(`VACUUM INTO '${dbPath}'`);
src.close();

// 2. Fixture: a C2 relay (functional) and C2 substation (non-functional) crew.
const raw = new DatabaseSync(dbPath);
const c2 = raw.prepare("SELECT id FROM region WHERE code = 'C2'").get();
assert.ok(c2, 'C2 region seeded');
const uOt = raw.prepare("SELECT id FROM org_unit WHERE unit_code = 'DIV-OT'").get();
raw.prepare("INSERT INTO crew (name,crew_code,crew_type,region_id,org_unit_id) VALUES ('C2 Relay','E2E-C2-RELAY','RELAY_AND_PROTECTION',?,?)").run(c2.id, uOt.id);
raw.prepare("INSERT INTO crew (name,crew_code,crew_type,region_id) VALUES ('C2 Substation','E2E-C2-SOM','SUBSTATION',?)").run(c2.id);
const crewRow = (code) => raw.prepare('SELECT id FROM crew WHERE crew_code = ?').get(code).id;
const ids = {
  som: crewRow('CREW-C1-SOM'), tlom: crewRow('CREW-C1-TLOM'), rtsp: crewRow('CREW-C1-RTSP'),
  c2relay: crewRow('E2E-C2-RELAY'), c2som: crewRow('E2E-C2-SOM'),
};
raw.close();

// 3. Start the server on the snapshot.
const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}/api`;
const server = spawn('node', ['server.js'], {
  cwd: '/workspace/backend',
  env: { ...process.env, TMMS_DB: dbPath, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[srv:err] ${d}`));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

async function login(username, password) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.strictEqual(r.status, 200, `login ${username}`);
  const { token } = await r.json();
  return token;
}

async function api(token, method, url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function createTask(token, title) {
  const r = await api(token, 'POST', '/tasks', {
    title, task_type: 'INSPECTION', priority: 'MEDIUM', due_date: new Date(Date.now() + 86400000).toISOString(), region_id: 1,
  });
  assert.strictEqual(r.status, 201, `create task: ${JSON.stringify(r.json)}`);
  return r.json.id;
}

(async () => {
  await waitUp();
  const som = await login('mgr.c1.som', 'Manager@123');
  const tlom = await login('mgr.c1.tlom', 'Manager@123');
  const ot = await login('dir.ot', 'Executive@123');
  const dir = await login('dir.c1', 'Region@123');

  // Scenario 1: SOM manager assigns its own crew.
  let t = await createTask(som, 'E2E SOM own crew');
  let r = await api(som, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.som });
  assert.strictEqual(r.status, 200, `SOM->SOM: ${JSON.stringify(r.json)}`);

  // Scenario 2: SOM manager cannot assign the TLOM crew.
  t = await createTask(som, 'E2E SOM cross-dept');
  r = await api(som, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.tlom });
  assert.strictEqual(r.status, 403, `SOM->TLOM should 403, got ${r.status}`);

  // Scenario 3: Region Director assigns any C1 crew.
  t = await createTask(dir, 'E2E director');
  r = await api(dir, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.tlom });
  assert.strictEqual(r.status, 200, `DIR->TLOM: ${JSON.stringify(r.json)}`);

  // Scenario 4: OT manager assigns functional crews (in-region and cross-region).
  t = await createTask(ot, 'E2E OT rtsp');
  r = await api(ot, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.rtsp });
  assert.strictEqual(r.status, 200, `OT->RTSP: ${JSON.stringify(r.json)}`);
  t = await createTask(ot, 'E2E OT cross-region relay');
  r = await api(ot, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.c2relay });
  assert.strictEqual(r.status, 200, `OT->C2 relay: ${JSON.stringify(r.json)}`);

  // Scenario 5: OT manager cannot assign an out-of-region non-functional crew.
  t = await createTask(ot, 'E2E OT cross-region nonfunctional');
  r = await api(ot, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.c2som });
  assert.strictEqual(r.status, 403, `OT->C2 SOM should 403, got ${r.status}`);

  // Scenario 6: manager can execute a checklist (task:execute granted).
  t = await createTask(som, 'E2E execute');
  r = await api(som, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.som });
  assert.strictEqual(r.status, 200, 'assign for execute');
  // No template required to prove permission: GET checklist returns 400 (no template), not 403.
  r = await api(som, 'GET', `/tasks/${t}/checklist`);
  assert.notStrictEqual(r.status, 403, `manager checklist permission, got ${r.status}`);
  // A crew member still cannot assign.
  const member = await login('crew.c1som.m3', 'Member@123');
  t = await createTask(som, 'E2E member');
  r = await api(member, 'POST', `/tasks/${t}/state`, { action: 'assign', crew_id: ids.som });
  assert.ok(r.status === 403 || r.status === 404, `crew member assign blocked, got ${r.status}`);

  console.log('PASS e2e: chain-of-command enforcement');
  server.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error(e); server.kill('SIGTERM'); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `node /tmp/chain/e2e.js`
Expected: `PASS e2e: chain-of-command enforcement`

If `crew.c1som.m3` does not exist in the snapshot, list crew member logins from the server log role summary and substitute the actual CREW_MEMBER username for the C1 SOM crew; the assertion only requires it be blocked (403/404).

- [ ] **Step 3: Commit**

No repository files change in this task (test lives in `/tmp`). Proceed.

---

## Task 13: Full regression and verification

**Files:**
- No new files unless a regression fails.

**Interfaces:**
- Consumes: existing `/tmp/atomicity-test/*.js` suites.
- Produces: confirmed green baseline.

- [ ] **Step 1: Syntax-check every touched backend file**

Run:
```bash
node --check backend/authority.js
node --check backend/db.js
node --check backend/auth.js
node --check backend/routes/tasks.js
node --check backend/routes/crews.js
node --check backend/routes/org.js
node --check backend/seed_eep.js
node --check backend/server.js
```
Expected: all succeed.

- [ ] **Step 2: Frontend build**

Run: `npm run build` (workdir `frontend`)
Expected: build succeeds.

- [ ] **Step 3: Run unit tests**

Run:
```bash
node /tmp/chain/migrate.test.js
node /tmp/chain/authority.test.js
node /tmp/chain/perms.test.js
node /tmp/chain/org.test.js
node /tmp/chain/seed.test.js
```
Expected: all print `PASS ...`.

- [ ] **Step 4: Run the existing 57-check regression**

Make a fresh snapshot and run the suites with `TMMS_DB` pointed at it, mirroring the existing workflow:

```bash
mkdir -p /tmp/chain-reg
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/workspace/backend/tmms.db',{readOnly:true});db.exec(\"VACUUM INTO '/tmp/chain-reg/tmms.db'\");db.close();"
TMMS_DB=/tmp/chain-reg/tmms.db node /tmp/atomicity-test/smoke.js
TMMS_DB=/tmp/chain-reg/tmms.db node /tmp/atomicity-test/security-http.js
TMMS_DB=/tmp/chain-reg/tmms.db node /tmp/atomicity-test/correctness.js
TMMS_DB=/tmp/chain-reg/tmms.db node /tmp/atomicity-test/probe.js
TMMS_DB=/tmp/chain-reg/tmms.db node /tmp/atomicity-test/security-probe.js
```

Expected: same pass counts as the established baseline (57/57 total). If a suite itself starts its own server, pass `TMMS_DB` and start from a fresh snapshot each time (stop the previous server by its background terminal id, never `pkill`).

- [ ] **Step 5: Re-run the E2E**

Run: `node /tmp/chain/e2e.js`
Expected: `PASS e2e: chain-of-command enforcement`

- [ ] **Step 6: Commit any regression fixes**

If a suite exposed a regression, fix it and commit:

```bash
git add <files actually changed>
git commit -m "fix: keep regression suite green after authority changes"
```

If nothing changed, no commit.

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1), authority rules (Task 2), permissions + aliases (Task 3), enforcement points (Tasks 4-7), seeding/reconcile (Task 8), frontend (Tasks 9-11), testing (Tasks 12-13), rollout (additive migration + reconcile, no push).
- **Out of scope by design:** `backend/seed.js` `ensureOrgHierarchy` is dead code — it is exported but never called from `server.js`, so it is intentionally left untouched to avoid churn. Automatic task routing, approval chains, and explicit per-region OT grants are out of scope.
- **Type consistency:** `canAssignCrew(user, crewId)`, `canViewCrew(user, crew)`, `canManageUnit(user, unitId)`, `taskVisible(user, task)`, `authorizedCrewIds(user)`, `unitSubtree(unitId)`, `userUnitId(user)`, `isFunctionalCrew(crew)` are used with the same signatures across `tasks.js`, `crews.js`, and the tests.
- **Important:** `dev` DB boot reconcile writes `crew.org_unit_id`, migrates manager roles, and creates `dir.ot`/center crews. Back up `backend/tmms.db` before the first boot after Task 8 (copy `tmms.db`, `tmms.db-wal`, `tmms.db-shm` with the server stopped, or use `VACUUM INTO`).
