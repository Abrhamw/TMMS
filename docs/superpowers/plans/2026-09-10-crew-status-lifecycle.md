# Crew Status Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive crew status automatically from active tasks (`AVAILABLE` / `ASSIGNED` / `ON_TASK`), let `crew:write` users set a sticky manual override (`OFF_DUTY` / `UNAVAILABLE` / pinned `AVAILABLE`) with an `Auto` reset, and surface status plus active-task counts across the crew roster, detail, eligibility check, and crew pickers.

**Architecture:** A new `backend/crewStatus.js` module owns the single derivation rule and a cache-sync helper; both `routes/crews.js` and `routes/tasks.js` consume it. The persisted `crew.status` column becomes a cache written by `syncCrewStatus`, while `crew.status_override` holds manual intent and wins when set. The API always returns the effective status computed at read time, so the UI never sees a stale value.

**Tech Stack:** Node.js >= 22.5.0, Express 5 (CommonJS), `node:sqlite` `DatabaseSync`, React + Vite frontend. No automated test framework — verification is `node --check`, module-load smoke, `curl` against the running API, and a frontend production build.

## Global Constraints

- No automated test framework exists. Do not introduce one; verify with the exact commands given.
- Backend is CommonJS; use `require(...)`, not `import`.
- Never add comments to code unless a step explicitly includes them.
- SQLite access goes through the shared `db` from `backend/util.js` (or `backend/db.js`).
- `cleanRow` (`backend/util.js:39`) drops `null`/`undefined`, so clearing a nullable column requires explicit SQL.
- Commits are on `master`; stage only the files listed in each task. Do not commit `backend/tmms.db*` or `backend/uploads/`.
- Do not push.

## File Structure

- Create: `backend/crewStatus.js` — pure derivation + cache-sync helpers; depends only on `db`.
- Modify: `backend/db.js` — add the `crew.status_override` inline migration.
- Modify: `backend/routes/crews.js` — `crewDetail` effective fields, write-endpoint override handling, eligibility endpoint, full task list on detail.
- Modify: `backend/routes/tasks.js` — sync crew status after a task transition and its side effects.
- Modify: `frontend/src/api.js` — status colors for `ON_TASK`, `OFF_DUTY`, `UNAVAILABLE`.
- Modify: `frontend/src/pages/Crews.jsx` — roster tag, detail status control, form override, eligibility columns.
- Modify: `frontend/src/pages/Tasks.jsx`, `frontend/src/pages/Assets.jsx`, `frontend/src/pages/Schedules.jsx` — annotate crew options and disable unavailable ones.

---

### Task 1: Derivation module and schema migration

**Files:**
- Create: `backend/crewStatus.js`
- Modify: `backend/db.js` (add migration beside the other `migrate(...)` calls, around `db.js:515-524`)

**Interfaces:**
- Consumes: `db` from `backend/util.js`.
- Produces:
  - `deriveCrewStatus(crewId: number, useOverride?: boolean): 'AVAILABLE'|'ASSIGNED'|'ON_TASK'|'OFF_DUTY'|'UNAVAILABLE'`
  - `syncCrewStatus(crewId: number): string|null` — writes `crew.status` and returns the value (or `null` for a falsy/missing id).
  - `CREW_STATUS_OVERRIDES: string[]` — `['AVAILABLE','OFF_DUTY','UNAVAILABLE']`

- [ ] **Step 1: Add the migration**

In `backend/db.js`, next to `migrate('asset', 'default_crew_id', ...)` (around line 521), add:

```js
  migrate('crew', 'status_override', 'ALTER TABLE crew ADD COLUMN status_override TEXT');
```

- [ ] **Step 2: Create the module**

Create `backend/crewStatus.js`:

```js
const { db } = require('./util');

const CREW_STATUS_OVERRIDES = ['AVAILABLE', 'OFF_DUTY', 'UNAVAILABLE'];
const ON_TASK_STATES = ['IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
const ASSIGNED_STATES = ['ASSIGNED', 'SCHEDULED', 'DRAFT'];

function deriveCrewStatus(crewId, useOverride = true) {
  const crew = db.prepare('SELECT id, status_override FROM crew WHERE id = ?').get(crewId);
  if (!crew) return 'AVAILABLE';
  if (useOverride && crew.status_override) return crew.status_override;
  const rows = db.prepare(
    "SELECT status FROM task WHERE crew_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).all(crewId);
  const statuses = new Set(rows.map((r) => r.status));
  if (ON_TASK_STATES.some((s) => statuses.has(s))) return 'ON_TASK';
  if (ASSIGNED_STATES.some((s) => statuses.has(s))) return 'ASSIGNED';
  return 'AVAILABLE';
}

function syncCrewStatus(crewId) {
  if (!crewId) return null;
  const crew = db.prepare('SELECT id FROM crew WHERE id = ?').get(crewId);
  if (!crew) return null;
  const status = deriveCrewStatus(crewId);
  db.prepare('UPDATE crew SET status = ? WHERE id = ?').run(status, crewId);
  return status;
}

module.exports = { deriveCrewStatus, syncCrewStatus, CREW_STATUS_OVERRIDES };
```

- [ ] **Step 3: Verify the module loads and derivation runs**

Run (from `/workspace`):

```bash
node --check backend/crewStatus.js && node -e "const {deriveCrewStatus,syncCrewStatus}=require('./backend/crewStatus');const row=require('./backend/util').db.prepare('SELECT id FROM crew LIMIT 1').get();console.log(row?deriveCrewStatus(row.id):'no crews')"
```

Expected: prints `AVAILABLE`, `ASSIGNED`, `ON_TASK`, `OFF_DUTY`, or `UNAVAILABLE` (or `no crews` on an empty DB) with no stack trace. `node --check` produces no output.

- [ ] **Step 4: Confirm the migration applies**

Restart the backend dev process, then run:

```bash
node -e "console.log(require('./backend/util').db.prepare('PRAGMA table_info(crew)').all().map(c=>c.name).join(','))"
```

Expected: the printed column list includes `status_override`.

- [ ] **Step 5: Commit**

```bash
git add backend/crewStatus.js backend/db.js
git commit -m "feat(crew): add derived crew status module and status_override column"
```

---

### Task 2: Crew API — effective status, overrides, eligibility

**Files:**
- Modify: `backend/routes/crews.js`
- Test: manual `curl` (see Step 6)

**Interfaces:**
- Consumes: `deriveCrewStatus`, `syncCrewStatus`, `CREW_STATUS_OVERRIDES` from Task 1.
- Produces (response fields on `crewDetail`):
  - `status` — effective status
  - `status_override` — `string|null`
  - `derived_status` — task-derived status string
  - `open_task_count` — number
- Produces (`GET /api/crews/eligibility` item fields, in addition to existing `eligible`, `missing_certs`, `score`):
  - `status`, `open_task_count`, `selectable: boolean`, `busy: boolean`

- [ ] **Step 1: Import the helpers**

At the top of `backend/routes/crews.js`, after `const { taskProgress } = require('../taskProgress');` (line 4), add:

```js
const { deriveCrewStatus, syncCrewStatus, CREW_STATUS_OVERRIDES } = require('../crewStatus');
```

- [ ] **Step 2: Add override helpers**

Immediately after the `crewDetail` function (after line 21), add:

```js
function overrideError(value) {
  if (value === undefined || value === null || value === '') return null;
  return CREW_STATUS_OVERRIDES.includes(value) ? null : `Invalid status_override: ${value}`;
}

function setCrewOverride(crewId, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('UPDATE crew SET status_override = NULL WHERE id = ?').run(crewId);
  } else {
    db.prepare('UPDATE crew SET status_override = ? WHERE id = ?').run(value, crewId);
  }
}
```

- [ ] **Step 3: Return effective status from `crewDetail`**

In `crewDetail`, replace the block that ends with `out.open_task_count = openTasks;\n  return out;` (lines 19-20) with:

```js
  out.open_task_count = openTasks;
  out.status_override = c.status_override || null;
  out.derived_status = deriveCrewStatus(c.id, false);
  out.status = deriveCrewStatus(c.id);
  return out;
```

- [ ] **Step 4: Make eligibility return all crews with status/flags**

Replace the `router.get('/crews/eligibility', ...)` body (lines 88-108) with:

```js
router.get('/crews/eligibility', (req, res) => {
  if (!can(req, 'task:assign')) return res.status(403).json({ error: 'Forbidden: requires task:assign' });
  const { region_id, task_type } = req.query;
  let rows = scopeRows(req.user, list('crew'), (c) => c.region_id);
  if (region_id) rows = rows.filter((c) => c.region_id === Number(region_id));
  const neededCerts = task_type === 'PREVENTIVE' ? ['SF6_HANDLING'] : task_type === 'INSPECTION' ? [] : ['LIVE_LINE'];
  const result = rows.map((c) => {
    const detail = crewDetail(c);
    const certTypes = new Set(detail.certifications.filter((x) => x.status === 'VALID').map((x) => x.cert_type));
    const missing = neededCerts.filter((nc) => !certTypes.has(nc));
    const certScore = missing.length === 0 ? 1 : missing.length === neededCerts.length ? 0 : 0.5;
    const loadFactor = Math.max(0, 1 - detail.open_task_count / 8);
    const selectable = detail.status !== 'OFF_DUTY' && detail.status !== 'UNAVAILABLE';
    return {
      ...detail,
      eligible: missing.length === 0,
      missing_certs: missing,
      selectable,
      busy: detail.status === 'ON_TASK',
      score: Math.round((certScore * 0.5 + loadFactor * 0.5) * 100) / 100,
    };
  }).sort((a, b) => b.score - a.score);
  res.json(result);
});
```

- [ ] **Step 5: Accept `status_override` on create/update and guard members**

Replace the `router.post('/crews', ...)` handler (lines 122-137) with:

```js
router.post('/crews', (req, res) => {
  if (!can(req, 'crew:write')) return res.status(403).json({ error: 'Forbidden: requires crew:write' });
  if (!isGlobal(req.user)) req.body.region_id = req.user.region_id;
  const { members, status, status_override, ...fields } = req.body || {};
  const invalid = overrideError(status_override);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const id = withTx(() => {
      const crewId = insertRow('crew', { ...fields, status_override: status_override || null, revision: 1 });
      reconcileMembers(crewId, members);
      return crewId;
    });
    syncCrewStatus(id);
    audit(req.user, 'CREATE', 'crew', id, { ...fields, status_override, members });
    res.status(201).json(crewDetail(get('crew', id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

Replace the `router.put('/crews/:id', ...)` handler (lines 139-155) with:

```js
router.put('/crews/:id', (req, res) => {
  if (!can(req, 'crew:write')) return res.status(403).json({ error: 'Forbidden: requires crew:write' });
  const c = get('crew', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Crew not found' });
  if (!checkRegion(req, res, c.region_id)) return;
  const { members, status, status_override, ...fields } = req.body || {};
  const invalid = overrideError(status_override);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    withTx(() => {
      updateRow('crew', Number(req.params.id), { ...fields }, [], 'revision');
      if (status_override !== undefined) setCrewOverride(Number(req.params.id), status_override);
      if (members !== undefined) reconcileMembers(Number(req.params.id), members);
    });
    syncCrewStatus(Number(req.params.id));
    audit(req.user, 'UPDATE', 'crew', Number(req.params.id), { ...fields, status_override, members });
    res.json(crewDetail(get('crew', Number(req.params.id))));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

- [ ] **Step 6: Return the full task list on crew detail**

In `router.get('/crews/:id', ...)`, change the task query (line 117) from:

```js
  detail.tasks = db.prepare("SELECT * FROM task WHERE crew_id = ? ORDER BY created_at DESC LIMIT 50").all(c.id);
```

to:

```js
  detail.tasks = db.prepare("SELECT * FROM task WHERE crew_id = ? ORDER BY created_at DESC").all(c.id);
```

- [ ] **Step 7: Verify with the running API**

Restart the backend, then:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
curl -s http://localhost:3001/api/crews -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.length,r.map(c=>c.name+':'+c.status+'/'+c.derived_status+'/'+c.open_task_count).join(' | '))})"
curl -s "http://localhost:3001/api/crews/eligibility?region_id=1&task_type=EMERGENCY" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.map(c=>c.name+':'+c.status+':'+c.selectable+':'+c.busy).join(' | '))})"
```

Expected: `/api/crews` returns every crew with a `status` in the allowed set and a numeric `open_task_count`; eligibility returns crews including `OFF_DUTY`/`UNAVAILABLE` ones with `selectable:false`, and `ON_TASK` ones with `busy:true`.

- [ ] **Step 8: Commit**

```bash
git add backend/routes/crews.js
git commit -m "feat(crew): expose derived status, manual overrides, and full eligibility list"
```

---

### Task 3: Sync crew status on task transitions

**Files:**
- Modify: `backend/routes/tasks.js`

**Interfaces:**
- Consumes: `syncCrewStatus` from Task 1.
- Produces: no new exports; side effect only.

- [ ] **Step 1: Import the helper**

At the top of `backend/routes/tasks.js`, add a require alongside the existing requires (near the top of the file, after the `taskProgress`/`util` requires):

```js
const { syncCrewStatus } = require('../crewStatus');
```

- [ ] **Step 2: Sync after the transition and its side effects**

In `router.post('/tasks/:id/state', ...)`, the handler currently ends with (lines 410-412):

```js
  audit(req.user, action.toUpperCase(), 'task', id, { from: t.status, to: tr.to });
  if (action === 'verify') applyCompletionSideEffects(req, get('task', id), completionCost);
  res.json(taskDetail(get('task', id)));
```

Replace those three lines with:

```js
  audit(req.user, action.toUpperCase(), 'task', id, { from: t.status, to: tr.to });
  if (action === 'verify') applyCompletionSideEffects(req, get('task', id), completionCost);
  const updatedTask = get('task', id);
  if (updatedTask.crew_id) {
    try { syncCrewStatus(updatedTask.crew_id); } catch (e) { console.error('crew status sync failed', e); }
  }
  res.json(taskDetail(updatedTask));
```

- [ ] **Step 3: Verify the lifecycle via the API**

Restart the backend, then (with `TOKEN` from Task 2 Step 7):

```bash
CREW=$(curl -s http://localhost:3001/api/crews -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
TASK=$(curl -s http://localhost:3001/api/tasks -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);const t=r.find(x=>['DRAFT','SCHEDULED'].includes(x.status));console.log(t?t.id:'')})")
echo "crew=$CREW task=$TASK"
```

Then drive `TASK` through `assign` (`{"action":"assign","crew_id":<crew>}`) and `start` via `POST /api/tasks/$TASK/state`, re-reading `GET /api/crews/$CREW` after each and checking `status` moves `DRAFT/SCHEDULED` -> `ON_TASK`. Expected: the crew's `status` changes without any crew write.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(crew): keep crew status in sync on task transitions"
```

---

### Task 4: Status colors and Crews page

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/pages/Crews.jsx`

**Interfaces:**
- Consumes: `status`, `status_override`, `derived_status`, `open_task_count`, `selectable`, `busy` from Task 2.
- Produces: no exports; UI only.

- [ ] **Step 1: Add status colors**

In `frontend/src/api.js` `STATUS_COLORS` (line 112), add after `IN_PROGRESS: '#3b82f6',` (line 126):

```js
  ON_TASK: '#0ea5e9',
  OFF_DUTY: '#6b7280',
  UNAVAILABLE: '#ef4444',
```

- [ ] **Step 2: Update the blank form and roster**

In `frontend/src/pages/Crews.jsx`, change `blank` (line 11) to:

```js
const blank = { name: '', crew_code: '', crew_type: 'MAINTENANCE', region_id: null, leader_person_id: null, home_base: '', status_override: null, members: [] };
```

Replace the roster status cell (line 148) with:

```jsx
                    <td>
                      <Pill value={c.status} />
                      {c.open_task_count > 0 && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{c.open_task_count} active</span>}
                    </td>
```

- [ ] **Step 3: Add the override handler**

In the component, after `openDetail` (line 108), add:

```js
  async function setOverride(value) {
    try {
      await api.put(`/crews/${detail.id}`, { status_override: value === '' ? null : value });
      await openDetail({ id: detail.id });
      load();
    } catch (e) { setError(e.message); }
  }
```

- [ ] **Step 4: Add the detail status control**

In the detail modal `kv` block, replace the Status row (line 235):

```jsx
                <span className="k">Status</span><span><Pill value={detail.status} /></span>
```

with:

```jsx
                <span className="k">Status</span>
                <span>
                  <Pill value={detail.status} />
                  {detail.status_override && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>auto: {detail.derived_status}</span>}
                  {canWrite && (
                    <select value={detail.status_override || ''} style={{ marginLeft: 8 }} onChange={(e) => setOverride(e.target.value)}>
                      <option value="">Auto</option>
                      <option value="AVAILABLE">AVAILABLE</option>
                      <option value="OFF_DUTY">OFF_DUTY</option>
                      <option value="UNAVAILABLE">UNAVAILABLE</option>
                    </select>
                  )}
                </span>
```

Change the "Recent Tasks" heading (line 264) to `Tasks` and leave the table as-is (it now renders the full list).

- [ ] **Step 5: Add the override field to the add/edit form**

In the form grid in the Add/Edit modal, after the Home base field (line 304), add:

```jsx
            <div className="field"><label>Status override</label>
              <select value={form.status_override || ''} onChange={(e) => setForm({ ...form, status_override: e.target.value || null })}>
                <option value="">Auto</option>
                <option value="AVAILABLE">AVAILABLE</option>
                <option value="OFF_DUTY">OFF_DUTY</option>
                <option value="UNAVAILABLE">UNAVAILABLE</option>
              </select></div>
```

- [ ] **Step 6: Add eligibility columns and disable unavailable rows**

Replace the eligibility table header (line 177) with:

```jsx
                <thead><tr><th>Crew</th><th>Status</th><th>Active</th><th>Eligible</th><th>Score</th><th>Missing certs</th></tr></thead>
```

Replace the eligibility row body (lines 180-185) with:

```jsx
                    <tr key={c.id} style={c.selectable === false ? { opacity: 0.55 } : undefined}>
                      <td>{c.name}</td>
                      <td><Pill value={c.status} />{c.busy ? <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>busy</span> : null}</td>
                      <td>{c.open_task_count}</td>
                      <td>{c.eligible ? <span className="ok">✓</span> : <span className="bad">✗</span>}</td>
                      <td>{c.score}</td>
                      <td>{(c.missing_certs || []).join(', ') || '—'}</td>
                    </tr>
```

- [ ] **Step 7: Verify with a production build**

Run (from `/workspace/frontend`):

```bash
npm run build
```

Expected: exit 0 (the pre-existing >500 kB chunk-size warning is fine).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api.js frontend/src/pages/Crews.jsx
git commit -m "feat(ui): show derived crew status, active-task tag, and override control"
```

---

### Task 5: Annotate crew selectors

**Files:**
- Modify: `frontend/src/pages/Tasks.jsx`
- Modify: `frontend/src/pages/Assets.jsx`
- Modify: `frontend/src/pages/Schedules.jsx`

**Interfaces:**
- Consumes: `status`, `open_task_count` from `GET /api/crews` (Task 2).
- Produces: no exports; UI only.

- [ ] **Step 1: Task page crew select**

In `frontend/src/pages/Tasks.jsx`, replace the crew `<select>` options (around line 310):

```jsx
              <select value={form.crew_id || ''} onChange={(e) => setForm({ ...form, crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— unassigned —</option>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
```

with:

```jsx
              <select value={form.crew_id || ''} onChange={(e) => setForm({ ...form, crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— unassigned —</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </select>
```

- [ ] **Step 2: Task quick-assign default**

In `frontend/src/pages/Tasks.jsx`, change the SCHEDULED assign button (line 127) so it defaults to the first selectable crew rather than `crews[0]`:

```jsx
      case 'SCHEDULED': return canAssign ? <button className="btn btn-sm btn-primary" onClick={() => act(t.id, 'assign', { crew_id: t.crew_id || (crews.find((c) => c.status !== 'OFF_DUTY' && c.status !== 'UNAVAILABLE') || {}).id })}>Assign</button> : null;
```

- [ ] **Step 3: Assets default-crew select**

In `frontend/src/pages/Assets.jsx`, replace the default-crew options (around line 397):

```jsx
              <select value={form.default_crew_id || ''} onChange={(e) => setForm({ ...form, default_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
```

with:

```jsx
              <select value={form.default_crew_id || ''} onChange={(e) => setForm({ ...form, default_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </select>
```

- [ ] **Step 4: Schedules responsible-crew select**

In `frontend/src/pages/Schedules.jsx`, replace the responsible-crew options (around line 202):

```jsx
              <select value={form.responsible_crew_id || ''} onChange={(e) => setForm({ ...form, responsible_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
```

with:

```jsx
              <select value={form.responsible_crew_id || ''} onChange={(e) => setForm({ ...form, responsible_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </select>
```

- [ ] **Step 5: Verify with a production build**

Run (from `/workspace/frontend`):

```bash
npm run build
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Tasks.jsx frontend/src/pages/Assets.jsx frontend/src/pages/Schedules.jsx
git commit -m "feat(ui): annotate crew pickers with derived status and active count"
```

---

### Task 6: End-to-end smoke

**Files:** none (verification only).

- [ ] **Step 1: Verify the override is sticky and resettable**

With the backend restarted and `TOKEN` from Task 2 Step 7:

```bash
CREW=$(curl -s http://localhost:3001/api/crews -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
curl -s -X PUT http://localhost:3001/api/crews/$CREW -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status_override":"OFF_DUTY"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log(c.status,c.status_override,c.derived_status,c.member_count)})"
curl -s -X PUT http://localhost:3001/api/crews/$CREW -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status_override":null}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log(c.status,c.status_override,c.derived_status,c.member_count)})"
```

Expected after the first PUT: `status` is `OFF_DUTY`, `status_override` is `OFF_DUTY`, and `member_count` is unchanged (not wiped). After the second: `status_override` is `null` and `status` equals `derived_status`.

- [ ] **Step 2: Verify invalid override is rejected**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT http://localhost:3001/api/crews/$CREW -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status_override":"ON_TASK"}'
```

Expected: `400`.

- [ ] **Step 3: Final build + UI smoke**

```bash
cd /workspace/frontend && npm run build
curl -s -o /dev/null -w "app=%{http_code}\n" http://localhost:5173/
```

Expected: build exit 0; `app=200`. Confirm visually on `/crews` that the roster shows status + active tag, the detail modal shows the override control and full task list, and `OFF_DUTY`/`UNAVAILABLE` crews are disabled in crew pickers.

- [ ] **Step 4: No commit** (verification only).

---

## Self-Review

- **Spec coverage:** §4.1 migration -> Task 1; §4.2/§5.1 derivation + `crewDetail` fields -> Tasks 1-2; §5.2 write endpoints + null-clear + members guard -> Task 2 Step 5; §5.3 eligibility -> Task 2 Step 4; §5.4 transition sync -> Task 3; §6.1 colors -> Task 4 Step 1; §6.2 roster/detail/form/full list -> Task 4 Steps 2-5 and Task 2 Step 6; §6.3 eligibility UI -> Task 4 Step 6; §6.4 selectors -> Task 5; §8 verification -> each task plus Task 6.
- **Placeholder scan:** no TBD/TODO; every code step shows full code.
- **Type consistency:** `deriveCrewStatus(crewId, useOverride)`, `syncCrewStatus(crewId)`, and `CREW_STATUS_OVERRIDES` are named identically in Tasks 1-3. Response field names `status_override`, `derived_status`, `open_task_count`, `selectable`, `busy` are identical across Tasks 2, 4, and 5.
