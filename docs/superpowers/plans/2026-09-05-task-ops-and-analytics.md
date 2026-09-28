# Task Operations & Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CSV task export, safe bulk task updates, region-scoped task KPIs, crew/person performance views, and display-only checklist progress % — porting the legacy EEP tooling without bypassing TMMS's workflow state machine or RBAC.

**Architecture:** Pure additions to the existing Express `backend/routes/tasks.js` plus a new `backend/routes/performance.js`. A single new pure module `backend/taskProgress.js` computes progress fields so tasks.js, reports.js and the export/KPI/performance code share one implementation. All writes keep going through the existing `updateRow`/`insertRow` + `audit` helpers. Frontend: one new `Progress` component plus additive UI in Tasks/Home/Reports and progress chips on existing task lists.

**Tech Stack:** Node 22 (>=22.5.0, `node:sqlite`), Express 5, plain React (Vite). Only `express` is a backend dependency — no new deps in this plan.

## Global Constraints

- Never write task `status` directly in bulk operations; status changes stay exclusively in `POST /tasks/:id/state`.
- New permission `task:bulk` added to the `OPERATIONS_WORKFLOW` array (backend `auth.js:86` and frontend mirror `frontend/src/auth.js:22`). DISPATCHER intentionally excluded. PLANNER gets it explicitly in both files.
- Region scoping is always via the existing `taskVisible(req.user, t)` predicate (tasks.js:16-20). Every bulk id passes it or the whole call 403s — never silently skip ids.
- Gating: export and KPI require `task:read` (every authenticated role has it). Performance requires `report:write`. UI mirrors gating via `can(user, ...)`.
- Progress fields are display-only. They are `progress_pct`, `progress_graded`, `progress_passed` and are never inputs to any state transition.
- CSV must be hand-rolled (no dependency): UTF-8 BOM prefix, RFC4180-style quoting (wrap field in quotes if it contains `,`, `"`, or newline; double any embedded `"`).
- Do not run destructive commands; background services are stopped via `background_terminal_kill <id>` only.
- All tests run against an isolated copy of the DB on port 3199 so live data on :3001 is untouched.
- Follow existing code style: 2-space indent, `const`, no new comments beyond the terse section comments already present.

---

### Task 1: Verification harness and `task:bulk` permission

**Files:**
- Create: `/tmp/opencode/tmms_e2e.py` (test helpers; never committed)
- Modify: `backend/auth.js:86`
- Modify: `frontend/src/auth.js:22`

**Interfaces:**
- Consumes: login credentials seeded in the copied DB: `mgr.c1.tlom`/`Manager@123` (TRANSMISSION_MANAGER), `crew.c1tlom.lead`/`Crew@123` (CREW_LEAD), `admin`/`Admin@123`.
- Produces: reusable python helpers `login(base, user, pw)`, `j(method, path, token=None, body=None, base=BASE)` that later tasks `exec()` to verify endpoints against `http://localhost:3199`.

- [ ] **Step 1: Add `task:bulk` to the backend permission set**

Edit `backend/auth.js:86`. Replace:

```js
const OPERATIONS_WORKFLOW = [...TASK_WORKFLOW, 'schedule:write', 'schedule:run', 'report:write', 'asset:evaluate'];
```

with:

```js
const OPERATIONS_WORKFLOW = [...TASK_WORKFLOW, 'schedule:write', 'schedule:run', 'report:write', 'asset:evaluate', 'task:bulk'];
```

Edit `backend/auth.js:105`. Replace:

```js
  PLANNER: new Set([...READ_PERMS, 'task:create', 'task:manage', 'schedule:write', 'schedule:run']),
```

with:

```js
  PLANNER: new Set([...READ_PERMS, 'task:create', 'task:manage', 'schedule:write', 'schedule:run', 'task:bulk']),
```

- [ ] **Step 2: Mirror in the frontend permission list**

Edit `frontend/src/auth.js:22`. Replace:

```js
const OPERATIONS_WORKFLOW = [...TASK_WORKFLOW, 'schedule:write', 'schedule:run', 'report:write', 'asset:evaluate'];
```

with:

```js
const OPERATIONS_WORKFLOW = [...TASK_WORKFLOW, 'schedule:write', 'schedule:run', 'report:write', 'asset:evaluate', 'task:bulk'];
```

Edit `frontend/src/auth.js:40`. Replace:

```js
  PLANNER: [...READ_PERMS, 'task:create', 'task:manage', 'schedule:write', 'schedule:run'],
```

with:

```js
  PLANNER: [...READ_PERMS, 'task:create', 'task:manage', 'schedule:write', 'schedule:run', 'task:bulk'],
```

- [ ] **Step 3: Syntax-check both files**

Run: `cd /workspace/backend && node -c auth.js`
Run: `cd /workspace/frontend && npx vite build 2>&1 | tail -3` — must end `✓ built in`.

- [ ] **Step 4: Create the isolated verification DB and start the test server**

Run: `cp -f /workspace/backend/tmms.db /tmp/opencode/tmms-a.db`
Create a background terminal (record its id as the "verify terminal"; all later backend tasks restart it the same way):

```
cd /workspace/backend && TMMS_DB=/tmp/opencode/tmms-a.db PORT=3199 node server.js
```

Wait for the log line `TMMS backend listening on http://localhost:3199`.

- [ ] **Step 5: Write shared python e2e helpers**

Create `/tmp/opencode/tmms_e2e.py`:

```python
import json, urllib.request, urllib.error

BASE = 'http://localhost:3199'

def _req(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read().decode('utf-8-sig') or '{}') if r.headers.get('Content-Type','').startswith('application/json') else r.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception:
            return e.code, {'error': 'non-json'}

def j(method, path, token=None, body=None):
    return _req(method, path, token, body)

def login(user, pw):
    st, r = j('POST', '/api/auth/login', body={'username': user, 'password': pw})
    assert st == 200 and 'token' in r, f'login {user} failed: {st} {r}'
    return r['token']
```

- [ ] **Step 6: Prove the harness reaches the seeded manager (verification server only)**

Run:

```python
python3 - <<'PY'
exec(open('/tmp/opencode/tmms_e2e.py').read())
t = login('mgr.c1.tlom', 'Manager@123')
st, r = j('GET', '/api/tasks', token=t)
print(st, len(r) if isinstance(r, list) else r)
assert st == 200 and isinstance(r, list) and len(r) > 0
PY
```

Expected: `200 <n>` for some n > 0.

- [ ] **Step 7: Commit**

```bash
git add backend/auth.js frontend/src/auth.js
git commit -m "feat(auth): add task:bulk permission to management roles and planner"
```

---

### Task 2: `taskProgress` helper module and progress fields on task rows

**Files:**
- Create: `backend/taskProgress.js`
- Modify: `backend/routes/tasks.js` (`taskDetail`, lines 22-35)

**Interfaces:**
- Produces: `taskProgress(taskId)` → `{ progress_pct, progress_graded, progress_passed }`. Used by Task 3 (export), Task 6 (performance import path via tasks serializer), and Task 7 (documents).

- [ ] **Step 1: Write the module**

Create `backend/taskProgress.js`:

```js
const { db } = require('./util');

function latestSubmittedExecution(taskId) {
  return db.prepare(
    'SELECT * FROM checklist_execution WHERE task_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(taskId) || null;
}

// Display-only checklist progress: pass rate over the graded items of the
// latest submitted execution. Never drives a state transition.
function taskProgress(taskId) {
  const execRow = latestSubmittedExecution(taskId);
  if (!execRow) return { progress_pct: 0, progress_graded: 0, progress_passed: 0 };
  const items = db.prepare('SELECT result FROM checklist_execution_item WHERE execution_id = ?').all(execRow.id);
  const graded = items.filter((i) => i.result === 'PASS' || i.result === 'FAIL').length;
  const passed = items.filter((i) => i.result === 'PASS').length;
  return {
    progress_pct: graded > 0 ? Math.round((passed / graded) * 100) : 0,
    progress_graded: graded,
    progress_passed: passed,
  };
}

module.exports = { taskProgress, latestSubmittedExecution };
```

Note: if `require('./util')` fails to expose `db` (it does — util.js re-exports `db`), keep this import exactly as shown.

- [ ] **Step 2: Syntax check**

Run: `cd /workspace/backend && node -c taskProgress.js`

- [ ] **Step 3: Wire progress fields into `taskDetail`**

Edit `backend/routes/tasks.js`. Add the require after line 6 (`const { listForTask } = require('./attachments');`):

```js
const { taskProgress } = require('../taskProgress');
```

Then, in `taskDetail` (lines 22-35), make it attach progress. Replace the whole function body with:

```js
function taskDetail(t) {
  if (!t) return t;
  const out = { ...t, ...taskProgress(t.id) };
  out.region = t.region_id ? get('region', t.region_id) : null;
  out.substation = t.substation_id ? get('substation', t.substation_id) : null;
  out.line = t.line_id ? get('transmission_line', t.line_id, ['route_json']) : null;
  out.tower = t.tower_id ? get('tower', t.tower_id) : null;
  out.asset = t.asset_id ? get('asset', t.asset_id) : null;
  out.crew = t.crew_id ? get('crew', t.crew_id) : null;
  out.checklist_template = t.checklist_template_id ? get('checklist_template', t.checklist_template_id) : null;
  out.schedule = t.schedule_id ? get('maintenance_schedule', t.schedule_id) : null;
  out.links = db.prepare('SELECT * FROM task_link WHERE task_id = ?').all(t.id);
  return out;
}
```

- [ ] **Step 4: Restart the verify server and assert progress on a completed task**

Kill the verify terminal (id from Task 1) with `background_terminal_kill`, then create it again with the exact Task 1 command.

Run:

```python
python3 - <<'PY'
exec(open('/tmp/opencode/tmms_e2e.py').read())
t = login('mgr.c1.tlom', 'Manager@123')
st, tasks = j('GET', '/api/tasks', token=t)
assert st == 200
done = [x for x in tasks if x.get('result') == 'PASS' and x.get('status') == 'COMPLETED']
print('completed pass tasks:', [(x['id'], x['progress_pct'], x['progress_graded'], x['progress_passed']) for x in done])
# Every row must carry the three progress fields.
for x in tasks:
    assert set(['progress_pct', 'progress_graded', 'progress_passed']).issubset(x), x['id']
assert len(done) >= 1
# The seeded completed PASS task (TK-2026-000004) must be 100%.
t6 = [x for x in tasks if x['id'] == 6]
assert not t6 or t6[0]['progress_pct'] == 100
print('OK')
PY
```

Expected: prints completed pass tasks incl. `(6, 100, ...)` and `OK`.

- [ ] **Step 5: Commit**

```bash
git add backend/taskProgress.js backend/routes/tasks.js
git commit -m "feat(tasks): add display-only checklist progress to task serializer"
```

---

### Task 3: CSV export

**Files:**
- Modify: `backend/routes/tasks.js` (refactor `GET /tasks`, add `GET /tasks/export.csv`)

**Interfaces:**
- Consumes: `taskProgress` (Task 2); `scopedTasks(req)` helper introduced here is reused by Task 5.
- Produces: helper `scopedTasks(req)` → raw region-scoped, query-filtered task rows (pre-serialization). Route `GET /tasks/export.csv` honoring all existing filters.

- [ ] **Step 1: Refactor the list handler and add export + kpi-aware helpers**

Replace the whole `router.get('/tasks', ...)` block (lines 37-55) with the following, which introduces `scopedTasks` and the export route (the literal `export.csv` route MUST stay before `GET /tasks/:id`):

```js
function scopedTasks(req) {
  let rows = list('task').filter((t) => taskVisible(req.user, t));
  const { status, region_id, task_type, priority, overdue, q, crew_id, line_id, tower_id, asset_id, substation_id } = req.query;
  if (status) rows = rows.filter((t) => t.status === status);
  if (region_id) rows = rows.filter((t) => t.region_id === Number(region_id));
  if (task_type) rows = rows.filter((t) => t.task_type === task_type);
  if (priority) rows = rows.filter((t) => t.priority === priority);
  if (crew_id) rows = rows.filter((t) => t.crew_id === Number(crew_id));
  if (line_id) rows = rows.filter((t) => t.line_id === Number(line_id));
  if (tower_id) rows = rows.filter((t) => t.tower_id === Number(tower_id));
  if (asset_id) rows = rows.filter((t) => t.asset_id === Number(asset_id));
  if (substation_id) rows = rows.filter((t) => t.substation_id === Number(substation_id));
  if (q) rows = rows.filter((t) => (t.title + t.task_number).toLowerCase().includes(q.toLowerCase()));
  if (overdue === 'true') {
    const now = new Date().toISOString();
    rows = rows.filter((t) => OPEN.includes(t.status) && t.due_date < now);
  }
  return rows;
}

router.get('/tasks', (req, res) => {
  res.json(scopedTasks(req).map(taskDetail));
});

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function taskTarget(t) {
  if (t.asset_id) return { type: 'ASSET', name: get('asset', t.asset_id)?.name || '' };
  if (t.tower_id) return { type: 'TOWER', name: get('tower', t.tower_id)?.tower_id || '' };
  if (t.substation_id) return { type: 'SUBSTATION', name: get('substation', t.substation_id)?.name || '' };
  if (t.line_id) return { type: 'LINE', name: get('transmission_line', t.line_id)?.name || '' };
  return { type: 'NONE', name: '' };
}

router.get('/tasks/export.csv', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: 'Forbidden: requires task:read' });
  const rows = scopedTasks(req);
  const headers = ['task_number', 'title', 'task_type', 'priority', 'status', 'result', 'region', 'crew',
    'target_type', 'target_name', 'checklist_template', 'due_date', 'scheduled_start', 'actual_start',
    'actual_end', 'created_by', 'assigned_by', 'verified_by', 'progress_pct'];
  const personName = (id) => {
    const p = id ? get('person', id) : null;
    return p ? `${p.first_name} ${p.last_name}`.trim() : '';
  };
  const lines = rows.map((t) => {
    const target = taskTarget(t);
    const progress = taskProgress(t.id);
    const crew = t.crew_id ? get('crew', t.crew_id) : null;
    const tpl = t.checklist_template_id ? get('checklist_template', t.checklist_template_id) : null;
    const region = t.region_id ? get('region', t.region_id) : null;
    return [
      t.task_number, t.title, t.task_type, t.priority, t.status, t.result || '', region?.name || '',
      crew?.name || '', target.type, target.name, tpl?.name || '', t.due_date || '', t.scheduled_start || '',
      t.actual_start || '', t.actual_end || '', personName(t.created_by), personName(t.assigned_by),
      personName(t.verified_by), progress.progress_pct,
    ].map(csvField).join(',');
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=tasks_${stamp}.csv`);
  audit(req.user, 'EXPORT', 'task', null, { scope: 'tasks_export', count: rows.length });
  res.send('\uFEFF' + [headers.join(','), ...lines].join('\n'));
});

router.get('/tasks/:id', (req, res) => {
```

- [ ] **Step 2: Syntax check**

Run: `cd /workspace/backend && node -c routes/tasks.js`

- [ ] **Step 3: Restart verify server, then verify export honours filters and audit row is written**

Restart the verify terminal (Task 1 command). Then run:

```python
python3 - <<'PY'
import csv, io
exec(open('/tmp/opencode/tmms_e2e.py').read())
t = login('mgr.c1.tlom', 'Manager@123')
st, rows = j('GET', '/api/tasks', token=t)
assert st == 200
st2, csvtxt = j('GET', '/api/tasks/export.csv', token=t)
assert st2 == 200 and csvtxt.startswith('\ufeff'), (st2, csvtxt[:40])
parsed = list(csv.DictReader(io.StringIO(csvtxt.lstrip('\ufeff'))))
assert len(parsed) == len(rows), (len(parsed), len(rows))
assert parsed[0]['task_number'] == rows[0]['task_number']
assert 'progress_pct' in parsed[0]
# Crew lead (task:read only) may also export.
tc = login('crew.c1tlom.lead', 'Crew@123')
st3, _ = j('GET', '/api/tasks/export.csv', token=tc)
assert st3 == 200
print('OK export rows=', len(parsed))
PY
```

Audit check (row written): run

```bash
cd /workspace/backend && node - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/tmp/opencode/tmms-a.db');
const rows = db.prepare("SELECT id, action, entity, detail FROM audit_log WHERE action = 'EXPORT' ORDER BY id DESC LIMIT 3").all();
console.log(rows.map((r) => ({ action: r.action, entity: r.entity, detail: JSON.parse(r.detail || '{}') })));
db.close();
JS
```

Expected output shows an `EXPORT` row whose detail is `{ scope: 'tasks_export', count: <n> }`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(tasks): CSV export of filtered task list with audit"
```

---

### Task 4: Bulk update endpoint

**Files:**
- Modify: `backend/routes/tasks.js` (add `POST /tasks/bulk`)

**Interfaces:**
- Consumes: `taskVisible`, `can`, `audit`, `updateRow` — all already imported.
- Produces: `POST /tasks/bulk` → `{ updated: n, ids: number[] }`.

- [ ] **Step 1: Add the route**

Insert immediately after the new `router.get('/tasks/export.csv', ...)` block added in Task 3 (still before `GET /tasks/:id`):

```js
const BULK_ACTIONS = new Set(['priority', 'due_date', 'schedule_start', 'assign']);
const PRIORITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

router.post('/tasks/bulk', (req, res) => {
  if (!can(req, 'task:bulk')) return res.status(403).json({ error: 'Forbidden: requires task:bulk' });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const { action, value } = req.body;
  if (!ids.length || !BULK_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'ids[] and action (priority|due_date|schedule_start|assign) are required' });
  }
  if (action === 'priority' && !PRIORITIES.has(value)) {
    return res.status(400).json({ error: 'priority must be CRITICAL|HIGH|MEDIUM|LOW' });
  }
  if ((action === 'due_date' || action === 'schedule_start') && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
    return res.status(400).json({ error: `${action} must be an ISO datetime string` });
  }
  if (action === 'assign' && !get('crew', Number(value))) {
    return res.status(400).json({ error: 'assign value must be an existing crew id' });
  }
  for (const id of ids) {
    if (!get('task', id)) return res.status(404).json({ error: `Task ${id} not found` });
    if (!taskVisible(req.user, get('task', id))) {
      return res.status(403).json({ error: `Task ${id} is outside your scope` });
    }
  }
  const patch = {};
  if (action === 'priority') patch.priority = value;
  if (action === 'due_date') patch.due_date = value;
  if (action === 'schedule_start') patch.schedule_start = value;
  if (action === 'assign') { patch.crew_id = Number(value); patch.assigned_by = req.user.person_id || null; }
  for (const id of ids) {
    updateRow('task', id, { ...patch, updated_at: new Date().toISOString() }, [], 'revision');
  }
  audit(req.user, 'BULK', 'task', null, { action, value, count: ids.length });
  res.json({ updated: ids.length, ids });
});
```

- [ ] **Step 2: Syntax check**

Run: `cd /workspace/backend && node -c routes/tasks.js`

- [ ] **Step 3: Restart verify server and run bulk verification**

Restart the verify terminal. Run:

```python
python3 - <<'PY'
exec(open('/tmp/opencode/tmms_e2e.py').read())
mgr = login('mgr.c1.tlom', 'Manager@123')
# Create two throwaway drafts as the manager (task:create via OPERATIONS_WORKFLOW).
st1, a = j('POST', '/api/tasks', token=mgr, body={
  'title': 'VFY-BULK-A', 'task_type': 'PREVENTIVE', 'priority': 'MEDIUM',
  'region_id': 1, 'due_date': '2026-12-31T12:00:00.000Z'})
st2, b = j('POST', '/api/tasks', token=mgr, body={
  'title': 'VFY-BULK-B', 'task_type': 'PREVENTIVE', 'priority': 'MEDIUM',
  'region_id': 1, 'due_date': '2026-12-31T12:00:00.000Z'})
assert st1 == 201 and st2 == 201, (st1, a, st2, b)
ids = [a['id'], b['id']]
stc, crews = j('GET', '/api/crews', token=mgr)
assert stc == 200 and crews, (stc, crews)
crew_id = crews[0]['id']
st, r = j('POST', '/api/tasks/bulk', token=mgr, body={'ids': ids, 'action': 'priority', 'value': 'HIGH'})
assert st == 200 and r['updated'] == 2 and set(r['ids']) == set(ids), (st, r)
st, r = j('POST', '/api/tasks/bulk', token=mgr, body={'ids': ids, 'action': 'assign', 'value': crew_id})
assert st == 200 and r['updated'] == 2, (st, r)
# invalid action
st, r = j('POST', '/api/tasks/bulk', token=mgr, body={'ids': ids, 'action': 'status', 'value': 'COMPLETED'})
assert st == 400, (st, r)
# crew lead (no task:bulk) is denied
lead = login('crew.c1tlom.lead', 'Crew@123')
st, r = j('POST', '/api/tasks/bulk', token=lead, body={'ids': ids, 'action': 'priority', 'value': 'LOW'})
assert st == 403, (st, r)
# verify applied + revision bumped
st, tasks = j('GET', '/api/tasks', token=mgr)
for t in tasks:
    if t['id'] in ids:
        assert t['priority'] == 'HIGH' and t['crew_id'] == crew_id and t['revision'] >= 2, t
print('OK bulk ids=', ids)
PY
```

Expected: `OK bulk ids=[...]`. The two `VFY-BULK-*` drafts are left in the isolated DB only (safe, never touches :3001).

Audit check (single BULK row): run

```bash
cd /workspace/backend && node - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/tmp/opencode/tmms-a.db');
const rows = db.prepare("SELECT id, action, entity, detail FROM audit_log WHERE action = 'BULK' ORDER BY id DESC LIMIT 3").all();
console.log(rows.map((r) => ({ action: r.action, detail: JSON.parse(r.detail || '{}') })));
db.close();
JS
```

Expected: a `BULK` row with `detail` containing `action: 'priority'` (or `assign`), `value`, and `count: 2`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(tasks): bulk update of priority/due/schedule-start/crew with task:bulk gate"
```

---

### Task 5: KPI endpoint

**Files:**
- Modify: `backend/routes/tasks.js` (add `GET /tasks/kpi`, before `GET /tasks/:id`)

**Interfaces:**
- Consumes: `scopedTasks(req)` (Task 3), `OPEN` constant.
- Produces: `GET /tasks/kpi` payload `{ total, open, completed, overdue, critical_overdue, completion_rate, avg_cycle_hours, completed_this_week, by_status, by_type }`.

- [ ] **Step 1: Add the route**

Insert before `router.get('/tasks/:id', ...)` (after the bulk route):

```js
function isoWeekStart(d) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}

router.get('/tasks/kpi', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: 'Forbidden: requires task:read' });
  const rows = scopedTasks(req);
  const now = new Date().toISOString();
  const weekStart = isoWeekStart(new Date());
  const completed = rows.filter((t) => t.status === 'COMPLETED');
  const overdue = rows.filter((t) => OPEN.includes(t.status) && t.due_date < now);
  const withCycle = completed.filter((t) => t.actual_end && t.scheduled_start);
  const avgCycle = withCycle.length
    ? Math.round((withCycle.reduce((s, t) => s + (new Date(t.actual_end) - new Date(t.scheduled_start)), 0) / withCycle.length) / 3600000)
    : null;
  const byStatus = {};
  const byType = {};
  for (const t of rows) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byType[t.task_type] = (byType[t.task_type] || 0) + 1;
  }
  res.json({
    total: rows.length,
    open: rows.filter((t) => OPEN.includes(t.status)).length,
    completed: completed.length,
    overdue: overdue.length,
    critical_overdue: overdue.filter((t) => t.priority === 'CRITICAL').length,
    completion_rate: rows.length ? Math.round((completed.length / rows.length) * 100) : 0,
    avg_cycle_hours: avgCycle,
    completed_this_week: completed.filter((t) => t.actual_end && t.actual_end >= weekStart).length,
    by_status: byStatus,
    by_type: byType,
  });
});
```

- [ ] **Step 2: Syntax check**

Run: `cd /workspace/backend && node -c routes/tasks.js`

- [ ] **Step 3: Restart verify server and compare KPI with hand-counted rows**

Restart the verify terminal. Run:

```python
python3 - <<'PY'
exec(open('/tmp/opencode/tmms_e2e.py').read())
t = login('mgr.c1.tlom', 'Manager@123')
st, rows = j('GET', '/api/tasks', token=t)
assert st == 200
st, k = j('GET', '/api/tasks/kpi', token=t)
assert st == 200
from datetime import datetime, timezone
now = datetime.now(timezone.utc).isoformat()
open_st = ['DRAFT','SCHEDULED','ASSIGNED','IN_PROGRESS','ON_HOLD','PENDING_VERIFICATION']
assert k['total'] == len(rows)
assert k['completed'] == sum(1 for r in rows if r['status'] == 'COMPLETED')
assert k['open'] == sum(1 for r in rows if r['status'] in open_st)
assert k['overdue'] == sum(1 for r in rows if r['status'] in open_st and r['due_date'] < now)
assert k['critical_overdue'] == sum(1 for r in rows if r['status'] in open_st and r['due_date'] < now and r['priority'] == 'CRITICAL')
assert set(k['by_status'].keys()) == {s for s in set(r['status'] for r in rows)}
print('OK kpi', {x: k[x] for x in ['total','open','completed','overdue','critical_overdue','completion_rate','avg_cycle_hours','completed_this_week']})
PY
```

Expected: `OK kpi ...` with hand-count-equivalent values.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(tasks): region-scoped KPI endpoint"
```

---

### Task 6: Crew & person performance endpoint

**Files:**
- Create: `backend/routes/performance.js`
- Modify: `backend/server.js` (mount)

**Interfaces:**
- Consumes: `taskProgress` not needed here; uses `db`, `list`, `get`, `isGlobal`, `can`, `audit`-style row access only (read-only).
- Produces: `GET /performance?scope=crew|person` gated by `report:write`; response `{ rows: [...] }`. Row shape for both scopes: `{ id, name, tasks, completed, completion_rate, on_time, on_time_rate, findings, gps_violations }`. Optional filters `status`, `date_from`, `date_to`.

- [ ] **Step 1: Write the route module**

Create `backend/routes/performance.js`:

```js
const express = require('express');
const { db, list, get } = require('../util');
const { can, isGlobal } = require('../auth');

const router = express.Router();
const OPEN = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];

function inScope(user, regionId) {
  return isGlobal(user) || regionId === user.region_id;
}

const ratePct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

router.get('/performance', (req, res) => {
  if (!can(req, 'report:write')) return res.status(403).json({ error: 'Forbidden: requires report:write' });
  const scope = req.query.scope === 'person' ? 'person' : 'crew';
  const { status, date_from, date_to } = req.query;
  // Crew universe is region-scoped; all later counts hang off these crews.
  const crews = list('crew').filter((c) => inScope(req.user, c.region_id));
  const crewIds = new Set(crews.map((c) => c.id));
  let tasks = list('task').filter((t) => t.crew_id != null && crewIds.has(t.crew_id));
  if (status) tasks = tasks.filter((t) => t.status === status);
  if (date_from) tasks = tasks.filter((t) => t.created_at >= date_from);
  if (date_to) tasks = tasks.filter((t) => t.created_at <= date_to);
  const taskIds = new Set(tasks.map((t) => t.id));

  const findingsByCrew = {};
  for (const f of db.prepare('SELECT crew_id, COUNT(*) c FROM task_finding WHERE crew_id IS NOT NULL GROUP BY crew_id').all()) {
    findingsByCrew[f.crew_id] = f.c;
  }
  const violByCrew = {};
  for (const v of db.prepare(
    `SELECT t.crew_id crew_id, COUNT(*) c FROM gps_validation v JOIN task t ON t.id = v.linked_task_id
     WHERE v.result = 'FAIL' AND t.crew_id IS NOT NULL GROUP BY t.crew_id`
  ).all()) {
    violByCrew[v.crew_id] = v.c;
  }

  let rows;
  if (scope === 'crew') {
    rows = crews.map((c) => {
      const owned = tasks.filter((t) => t.crew_id === c.id);
      const completed = owned.filter((t) => t.status === 'COMPLETED');
      const onTime = completed.filter((t) => t.actual_end && t.due_date && t.actual_end <= t.due_date);
      return {
        id: c.id, name: c.name,
        tasks: owned.length, completed: completed.length, completion_rate: ratePct(completed.length, owned.length),
        on_time: onTime.length, on_time_rate: ratePct(onTime.length, completed.length),
        findings: findingsByCrew[c.id] || 0, gps_violations: violByCrew[c.id] || 0,
      };
    });
  } else {
    // Person scope: the executions performed by each executor on the scoped
    // task set. "completed" = submitted executions carrying a result grade;
    // "on_time" = those on COMPLETED tasks finished by their due date.
    const byExec = {};
    const q = db.prepare('SELECT id, executed_by, result, submitted_at FROM checklist_execution WHERE task_id = ?');
    for (const t of tasks) {
      for (const ex of q.all(t.id)) {
        if (!ex.executed_by) continue;
        (byExec[ex.executed_by] = byExec[ex.executed_by] || []).push({ t, ex });
      }
    }
    rows = Object.entries(byExec).map(([pidStr, arr]) => {
      const pid = Number(pidStr);
      const person = get('person', pid);
      const name = person ? `${person.first_name} ${person.last_name}`.trim() : `person #${pid}`;
      const done = arr.filter(({ ex }) => ex.result);
      const onTime = done.filter(({ t }) => t.status === 'COMPLETED' && t.actual_end && t.due_date && t.actual_end <= t.due_date);
      const execIds = arr.map(({ ex }) => ex.id);
      const ph = execIds.map(() => '?').join(',');
      const findings = execIds.length ? db.prepare(`SELECT COUNT(*) c FROM task_finding WHERE execution_id IN (${ph})`).get(...execIds).c : 0;
      const gpsViol = db.prepare("SELECT linked_task_id FROM gps_validation WHERE validated_by = ? AND result = 'FAIL'").all(pid)
        .filter((v) => v.linked_task_id != null && taskIds.has(v.linked_task_id)).length;
      return {
        id: pid, name,
        tasks: arr.length, completed: done.length, completion_rate: ratePct(done.length, arr.length),
        on_time: onTime.length, on_time_rate: ratePct(onTime.length, done.length),
        findings, gps_violations: gpsViol,
      };
    }).sort((a, b) => b.tasks - a.tasks);
  }
  res.json({ scope, rows });
});

module.exports = router;
```

> Note: the `crewOf` containment check in the person branch above is intentionally permissive (it only skips executors who are not in any visible crew for non-global users). For managers this yields all executors on visible crews' tasks. Do not "simplify" the person branch by dropping it.

- [ ] **Step 2: Mount it**

Edit `backend/server.js`. After the line `app.use('/api', require('./routes/checklists'));` add:

```js
app.use('/api', require('./routes/performance'));
```

- [ ] **Step 3: Syntax check**

Run: `cd /workspace/backend && node -c routes/performance.js && node -c server.js`

- [ ] **Step 4: Restart verify server and assert shape + gate**

Restart the verify terminal. Run:

```python
python3 - <<'PY'
exec(open('/tmp/opencode/tmms_e2e.py').read())
mgr = login('mgr.c1.tlom', 'Manager@123')
st, r = j('GET', '/api/performance?scope=crew', token=mgr)
assert st == 200 and 'rows' in r, (st, r)
assert all(set(k) <= set(x) for x in r['rows'] for k in [['id','name','tasks','completed','completion_rate','on_time','on_time_rate','findings','gps_violations']])
print('crew rows:', [(x['name'], x['tasks'], x['completed'], x['findings']) for x in r['rows']])
st, r2 = j('GET', '/api/performance?scope=person', token=mgr)
assert st == 200 and isinstance(r2.get('rows'), list)
print('person rows:', [(x['name'], x['tasks'], x['completed']) for x in r2['rows']])
lead = login('crew.c1tlom.lead', 'Crew@123')
st3, r3 = j('GET', '/api/performance?scope=crew', token=lead)
assert st3 == 403, (st3, r3)
print('OK perf')
PY
```

Expected: two row lists printed plus `OK perf`; crew-lead blocked with 403.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/performance.js backend/server.js
git commit -m "feat(performance): crew and person task-performance endpoint gated by report:write"
```

---

### Task 7: Document and crew-detail task rows carry progress fields

**Files:**
- Modify: `backend/routes/reports.js`
- Modify: `backend/routes/crews.js`

**Interfaces:**
- Consumes: `taskProgress` from `backend/taskProgress.js` (Task 2).
- Produces: documents whose `tasks`, `tasks_past`, `tasks_future` arrays each carry `progress_pct/progress_graded/progress_passed`, and the crew-detail builder's assigned-work task array (`detail.tasks` on `GET /crews/:id`) likewise. Frontend Task 11 relies on these fields.

- [ ] **Step 1: Find every document assembly point**

Run: `cd /workspace/backend && grep -n "tasks_past\|tasks_future\|document\|tasks:" routes/reports.js`
Run: `cd /workspace/backend && grep -n "tasks\b\|generated\|assigned" routes/crews.js`

Read the identified builders. TASK/ASSET/LINE documents collect task rows (with `task_number`, `status`, etc.) into arrays named `tasks`, `tasks_past`, and/or `tasks_future`. The crew detail route builds an assigned-work array of tasks on `GET /crews/:id`.

- [ ] **Step 2: Add the require and enrich every assembled task array**

At the top of `routes/reports.js`, after the existing requires, add:

```js
const { taskProgress } = require('../taskProgress');
```

Do the same in `routes/crews.js`.

For each place where a document object is fully assembled before being returned/resolved (usually right before `return` or inside the promise callback that produces the document object), insert this enrichment immediately after assembly:

```js
for (const key of ['tasks', 'tasks_past', 'tasks_future']) {
  if (Array.isArray(document[key])) {
    document[key] = document[key].map((t) => ({ ...t, ...taskProgress(t.id) }));
  }
}
```

(Where the builder uses a different local variable name than `document`, use that name. The snippet is safe when an array key is absent — it simply skips it. Do not add the same snippet twice for the same builder.)

For the crew detail route (`GET /crews/:id`), apply the same single-array enrichment to the assigned-work task list object after it is assembled (e.g. where `detail.tasks` is built), using that object's name in place of `document`:

```js
detail.tasks = detail.tasks.map((t) => ({ ...t, ...taskProgress(t.id) }));
```

- [ ] **Step 3: Syntax check and shape check**

Run: `cd /workspace/backend && node -c routes/reports.js && node -c routes/crews.js`

Restart the verify terminal. Run:

```python
python3 - <<'PY'
exec(open('/tmp/opencode/tmms_e2e.py').read())
mgr = login('mgr.c1.tlom', 'Manager@123')
# Pull the existing COMPLETED task ids for a TASK_DETAIL document target.
st, tasks = j('GET', '/api/tasks', token=mgr)
done = [t for t in tasks if t['status'] == 'COMPLETED']
assert done, 'no completed task in isolated db'
target = done[0]
st, d = j('POST', '/api/reports/generate', token=mgr, body={'report_type': 'TASK_DETAIL', 'task_id': target['id']})
print('document keys:', sorted((d.get('data') or {}).keys()) if isinstance(d, dict) else d)
assert st == 200
PY
```

Expected: 200 and document data present. If a TASK_DETAIL document renders a single task (not an array), confirm `progress_pct` is present in whatever task object the document embeds and, if it is missing from the array, apply the snippet to that single-task object instead (key it by the actual task key used, e.g. `document.task`). Repeat the run until the check passes.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/reports.js backend/routes/crews.js
git commit -m "feat(reports,crews): documents and crew detail carry checklist progress fields"
```

---

### Task 8: Frontend `Progress` component + Tasks page (export, bulk, KPI chips, progress)

**Files:**
- Modify: `frontend/src/components.jsx` (add export `Progress`)
- Modify: `frontend/src/pages/Tasks.jsx`

**Interfaces:**
- Consumes: backend fields from Tasks 2-5. Renders `progress_pct`, KPI from `/tasks/kpi`, bulk via `POST /tasks/bulk`.
- Produces: `Progress({ pct, graded, passed })` component (also used by Tasks 9/10 later tasks).

- [ ] **Step 1: Add the `Progress` component**

In `frontend/src/components.jsx`, append at the end of the file:

```jsx
export function Progress({ pct, graded, passed, width = 60 }) {
  if (!graded) return <span className="muted" style={{ fontSize: 12 }}>no data</span>;
  const color = pct === 100 ? '#16a34a' : pct >= 60 ? '#2563eb' : '#dc2626';
  return (
    <div title={`${passed}/${graded} graded items passed`} style={{ width, display: 'inline-block' }}>
      <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, background: color, height: '100%' }} />
      </div>
      <div className="muted" style={{ fontSize: 11 }}>{pct}% · {passed}/{graded}</div>
    </div>
  );
}
```

- [ ] **Step 2: Tasks.jsx — state, bulk config, export helper**

Add imports after line 3 (`import { Page, Pill, Modal, ErrorNote, Loading } from '../components';`):

```jsx
import { Progress } from '../components';
```

Add state and helpers inside the component. Replace lines 33-35 (`const [error, setError]... const [form, setForm]...`) — keep them — and insert the new state right after line 35 (`const [form, setForm] = useState(null);`):

```jsx
  const canBulk = can(me, 'task:bulk');
  const [kpi, setKpi] = useState(null);
  const [checked, setChecked] = useState([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkVal, setBulkVal] = useState('');
  const [bulkErr, setBulkErr] = useState(null);
```

- [ ] **Step 3: Tasks.jsx — load KPI and add export/bulk actions**

Inside the component, after the existing `load` definition (line 37-48) add `loadKpi` and `doExport`, and after the `useEffect` block (lines 49-59) add the KPI effect:

```jsx
  const loadKpi = () => api.get('/tasks/kpi').then(setKpi).catch(() => {});
```

Add after the existing `useEffect` (after line 59):

```jsx
  useEffect(() => { loadKpi(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter, typeFilter, overdueOnly, lineF, towerF, assetF, subF, crewF]);
```

Add `exportCsv` and `applyBulk` functions next to `save()`:

```jsx
  async function exportCsv() {
    try {
      const q = [];
      if (statusFilter) q.push(`status=${statusFilter}`);
      if (typeFilter) q.push(`task_type=${typeFilter}`);
      if (overdueOnly) q.push('overdue=true');
      if (lineF) q.push(`line_id=${lineF}`);
      if (towerF) q.push(`tower_id=${towerF}`);
      if (assetF) q.push(`asset_id=${assetF}`);
      if (subF) q.push(`substation_id=${subF}`);
      if (crewF) q.push(`crew_id=${crewF}`);
      const res = await fetch(`/api/tasks/export.csv${q.length ? '?' + q.join('&') : ''}`, { headers: { Authorization: `Bearer ${localStorage.getItem('tmms_token') || ''}` } });
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (res.headers.get('Content-Disposition')?.match(/filename=(.+)/)?.[1]) || 'tasks.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(e.message); }
  }

  async function applyBulk() {
    try {
      if (bulkMode === 'assign') {
        const crewId = Number(bulkVal);
        await api.post('/tasks/bulk', { ids: checked, action: 'assign', value: crewId });
      } else if (bulkMode === 'priority') {
        await api.post('/tasks/bulk', { ids: checked, action: 'priority', value: bulkVal });
      } else if (bulkMode === 'due_date' || bulkMode === 'schedule_start') {
        await api.post('/tasks/bulk', { ids: checked, action: bulkMode, value: new Date(bulkVal).toISOString() });
      }
      setChecked([]); setBulkMode(false); setBulkVal('');
      load();
    } catch (e) { setBulkErr(e.message); }
  }
```

> Note the frontend `api` client sets the Authorization header from the stored token — but for the raw-file export we call `fetch` directly. Confirm the actual token storage key by reading `frontend/src/api.js` (search `localStorage`) and reuse that exact key instead of `tmms_token` if different.

- [ ] **Step 4: Tasks.jsx — page actions and KPI chips**

Replace the `<Page ... actions={canCreate ? ...}>` opening (line 91-92) block:

```jsx
    <Page title="Maintenance Tasks" crumbs="TMMS / Operations"
      actions={<>
        {canCreate ? <button className="btn btn-primary" onClick={() => setForm({ ...blank, region_id: regions[0]?.id || 1 })}>+ New Task</button> : null}
        <button className="btn" onClick={exportCsv}>Export CSV</button>
      </>}>
```

Insert the KPI chips strip right after `{error && <ErrorNote error={error} />}` and before `<div className="filters">` (line 94):

```jsx
      {kpi && (
        <div className="flex mt mb" style={{ gap: 10, flexWrap: 'wrap' }}>
          {[
            { l: 'Overdue', v: kpi.overdue, w: kpi.overdue > 0 },
            { l: 'Critical overdue', v: kpi.critical_overdue, w: kpi.critical_overdue > 0 },
            { l: 'Completion rate', v: `${kpi.completion_rate}%` },
            { l: 'Completed this week', v: kpi.completed_this_week },
            { l: 'Avg cycle', v: kpi.avg_cycle_hours == null ? '—' : `${kpi.avg_cycle_hours}h` },
          ].map((c) => (
            <span key={c.l} className="pill" style={c.w ? { background: '#fee2e2', color: '#b91c1c' } : { background: '#e0f2fe', color: '#0369a1' }}>
              <b>{c.v}</b> {c.l}
            </span>
          ))}
        </div>
      )}
```

- [ ] **Step 5: Tasks.jsx — checkbox column, progress column, bulk bar**

Replace the table header + row map (lines 128-147) so each row has a checkbox and a Progress column, and place the bulk bar above the table. Replace lines 125-151 (the `.card` containing `.tbl-wrap`) with:

```jsx
      <div className="card">
        {canBulk && checked.length > 0 && (
          <div className="bulkbar" style={{ padding: '10px 14px', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: '#f0f9ff' }}>
            <b>{checked.length} selected</b>
            <select value={bulkMode} onChange={(e) => { setBulkMode(e.target.value); setBulkVal(''); setBulkErr(null); }}>
              <option value="">Bulk action…</option>
              <option value="priority">Set priority</option>
              <option value="due_date">Set due date</option>
              <option value="schedule_start">Set schedule start</option>
              <option value="assign">Assign crew</option>
            </select>
            {bulkMode === 'priority' && (
              <select value={bulkVal} onChange={(e) => setBulkVal(e.target.value)}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => <option key={p}>{p}</option>)}
              </select>
            )}
            {bulkMode === 'due_date' && <input type="datetime-local" value={bulkVal} onChange={(e) => setBulkVal(e.target.value)} />}
            {bulkMode === 'schedule_start' && <input type="datetime-local" value={bulkVal} onChange={(e) => setBulkVal(e.target.value)} />}
            {bulkMode === 'assign' && (
              <select value={bulkVal} onChange={(e) => setBulkVal(e.target.value)}>
                <option value="">Choose crew…</option>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button className="btn btn-sm btn-primary" disabled={!bulkMode || (!bulkVal && bulkMode !== 'priority')} onClick={applyBulk}>Apply</button>
            <button className="btn btn-sm" onClick={() => { setChecked([]); setBulkMode(false); setBulkVal(''); }}>Clear</button>
            {bulkErr && <span style={{ color: '#dc2626' }}>{bulkErr}</span>}
          </div>
        )}
        <div className="tbl-wrap">
          <table>
            <thead><tr>
              {canBulk && <th style={{ width: 30 }}><input type="checkbox" checked={checked.length === rows.length && rows.length > 0} onChange={(e) => setChecked(e.target.checked ? rows.map((r) => r.id) : [])} /></th>}
              <th>Task</th><th>Type</th><th>Priority</th><th>Status</th><th>Progress</th><th>Target</th><th>Due</th><th>Crew</th><th>Action</th>
            </tr></thead>
            <tbody>
              {rows.map((t) => {
                const overdue = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'].includes(t.status) && new Date(t.due_date) < new Date();
                return (
                  <tr key={t.id}>
                    {canBulk && (
                      <td><input type="checkbox" checked={checked.includes(t.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, t.id] : checked.filter((i) => i !== t.id))} /></td>
                    )}
                    <td>
                      <a href={`/tasks/${t.id}`} style={{ color: '#2563eb', fontWeight: 600 }}>{t.task_number}</a><br />
                      <span className="muted">{t.title}</span>
                    </td>
                    <td>{t.task_type}</td>
                    <td style={{ color: STATUS_COLORS[t.priority] || undefined, fontWeight: 600 }}>{t.priority}</td>
                    <td><Pill value={t.status} /></td>
                    <td><Progress pct={t.progress_pct} graded={t.progress_graded} passed={t.progress_passed} /></td>
                    <td>{t.tower ? `${t.tower.tower_id} (Tower)` : t.asset ? t.asset.name : t.substation ? t.substation.name : t.line ? t.line.name : '—'}</td>
                    <td style={{ color: overdue ? '#dc2626' : undefined, fontWeight: overdue ? 700 : undefined }}>{fmtDate(t.due_date)}</td>
                    <td>{t.crew?.name || '—'}</td>
                    <td className="nowrap">{nextAction(t)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
```

- [ ] **Step 6: Build check**

Run: `cd /workspace/frontend && npm run build` — must complete cleanly.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components.jsx frontend/src/pages/Tasks.jsx
git commit -m "feat(tasks): export csv, bulk bar, KPI chips and progress bars"
```

---

### Task 9: Home KPI cards

**Files:**
- Modify: `frontend/src/pages/Home.jsx`

**Interfaces:**
- Consumes: `GET /tasks/kpi`; `getStoredUser`/`persona` already on the page.

- [ ] **Step 1: Add state + fetch**

In `Home.jsx` replace the state/effect block at lines 6-12:

```jsx
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [kpi, setKpi] = useState(null);
  const [kpiError, setKpiError] = useState(null);

  useEffect(() => {
    api.get('/home').then(setData).catch((e) => setError(e.message));
    api.get('/tasks/kpi').then(setKpi).catch((e) => setKpiError(e.message));
  }, []);
```

- [ ] **Step 2: Render KPI cards for leadership personas**

Insert between the greeting block (closing `</div>` of `.home-greeting`, line 26) and `{data.sections.map(...)}` (line 28):

```jsx
      {kpi && data.persona !== 'crew' && (
        <div className="mt">
          <h3 className="section-title">Regional task pulse</h3>
          <div className="grid grid-4">
            <StatCard label="Overdue tasks" value={kpi.overdue} sub="open & past due" color={kpi.overdue > 0 ? '#dc2626' : '#16a34a'} />
            <StatCard label="Critical overdue" value={kpi.critical_overdue} sub="CRITICAL & open" color={kpi.critical_overdue > 0 ? '#b91c1c' : '#16a34a'} />
            <StatCard label="Completion rate" value={`${kpi.completion_rate}%`} sub="all scoped tasks" color="#2563eb" />
            <StatCard label="Completed this week" value={kpi.completed_this_week} sub="ISO week to date" color="#2563eb" />
          </div>
        </div>
      )}
```

- [ ] **Step 3: Build check**

Run: `cd /workspace/frontend && npm run build` — clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Home.jsx
git commit -m "feat(home): region-scoped task KPI cards for leadership personas"
```

---

### Task 10: Reports page Performance block

**Files:**
- Modify: `frontend/src/pages/Reports.jsx`

**Interfaces:**
- Consumes: `GET /performance?scope=crew|person`.
- Produces: a self-contained `PerformanceBlock` rendered only for users holding `report:write`.

- [ ] **Step 1: Add state**

In the Reports component, after line 18 (`const [entityLists, setEntityLists] = useState(...)`), add:

```jsx
  const canPerf = canGenerate;
  const [perfScope, setPerfScope] = useState('crew');
  const [perf, setPerf] = useState(null);
  const [perfErr, setPerfErr] = useState(null);
```

- [ ] **Step 2: Add the fetch effect**

After the existing `useEffect` (lines 24-31) add:

```jsx
  useEffect(() => {
    if (!canPerf) return;
    api.get(`/performance?scope=${perfScope}`).then((r) => setPerf(r.rows)).catch((e) => setPerfErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfScope, canPerf]);
```

- [ ] **Step 3: Render the block between the error note and the templates heading**

Replace:

```jsx
      {error && <ErrorNote error={error} />}

      <h3 className="section-title">Available Report Templates</h3>
```

with:

```jsx
      {error && <ErrorNote error={error} />}

      {canPerf && (
        <div className="mt mb">
          <div className="spread">
            <h3 className="section-title">Field Team Performance</h3>
            <div>
              <button className={`btn btn-sm${perfScope === 'crew' ? ' btn-primary' : ''}`} onClick={() => setPerfScope('crew')}>By crew</button>{' '}
              <button className={`btn btn-sm${perfScope === 'person' ? ' btn-primary' : ''}`} onClick={() => setPerfScope('person')}>By person</button>
            </div>
          </div>
          {perfErr && <ErrorNote error={perfErr} />}
          {!perf && !perfErr && <Loading />}
          {perf && (
            <div className="card">
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>{perfScope === 'crew' ? 'Crew' : 'Person'}</th><th>Tasks</th><th>Completed</th><th>Rate</th><th>On time</th><th>On-time rate</th><th>Findings</th><th>GPS violations</th></tr></thead>
                  <tbody>
                    {perf.map((r) => (
                      <tr key={r.id}>
                        <td><b>{r.name}</b></td>
                        <td>{r.tasks}</td>
                        <td>{r.completed}</td>
                        <td>{r.completion_rate}%</td>
                        <td>{r.on_time}</td>
                        <td>{r.on_time_rate}%</td>
                        <td>{r.findings}</td>
                        <td>{r.gps_violations}</td>
                      </tr>
                    ))}
                    {perf.length === 0 && <tr><td colSpan={8} className="muted center">No data for this scope.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <h3 className="section-title">Available Report Templates</h3>
```

- [ ] **Step 4: Build check**

Run: `cd /workspace/frontend && npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Reports.jsx
git commit -m "feat(reports): crew and person performance tables gated by report:write"
```

---

### Task 11: Progress chips on remaining task lists (TaskDetail, Crews, document TaskRows)

**Files:**
- Modify: `frontend/src/pages/TaskDetail.jsx`
- Modify: `frontend/src/pages/Crews.jsx`
- Modify: `frontend/src/components/DocumentReport.jsx`

**Interfaces:**
- Consumes: `Progress` from components.jsx (Task 8), progress fields from Tasks 2 & 7.

- [ ] **Step 1: Add the import to each file**

Add to the components import line of each file the `Progress` name (each already imports `Pill` from `../components` or `./components` accordingly).

- [ ] **Step 2: TaskDetail.jsx — task-level progress summary**

Run: `grep -n "executions" frontend/src/pages/TaskDetail.jsx` and read the surrounding block (the executions summary table). Immediately above the element that lists `task.executions`, insert:

```jsx
      {task.progress_graded > 0 && (
        <div className="mt mb" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <b>Checklist progress</b>
          <Progress pct={task.progress_pct} graded={task.progress_graded} passed={task.progress_passed} width={160} />
          <span className="muted" style={{ fontSize: 12 }}>(latest submitted execution · display only)</span>
        </div>
      )}
```

- [ ] **Step 3: Crews.jsx — assigned-work progress**

Run: `grep -n "detail.tasks.map\|assigned" frontend/src/pages/Crews.jsx` and read the assigned-work table (the one rendering `detail.tasks`). Add a `Progress` cell after the task status cell and a matching header cell.

- [ ] **Step 4: DocumentReport.jsx — TaskRows progress**

Run: `sed -n '255,300p' frontend/src/components/DocumentReport.jsx` and read the `TaskRows` component. Add a `<th>Progress</th>` header cell and, in each task row, `<td><Progress pct={t.progress_pct} graded={t.progress_graded} passed={t.progress_passed} /></td>` when the row's task object exposes `progress_graded` (guard with `t.progress_graded > 0 ? ... : <span className="muted">—</span>`).

- [ ] **Step 5: Build check**

Run: `cd /workspace/frontend && npm run build` — clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/TaskDetail.jsx frontend/src/pages/Crews.jsx frontend/src/components/DocumentReport.jsx
git commit -m "feat(tasks): surface checklist progress in task detail, crews and documents"
```

---

### Task 12: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Backend syntax + frontend build**

Run: `cd /workspace/backend && for f in auth.js taskProgress.js server.js routes/tasks.js routes/performance.js routes/reports.js routes/crews.js; do node -c "$f" || exit 1; done`
Run: `cd /workspace/frontend && npm run build`

- [ ] **Step 2: Full e2e against the isolated instance**

Restart the verify terminal. Run every python heredoc from Tasks 1-7 again; all must print `OK`.

- [ ] **Step 3: Restart the live backend on :3001 with the new code**

Kill the running :3001 dev backend terminal and start it again with its original command (`npm run dev` inside `/workspace/backend`), then confirm `TMMS backend listening on http://localhost:3001` and that the Vite app on :5173 still proxies.

- [ ] **Step 4: Final report to the user**

Summarize: endpoints added, permission change, the two `VFY-BULK-*` drafts left only in `/tmp/opencode/tmms-a.db` (never in the live DB), and the preview URL. Do not delete the temp DB — if cleanup is desired, ask the user first.
