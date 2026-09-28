# Follow-up Task List Carry-over Design

Date: 2026-09-08. Phase A of the front-end polish workstream (phases: A follow-up task list
carry-over; B unified Hub look; C live/SPA dynamism). Extends the follow-up engine specified in
`2026-09-04-followup-engine-and-scoped-print-design.md`.

## 1. Problem

Today, when a task is verified as FAIL / with critical findings / critical-step or GPS failure, the
backend auto-creates an EMERGENCY follow-up task (and, for PARTIAL/DEFERRED or LOW/MEDIUM findings,
offers a one-click CORRECTIVE recommended follow-up). Those generated child tasks carry only prose
(title + description + reason) and no structured, actionable work list, and they never attach the
source task's checklist. A crew opening the generated EMERGENCY task sees text but no step-by-step
work to perform, and no easy way to re-run the exact checklist steps that failed.

## 2. Goals

When a follow-up task is generated (auto-EMERGENCY on verify, or one-click recommended CORRECTIVE):

1. The child task **carries the source task's checklist template** by default (so the crew can
   re-run the same failed steps on the same target).
2. The child task **carries an ordered work-item list** auto-derived from the source task's
   evidence: failed critical checklist steps, HIGH/CRITICAL field findings, GPS failures.
3. A planner materialising a recommended follow-up can **choose a different ACTIVE checklist
   template** instead of the source default; auto-created EMERGENCY tasks keep the source default.
4. Work items are persisted per task and visible on the task detail, with a simple OPEN/DONE
   status so crews can track remediation.

## 3. Non-goals

- No changes to the follow-up dedupe semantics (open same-type + same-target-key still suppresses
  creation).
- No changes to checklist execution/verification flow (checklists still run via the existing
  `/tasks/:id/checklist` route; carrying the template only pre-attaches `checklist_template_id`).
- Manual task creation in the Tasks page is unchanged (template picker stays as-is).
- No per-item comments/attachments/photos on work items (out of scope for this phase).

## 4. Backend

### 4.1 New table `task_work_item` (db.js)

```
CREATE TABLE IF NOT EXISTS task_work_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES task(id),
  sequence    INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'REMEDIATE',   -- CHECKLIST | FINDING | GPS | REMEDIATE
  title       TEXT NOT NULL,
  detail      TEXT,
  source_type TEXT,                                -- 'checklist_item' | 'task_finding' | 'gps_validation' | null
  source_id   INTEGER,
  status      TEXT NOT NULL DEFAULT 'OPEN',        -- OPEN | DONE
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_work_item_task ON task_work_item(task_id);
```

Created via the existing `CREATE TABLE IF NOT EXISTS` block in db.js. No column migration needed
(whole new table). Helpers added alongside existing `insertRow`/`list` usage in `backend/routes/tasks.js`.

### 4.2 Derivation `deriveWorkItems(t)` (backend/routes/tasks.js)

Given a completed source task row `t`, return an ordered candidate item list:

- For each **failed critical checklist step** (join `checklist_execution_item` ->
  `checklist_item.critical_step=1`, `result='FAIL'`), emit:
  `{ kind:'CHECKLIST', title: <instruction text>, source_type:'checklist_item', source_id:<template_item_id> }`.
  Deduplicate repeated failures of the same step across executions (keep first occurrence).
- For each **HIGH or CRITICAL finding** (`task_finding.severity IN ('HIGH','CRITICAL')`), emit:
  `{ kind:'FINDING', title: <finding.title>, detail: <finding.detail>, source_type:'task_finding', source_id:<finding.id> }`.
- If any GPS failure exists (a `GPS_POINT` checklist item FAIL or `gps_validation.result='FAIL'`),
  emit one: `{ kind:'GPS', title:'GPS location mismatch — re-verify position', source_type:'gps_validation' }`.
- Defensive fallback: if none of the above produced items and the task result is FAIL or an
  emergency signal fired, emit one generic `{ kind:'REMEDIATE', title:'Inspect and remediate the affected asset' }`.

Ordering: CHECKLIST items in step order, then FINDING items (CRITICAL before HIGH), then GPS,
then REMEDIATE fallback.

### 4.3 Creation (`createFollowUpTask`)

`buildFollowUpPlans(source)` and `taskFollowUpView(source)` gain carry-over preview fields on each
plan object (`auto` and `recommend`):
- `carry_checklist_template_id` - source task's `checklist_template_id` (or null)
- `carry_checklist_name` - template name if any
- `carry_count` - number of work items that would be derived (`deriveWorkItems(source).length`)

`createFollowUpTask(req, source, plan)` signature extended to accept an optional
`checklist_template_id` on the plan (and to accept the item list to persist):
- default `checklist_template_id` = `source.checklist_template_id`
- one-click endpoint `POST /tasks/:id/follow-ups` accepts optional body `checklist_template_id`;
  validates it is an existing ACTIVE template when provided (400 otherwise), else uses the default.
- Auto path (`applyAutoFollowUps`) always uses the source default; it is NOT user-selectable.

Insert order:
1. Insert the child task row as today, now including `checklist_template_id` when resolved non-null.
2. Derive items via `deriveWorkItems(source)` and insert each as a `task_work_item` row on the child
   (sequence 1..n), status OPEN.
3. Link + audit as today (audit payload gains `work_items: <count>`).

### 4.4 Read enrichment

- `GET /tasks/:id` returns `work_items` (rows ordered by `sequence`) whenever present (empty array
  otherwise).
- `GET /tasks` (list) does NOT fetch items per row (perf); the list UI only shows the raised child's
  `carries_n_items` via the child detail if needed - decided: list page shows a count only when the
  client opens detail. Keep list payload unchanged.
- Recommended plans already flow through `taskFollowUpView`; they now include the carry-over preview
  fields so the UI can render the preview card.

### 4.5 Work-item status endpoint

`PATCH /tasks/:id/work-items/:itemId` body `{ status: 'OPEN'|'DONE' }`. Status only in this phase
(no per-item note column; detail stays immutable).
- Permissions: `task:execute` or `task:lead` or `task:manage`, plus scope check (same rules as
  `taskVisible`). Crew users restricted to their own task (`isCrewUser` guard as elsewhere).
- Returns the updated item. Audits the change.

## 5. Frontend

### 5.1 TaskDetail recommended follow-up card (the panel in the screenshot)

The "Recommended follow-up" card (TaskDetail.jsx ~lines 401-420) becomes a richer **preview**:

- Header + reason/description/due/priority as today.
- Carry-over summary line: e.g. "Carries 6 work item(s): 3 checklist step(s) from TK-2026-000002,
  2 finding(s), 1 GPS". Empty state line when `carry_count === 0` ("No work items to carry").
- **Checklist template select** shown to `task:create` holders, defaulting to the carried source
  template (`carry_checklist_template_id`), options = ACTIVE templates fetched from `/checklists`
  (same source as the Tasks modal). Optional "— none —" allowed only when there is no carried
  default? decision: allow explicit "None" choice; passing `null` creates the child without a
  template but still with work items.
- "Create task" button passes `{ key, checklist_template_id }` to
  `POST /tasks/:id/follow-ups`. Busy state and 409 dedupe error surfaced as today (error banner).

### 5.2 Raised follow-up tasks table

Row for each auto-created child gains a muted "· carries N work item(s)" hint under the title when
the child detail reports items; keep the "Open" link. Because the list view (`GET /tasks`) does not
include `work_items`, the hint is only shown when the child object already carries the field (it is
populated in this same parent-detail response via the children mapping in `taskFollowUpView`, where
children are mapped with `taskDetail`). Confirm children mapping includes `work_items` (cheap, per
child single query) - decision: include it; the number of auto children per parent is small.

### 5.3 Work items block on TaskDetail

Any task whose detail includes `work_items.length > 0` renders a **Work items** card under the
field log:

- Ordered numbered list; each row shows kind chip (CHECKLIST/FINDING/GPS/REMEDIATE), title, detail
  (findings), and an OPEN/DONE state toggle.
- Toggle enabled only for `task:execute`/`task:lead`/`task:manage` holders within scope; otherwise
  the status is shown read-only as a Pill.
- Optimistic update on toggle via `PATCH /tasks/:id/work-items/:itemId`, then reload task.
- Only shown on tasks that actually have items (auto children, materialised children). Plain manual
  tasks without items show nothing.

### 5.4 Styles

Small CSS additions only (chip variants, toggle styling); Phase B owns the broader restyle.

## 6. Files touched

- `backend/db.js` - `task_work_item` table + index.
- `backend/routes/tasks.js` - derivation, creation carry-over, plan preview fields, work-items
  endpoint, `GET /tasks/:id` enrichment, children mapping in `taskFollowUpView`.
- `frontend/src/pages/TaskDetail.jsx` - recommended card preview + template select, raised table
  hint, Work items block, PATCH toggle.
- `frontend/src/styles.css` - minor additions.

## 7. Verification

Isolated-DB e2e (same pattern as prior phases, background server on an ephemeral port):
1. Seed/complete a task with a FAIL verify (critical step + HIGH finding + GPS FAIL) ->
   auto-created EMERGENCY child carries source `checklist_template_id` and N `work_items`.
2. `GET /tasks/:id` on the child returns ordered items; counts match expectations.
3. One-click create a CORRECTIVE recommended follow-up passing an alternate `checklist_template_id`
   -> child uses the alternate; omit -> child uses source default.
4. PATCH an item OPEN->DONE (allowed) and again from a crew of a different task (403/404).
5. Dedupe: re-verify / re-materialise returns 409 unchanged.
6. `node -c` clean on backend files; `npm run build` clean on frontend.
