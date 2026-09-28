# Follow-up Task List Carry-over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a follow-up task (auto-EMERGENCY or one-click recommended CORRECTIVE) is generated from a completed task, the child carries the source task's checklist template plus a persisted, ordered work-item list derived from the source's failures/findings/GPS evidence, visible on task detail.

**Architecture:** Extend the existing follow-up engine in `backend/routes/tasks.js`. Add one table `task_work_item` in `backend/db.js`. Derive candidate items from a completed source task (`deriveWorkItems`), preview them on recommended plans (`carry_count`), persist them when the child task is created, return them on `GET /tasks/:id` and on the raised-children mapping, and allow OPEN/DONE toggling via a scoped `PATCH` endpoint. Frontend TaskDetail renders a carry-over preview with a template picker, a Work items block, and per-row status toggles.

**Tech Stack:** Node/Express backend (better-sqlite3 via `backend/db.js`), plain React frontend (Vite), no new npm dependencies.

## Global Constraints

- No new npm packages. Use existing helpers `insertRow`/`updateRow`/`list`/`get` from `backend/util.js`.
- Follow-up dedupe semantics unchanged: an open same-`task_type` task on the identical target-key set still suppresses creation (409).
- Checklist execution/verification flow unchanged (`/tasks/:id/checklist` untouched). Carrying the template only pre-attaches `checklist_template_id` on the child.
- Manual task creation in `Tasks.jsx` unchanged.
- No per-item notes/attachments/photos this phase; work-item status is `OPEN`/`DONE` only.
- Repo commit style: conventional messages (`feat(infra):`, `fix(...):`); commit hook auto-appends `Co-authored-by: monkeycode-ai <monkeycode-ai@chaitin.com>` — never add trailers or `git add -A`. Never run destructive commands (`rm`, drop, etc.). Servers only via the background-terminal tooling, never foreground `&`.
- Backend syntax gate: `node -c backend/routes/tasks.js` and `node -c backend/db.js`. Frontend gate: `npm run build` in `frontend/`.

---

### Task 1: `task_work_item` table + derivation + read helpers

**Files:**
- Modify: `backend/db.js` (add table near the `task_link`/`task` block, ~line 237)
- Modify: `backend/routes/tasks.js` (helpers + `GET /tasks/:id` enrichment)

**Interfaces:**
- Consumes: `db`, `get`, `insertRow` from `backend/util.js`; `task`/`task_finding`/`checklist_item`/`checklist_execution`/`checklist_execution_item`/`gps_validation` tables.
- Produces:
  - `listWorkItems(taskId)` → `Array<{id, task_id, sequence, kind, title, detail, source_type, source_id, status, created_at}>` ordered by `sequence`.
  - `deriveWorkItems(sourceTask)` → array of `{kind:'CHECKLIST'|'FINDING'|'GPS'|'REMEDIATE', title, detail, source_type, source_id}` (no `task_id`/`sequence` yet; sequence assigned at insert).
  - `GET /tasks/:id` response includes `work_items`.

- [ ] **Step 1: Add the table to db.js**

In `backend/db.js`, inside the same schema block that creates `task_link` (find the `CREATE TABLE IF NOT EXISTS task_link (...)` block ending around line 237), append immediately after it:

```js
  CREATE TABLE IF NOT EXISTS task_work_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    sequence INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'REMEDIATE',
    title TEXT NOT NULL,
    detail TEXT,
    source_type TEXT,
    source_id INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_work_item_task ON task_work_item(task_id);
```

- [ ] **Step 2: Syntax check the DB change**

Run: `node -c backend/db.js`
Expected: no output, exit 0. (Table creation itself is verified in Task 7's e2e against a fresh DB.)

- [ ] **Step 3: Add helpers to tasks.js**

In `backend/routes/tasks.js`, directly below the `taskDetail` function (ends line 36):

```js
function listWorkItems(taskId) {
  return db.prepare('SELECT * FROM task_work_item WHERE task_id = ? ORDER BY sequence').all(taskId);
}

// Derive the ordered work-item list a follow-up task should carry, from the
// evidence recorded on a completed source task. Ordering: failed critical
// checklist steps (in template order), then HIGH/CRITICAL findings (critical
// first), then one GPS item, then a defensive REMEDIATE fallback.
function deriveWorkItems(source) {
  const items = [];
  const failedCritical = db.prepare(
    `SELECT ci.id AS template_item_id, ci.sequence, ci.instruction
     FROM checklist_execution_item i
     JOIN checklist_item ci ON ci.id = i.template_item_id
     JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ? AND i.result = 'FAIL' AND ci.critical_step = 1
     GROUP BY ci.id ORDER BY ci.sequence`
  ).all(source.id);
  for (const s of failedCritical) {
    items.push({ kind: 'CHECKLIST', title: s.instruction, source_type: 'checklist_item', source_id: s.template_item_id });
  }
  const findings = db.prepare(
    `SELECT id, title, detail, severity FROM task_finding
     WHERE task_id = ? AND severity IN ('HIGH','CRITICAL') ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, id`
  ).all(source.id);
  for (const f of findings) {
    items.push({ kind: 'FINDING', title: f.title, detail: f.detail || null, source_type: 'task_finding', source_id: f.id });
  }
  const gpsItemFail = db.prepare(
    `SELECT COUNT(*) c FROM checklist_execution_item i JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ? AND i.result = 'FAIL' AND i.response_type = 'GPS_POINT'`
  ).get(source.id).c;
  const gpsFail = db.prepare("SELECT COUNT(*) c FROM gps_validation WHERE linked_task_id = ? AND result = 'FAIL'").get(source.id).c;
  if (gpsItemFail > 0 || gpsFail > 0) {
    items.push({ kind: 'GPS', title: 'GPS location mismatch — re-verify position', source_type: 'gps_validation', source_id: null });
  }
  if (items.length === 0 && (source.result === 'FAIL' || source.status === 'FAILED')) {
    items.push({ kind: 'REMEDIATE', title: 'Inspect and remediate the affected asset', source_type: null, source_id: null });
  }
  return items;
}
```

- [ ] **Step 4: Enrich `GET /tasks/:id` with work items**

In `backend/routes/tasks.js`, inside the `router.get('/tasks/:id', ...)` handler (currently ends ~line 198), add the line before `t.attachments = listForTask(t.id);`:

```js
  t.work_items = listWorkItems(t.id);
```

- [ ] **Step 5: Syntax check**

Run: `node -c backend/routes/tasks.js`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/db.js backend/routes/tasks.js
git commit -m "feat(followup): task_work_item table and work-item derivation"
```

---

### Task 2: Carry-over preview on plans + persist items at creation

**Files:**
- Modify: `backend/routes/tasks.js` (`buildFollowUpPlans`, `createFollowUpTask`, `taskFollowUpView`, `applyAutoFollowUps` region ~lines 478-555)

**Interfaces:**
- Consumes: `deriveWorkItems(source)` from Task 1.
- Produces:
  - Each plan object in `buildFollowUpPlans` gains `carry_count`, `carry_checklist_template_id`, `carry_checklist_name`.
  - `createFollowUpTask(req, source, plan)` reads optional `plan.checklist_template_id`; resolves default `source.checklist_template_id`; persists derived items on the child; returns the child id (null on dedupe as today).
  - `taskFollowUpView`'s raised-children (`follow_ups`) each include `work_items`.
  - `applyAutoFollowUps` uses the source default template.

- [ ] **Step 1: Extend `buildFollowUpPlans` with carry previews**

Replace the body of `buildFollowUpPlans` (currently the function between `// Auto = EMERGENCY tasks...` and `function createFollowUpTask`) so the source template name and derived-item count are computed once and attached to every produced plan. The full new function:

```js
function buildFollowUpPlans(source) {
  const s = followUpSignals(source);
  const auto = [];
  const recommend = [];
  const reason = followUpReason(s);
  const carriedItems = deriveWorkItems(source);
  const tpl = source.checklist_template_id ? get('checklist_template', source.checklist_template_id) : null;
  const carry = {
    carry_count: carriedItems.length,
    carry_checklist_template_id: source.checklist_template_id || null,
    carry_checklist_name: tpl ? tpl.name : null,
  };
  if (isEmergency(s)) {
    const due = new Date();
    due.setHours(due.getHours() + 48);
    auto.push({
      key: 'emergency',
      task_type: 'EMERGENCY',
      priority: 'HIGH',
      status: 'ASSIGNED',
      title: `EMERGENCY follow-up — ${source.task_number}`,
      description: `Automatic emergency corrective task raised from ${source.task_number} after ${s.result || 'completion'}${reason ? `: ${reason}.` : '.'} Inspect and remediate the affected asset immediately.`,
      reason: reason || 'Failed inspection result',
      due_date: due.toISOString(),
      ...carry,
    });
  } else if (s.result === 'PARTIAL' || s.result === 'DEFERRED' || s.mediumLow > 0) {
    const due = new Date();
    due.setDate(due.getDate() + 7);
    recommend.push({
      key: 'corrective',
      task_type: 'CORRECTIVE',
      priority: 'MEDIUM',
      status: 'DRAFT',
      title: `Corrective follow-up — ${source.task_number}`,
      description: `Planned corrective task generated from ${source.task_number} (result ${s.result || 'PASS'})${s.mediumLow ? `: ${s.mediumLow} low/medium finding(s) recorded.` : '.'}`,
      reason: s.mediumLow ? `${s.mediumLow} low/medium finding(s) recorded` : `partial/deferred result ${s.result}`,
      due_date: due.toISOString(),
      ...carry,
    });
  }
  return { auto, recommend };
}
```

- [ ] **Step 2: Persist items + template in `createFollowUpTask`**

Replace `createFollowUpTask` (currently lines ~527-548) with:

```js
function createFollowUpTask(req, source, plan) {
  if (openTaskLike(source, plan.task_type)) return null;
  const now = new Date().toISOString();
  const templateId = plan.checklist_template_id !== undefined && plan.checklist_template_id !== null
    ? plan.checklist_template_id
    : source.checklist_template_id || null;
  const id = insertRow('task', {
    ...baseFollowUpTask(source),
    task_number: nextTaskNumber(),
    title: plan.title,
    description: plan.description || null,
    task_type: plan.task_type,
    priority: plan.priority,
    priority_reason: plan.reason || null,
    status: plan.status,
    due_date: plan.due_date || null,
    checklist_template_id: templateId,
    created_by: req.user.person_id || null,
    assigned_by: plan.status === 'ASSIGNED' ? req.user.person_id || null : null,
    created_at: now,
    updated_at: now,
    revision: 1,
  });
  const derived = deriveWorkItems(source);
  derived.forEach((item, idx) => {
    insertRow('task_work_item', {
      task_id: id,
      sequence: idx + 1,
      kind: item.kind,
      title: item.title,
      detail: item.detail || null,
      source_type: item.source_type || null,
      source_id: item.source_id ?? null,
      status: 'OPEN',
      created_at: now,
    });
  });
  db.prepare("INSERT INTO task_link (task_id, linked_task_id, link_type) VALUES (?, ?, 'FOLLOW_UP')").run(id, source.id);
  audit(req.user, 'CREATE', 'task', id, { follow_up: true, source_task: source.id, task_type: plan.task_type, reason: plan.reason || null, checklist_template_id: templateId, work_items: derived.length });
  return id;
}
```

- [ ] **Step 3: Include `work_items` on raised children**

In `taskFollowUpView`, replace the children mapping line

```js
  return { followUps: children.map(taskDetail), recommended };
```

with

```js
  return {
    followUps: children.map((c) => ({ ...taskDetail(c), work_items: listWorkItems(c.id) })),
    recommended,
  };
```

`applyAutoFollowUps` and `taskFollowUpView` otherwise remain unchanged (auto plans now carry the source template via the `carry` spread because `buildFollowUpPlans` attaches `carry_checklist_template_id`, and `createFollowUpTask` defaults `templateId` to the source's template).

- [ ] **Step 4: Syntax check**

Run: `node -c backend/routes/tasks.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(followup): carry template and work items onto generated follow-up tasks"
```

---

### Task 3: Template choice on one-click materialise + PATCH work-item status

**Files:**
- Modify: `backend/routes/tasks.js` (the `POST /tasks/:id/follow-ups` route ~lines 569-583, plus new PATCH route)

**Interfaces:**
- Consumes: `createFollowUpTask` (Task 2), `listWorkItems` (Task 1), `taskVisible`, `can`, `isCrewUser`, `audit`, `get`, `updateRow` — all already imported in tasks.js.
- Produces: `POST /tasks/:id/follow-ups` accepts optional `checklist_template_id` (number → child uses it; `null`/omitted → child uses source default); `PATCH /tasks/:id/work-items/:itemId` `{status:'OPEN'|'DONE'}` returns the updated item.

- [ ] **Step 1: Accept `checklist_template_id` on the materialise route**

Replace the body of `router.post('/tasks/:id/follow-ups', ...)` (from the `const { auto, recommend } = buildFollowUpPlans(source);` line through the 201 response) with:

```js
  const { auto, recommend } = buildFollowUpPlans(source);
  const plans = [...auto, ...recommend];
  const plan = req.body.key ? plans.find((p) => p.key === req.body.key) : plans[0];
  if (!plan) return res.status(409).json({ error: 'No follow-up work is warranted from this task result' });
  let templateChoice = plan.carry_checklist_template_id ?? null;
  if (req.body.checklist_template_id !== undefined && req.body.checklist_template_id !== null && req.body.checklist_template_id !== '') {
    const requested = Number(req.body.checklist_template_id);
    const tpl = Number.isInteger(requested) ? get('checklist_template', requested) : null;
    if (!tpl || tpl.status !== 'ACTIVE') return res.status(400).json({ error: 'checklist_template_id must reference an existing ACTIVE template' });
    templateChoice = tpl.id;
  } else if (req.body.checklist_template_id === null) {
    templateChoice = null;
  }
  const created = createFollowUpTask(req, source, { ...plan, checklist_template_id: templateChoice, status: req.body.status || plan.status });
  if (!created) return res.status(409).json({ error: 'An open follow-up of this type already targets the same asset — nothing duplicated' });
  res.status(201).json(taskDetail(get('task', created)));
```

Note: an explicit JSON `null` body value means "no template"; omitted/empty string means "use source default".

- [ ] **Step 2: Add the PATCH work-item route**

Append this route at the end of `backend/routes/tasks.js` (after the last existing route):

```js
router.patch('/tasks/:id/work-items/:itemId', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const allowed = can(req, 'task:execute') || can(req, 'task:lead') || can(req, 'task:manage');
  if (!allowed) return res.status(403).json({ error: 'Forbidden: requires task:execute, task:lead or task:manage' });
  if (isCrewUser(req.user) && !(t.crew_id && t.crew_id === req.user.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  const item = get('task_work_item', Number(req.params.itemId));
  if (!item || item.task_id !== t.id) return res.status(404).json({ error: 'Work item not found' });
  const status = req.body.status;
  if (status !== 'OPEN' && status !== 'DONE') return res.status(400).json({ error: 'status must be OPEN or DONE' });
  updateRow('task_work_item', item.id, { status, updated_at: new Date().toISOString() });
  audit(req.user, 'UPDATE', 'task_work_item', item.id, { task_id: t.id, status });
  res.json(get('task_work_item', item.id));
});
```

- [ ] **Step 3: Syntax check**

Run: `node -c backend/routes/tasks.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(followup): template choice on materialise and work-item status endpoint"
```

---

### Task 4: TaskDetail — carry preview, template picker, raised-row hint

**Files:**
- Modify: `frontend/src/pages/TaskDetail.jsx`

**Interfaces:**
- Consumes: `task.recommended_follow_ups[i]` with `{key, task_type, title, description, reason, priority, due_date, status, carry_count, carry_checklist_template_id, carry_checklist_name}`; `task.follow_ups` rows with `{id, task_number, title, task_type, priority, status, due_date, work_items}`; `api.get('/checklists')` returning ACTIVE templates; `createFollowUp` already defined (lines 95-102).
- Produces: none (UI only).

- [ ] **Step 1: Add template-list state and loader**

Inside the `TaskDetail` component add state near `fuBusyKey`:

```js
  const [checklists, setChecklists] = useState([]);
  const [fuTemplate, setFuTemplate] = useState({});
```

And in the mount `useEffect` (the one keyed on `[id]`), after `load()`:

```js
    api.get('/checklists').then(setChecklists).catch(() => {});
```

- [ ] **Step 2: Update `createFollowUp` to send the chosen template**

Replace the existing `createFollowUp` function (lines 95-102) with:

```js
  async function createFollowUp(key, carryTemplateId) {
    try {
      setFuBusyKey(key);
      const picked = fuTemplate[key] === undefined ? carryTemplateId : fuTemplate[key];
      const body = { key };
      if (picked !== undefined && picked !== null && picked !== '') body.checklist_template_id = Number(picked);
      else if (picked === '') body.checklist_template_id = null;
      await api.post(`/tasks/${task.id}/follow-ups`, body);
      load();
    } catch (e) { setError(e.message); }
    finally { setFuBusyKey(null); }
  }
```

(`fuTemplate[plan.key]` starts `undefined` → the backend source default (`carryTemplateId`) is used. If the user picks the empty "no checklist" option, the select stores `''` → the front-end sends explicit `null` → the child is created with no template but still carries work items.)

- [ ] **Step 3: Render carry preview + template picker in the recommended card**

Replace the whole "Recommended follow-up" card block (from `{(task.recommended_follow_ups || []).length > 0 && (` through its closing `)}` at the line before `{canCreate && ...}` ends the card — the block currently spans lines ~401-420) with:

```jsx
      {(task.recommended_follow_ups || []).length > 0 && (
        <div className="card card-pad">
          <div className="spread"><b>Recommended follow-up</b><span className="muted">based on this task result &amp; findings</span></div>
          {(task.recommended_follow_ups || []).map((plan) => (
            <div key={plan.key} className="spread mt" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', flexWrap: 'wrap', gap: '6px 10px' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <b><Pill value={plan.task_type} /> {plan.title}</b>
                <div className="muted" style={{ fontSize: 12 }}>{plan.reason}</div>
                {plan.description && <div className="muted" style={{ fontSize: 12 }}>{plan.description}</div>}
                {plan.carry_count > 0 ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Carries {plan.carry_count} work item(s)
                    {plan.carry_checklist_name ? <> · checklist “{plan.carry_checklist_name}”</> : null}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>No work items to carry from the source task.</div>
                )}
              </div>
              <div style={{ textAlign: 'right', maxWidth: 300 }}>
                <div className="muted" style={{ fontSize: 11 }}>due {fmtDate(plan.due_date)} · priority {plan.priority}</div>
                {canCreate && (
                  <>
                    <div className="field" style={{ margin: '6px 0' }}>
                      <label>Checklist template</label>
                      <select
                        style={{ width: '100%' }}
                        value={fuTemplate[plan.key] ?? String(plan.carry_checklist_template_id ?? '')}
                        onChange={(e) => setFuTemplate({ ...fuTemplate, [plan.key]: e.target.value })}
                      >
                        {plan.carry_checklist_template_id ? (
                          <option value={String(plan.carry_checklist_template_id)}>Source default — {plan.carry_checklist_name}</option>
                        ) : (
                          <option value="">No source template (default)</option>
                        )}
                        {checklists.filter((c) => c.status === 'ACTIVE' && c.id !== plan.carry_checklist_template_id).map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name}</option>
                        ))}
                        <option value="">— no checklist —</option>
                      </select>
                    </div>
                    <button className="btn btn-sm btn-primary mt" disabled={fuBusyKey === plan.key} onClick={() => createFollowUp(plan.key, plan.carry_checklist_template_id)}>
                      {fuBusyKey === plan.key ? 'Creating…' : 'Create task'}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 4: Show a carry hint on raised follow-up rows**

In the "Raised follow-up tasks" table body (the `(task.follow_ups || []).map((fu) => (...))` row), replace the task cell content

```jsx
                    <td><b>{fu.task_number}</b><br /><span className="muted">{fu.title}</span></td>
```

with

```jsx
                    <td>
                      <b>{fu.task_number}</b><br />
                      <span className="muted">{fu.title}</span>
                      {(fu.work_items || []).length > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>carries {fu.work_items.length} work item(s)</div>
                      )}
                    </td>
```

- [ ] **Step 5: Build + commit**

Run: `cd frontend && npm run build`
Expected: build succeeds.

```bash
git add frontend/src/pages/TaskDetail.jsx
git commit -m "feat(followup): recommended follow-up carry preview with template picker"
```

---

### Task 5: TaskDetail — Work items block with status toggles

**Files:**
- Modify: `frontend/src/pages/TaskDetail.jsx`

**Interfaces:**
- Consumes: `task.work_items` array `{id, sequence, kind, title, detail, source_type, status}`; `PATCH /tasks/:id/work-items/:itemId`; permission flags from TaskDetail (`canExecute`, `canSubmit`, `canManage`; note `canSubmit` is the `task:lead` holder).
- Produces: none.

- [ ] **Step 1: Add the toggle handler and permission flag**

Inside the `TaskDetail` component, near the other handlers (after `createFollowUp`), add:

```js
  const canToggleItems = canExecute || canSubmit || canManage;
  async function toggleWorkItem(item, status) {
    try {
      await api.patch(`/tasks/${task.id}/work-items/${item.id}`, { status });
      load();
    } catch (e) { setError(e.message); }
  }
```

- [ ] **Step 2: Render the Work items block**

Insert this block immediately before the `<h3 className="section-title">Task dossier</h3>` heading (near line 355):

```jsx
      {(task.work_items || []).length > 0 && (
        <>
          <h3 className="section-title">Work items</h3>
          <div className="card card-pad">
            {(task.work_items || []).map((wi) => (
              <div key={wi.id} className="spread" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginTop: wi.sequence > 1 ? 6 : 0, gap: '6px 10px' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className="pill" style={{ background: '#f1f5f9', color: wi.kind === 'CHECKLIST' ? '#0369a1' : wi.kind === 'FINDING' ? '#b45309' : wi.kind === 'GPS' ? '#7c3aed' : '#475569' }}>
                      {wi.kind}
                    </span>
                    <b>{wi.sequence}. {wi.title}</b>
                  </div>
                  {wi.detail && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{wi.detail}</div>}
                </div>
                {canToggleItems ? (
                  <label className="flex" style={{ gap: 6, fontSize: 13, alignItems: 'center', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={wi.status === 'DONE'} onChange={(e) => toggleWorkItem(wi, e.target.checked ? 'DONE' : 'OPEN')} />
                    {wi.status === 'DONE' ? 'Done' : 'Open'}
                  </label>
                ) : (
                  <Pill value={wi.status} />
                )}
              </div>
            ))}
          </div>
        </>
      )}
```

- [ ] **Step 3: Build + commit**

Run: `cd frontend && npm run build`
Expected: build succeeds.

```bash
git add frontend/src/pages/TaskDetail.jsx
git commit -m "feat(followup): work items block with open/done toggles on task detail"
```

---

### Task 6: Full-stack verification (isolated DB)

**Files:** none (verification only; no commits unless a defect is found)

- [ ] **Step 1: Boot a throwaway backend on an isolated copy of the demo DB**

Copy the working DB to a scratch path (SQLite copy is safe when the source server is quiesced or via `VACUUM INTO`):

```bash
node -e "const {db}=require('/workspace/backend/db'); db.exec(\"VACUUM INTO '/tmp/opencode/fu-plan/fu.db'\"); console.log('copied');"
```

Then start on an ephemeral port with the scratch DB (use the background-terminal tooling, e.g. `PORT=3991 TMMS_DB=/tmp/opencode/fu-plan/fu.db node server.js` from `/workspace/backend`), and confirm from the log that it is listening. Confirm the `task_work_item` table exists on the fresh DB:

```bash
node -e "const {db}=require('/workspace/backend/db'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='task_work_item'\").get());"
```

- [ ] **Step 2: Find or create a task with FAIL + critical step + HIGH finding, then verify it**

Using `curl` against the scratch server (login `admin`/`Admin@123` first, capture the Bearer token):
1. Find a `PENDING_VERIFICATION` task (or drive one there via state actions).
2. Verify it with result FAIL.
3. Confirm the auto-created EMERGENCY child appears under `follow_ups` in `GET /tasks/:sourceId`, carries `work_items` (non-empty), and has `checklist_template_id` equal to the source task's.
4. `GET /tasks/:childId` returns ordered `work_items`; spot-check a CHECKLIST item's `title` matches a failed critical step instruction.

- [ ] **Step 3: One-click create with an alternate template + PATCH toggle**

1. On a task whose recommended follow-ups include a `corrective` plan, `POST /tasks/:id/follow-ups` with `{"key":"corrective","checklist_template_id":<another ACTIVE template id>}` → 201, child uses the alternate id.
2. `POST /tasks/:id/follow-ups` again with same key → 409 (dedupe intact).
3. `PATCH /tasks/:childId/work-items/:itemId {"status":"DONE"}` → 200, then `GET` shows status DONE; a repeat PATCH back to OPEN works.
4. As a crew user of a different task, PATCH the same item → 403/404.
5. Bad template id on materialise → 400.

- [ ] **Step 4: Frontend gates + cleanup**

Run: `cd /workspace/frontend && npm run build` and `node -c backend/routes/tasks.js && node -c backend/db.js`
Expected: all pass. Kill the scratch server via its background terminal. Record results in the task report. If a real defect is found, commit a fix with `git add <files>` (never `-A`) and message `fix(followup): …`.

---

### Task 7: Plan self-review follow-ups from spec

Nothing to implement — the spec's §4.4 "list page unchanged" and §5.2 "hint only where child already carries work_items" are satisfied in Task 2/4; §5.1's explicit "None" template choice is satisfied in Task 3/4. Verify no placeholders remain by reading the final plan back against the spec §1-§7 once.
