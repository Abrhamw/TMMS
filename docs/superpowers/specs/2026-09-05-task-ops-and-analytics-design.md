# Task Operations & Analytics Enhancements

Date: 2026-09-05. Source inspiration: the legacy EEP "cms" Flask system
(`.monkeycode-tmp-files/8f58bc61-cms-1.py`), compared capability-by-capability against TMMS.
This spec covers the task-list productivity and analytics package only. A sibling spec
`2026-09-05-geo-import-and-asset-defaults-design.md` covers geo import and asset defaults.

## 1. Goal

Give planners and managers the reference system's task data tooling without weakening TMMS's
workflow state machine or RBAC:

- ① CSV export of the filtered task list.
- ② Safe bulk update (priority / due date / crew assignment / schedule start) of multiple tasks.
- ③ Region-scoped task KPIs (overdue, critical-overdue, completion rate, average cycle time,
  completed-this-week).
- ④ Crew and person task-performance view (totals / completed / on-time / violation counts).
- ⑤ Checklist progress % on task rows, task detail and dossiers (display only; status untouched).

## 2. Current state

- `GET /tasks` (`backend/routes/tasks.js:37`) already supports filters: `status, region_id,
  task_type, priority, overdue, q, crew_id, line_id, tower_id, asset_id, substation_id`; rows are
  region-scoped via `taskVisible(req.user, t)` and serialized by `taskDetail`.
- Workflow is a strict state machine (`/tasks/:id/state`) with `task:manage` forcing and
  crew-lead limited control — bulk edits must NOT bypass it.
- Permissions vocabulary is `resource:verb` (`backend/auth.js` `ROLE_PERMS`). Management roles
  share `OPERATIONS_WORKFLOW`; `PLANNER` additionally gets `task:create`/`task:manage`.
- No export or bulk endpoints exist. No task-progress concept exists (execution item results do).

## 3. RBAC decisions

- Add permission **`task:bulk`** to the `OPERATIONS_WORKFLOW` set in `backend/auth.js`
  (grants EXECUTIVE, REGION_DIRECTOR, REGION_MANAGER, SUBSTATION/TRANSMISSION/RELAY_SCADA
  MANAGER, SUPERVISOR) and to `PLANNER`. Mirror in the frontend permission list used for UI
  gating. DISPATCHER intentionally not included (bulk is a planning action).
- Export gated by `task:read` (any authenticated role that can see tasks). Performance data
  gated by `report:write` (EXECUTIVE / managers / AUDITOR / PLANNER) — the same gate the
  Reports page uses.
- Every bulk id is re-checked with `taskVisible`; partial access is rejected (403) rather than
  silently skipping ids.
- All writes are audited (`audit(req.user, ...)`).

## 4. Design

### 4.1 CSV export — ①

`GET /tasks/export.csv` accepts the same query filters as `GET /tasks` plus `format=csv` only.

- Rows use the identical region-scoped, filtered source as `GET /tasks`.
- Columns (hand-rolled CSV escaping, UTF-8, BOM for Excel):
  `task_number,title,task_type,priority,status,result,region,crew,target_type,target_name,
  checklist_template,due_date,scheduled_start,actual_start,actual_end,created_by,assigned_by,
  verified_by,progress_pct`
  - `target_type` = ASSET/TOWER/LINE/SUBSTATION/NONE and `target_name` resolved from the task.
  - `progress_pct` from §4.5.
- Response header `Content-Disposition: attachment; filename=tasks_<timestamp>.csv`.
- Audit `EXPORT` (`entity:'task'`, `{scope:'tasks_export', count}`).
- UI: Tasks toolbar "Export CSV" button (visible when the user has `task:read`).

### 4.2 Bulk update — ②

`POST /tasks/bulk` `{ ids: number[], action: string, value }`, gated by `task:bulk`.

- Allowed actions (deliberately safe subset — never a direct status write):
  - `priority` — value in `CRITICAL|HIGH|MEDIUM|LOW`.
  - `due_date` — ISO datetime string.
  - `schedule_start` — ISO datetime string.
  - `assign` — value = crew id; sets `crew_id` and `assigned_by = req.user.person_id`.
- Flow: load each id → 404 none found; verify every id passes `taskVisible` else 403; then
  `updateRow('task', id, patch)` for each and bump `revision`. Return
  `{ updated: n, ids: [...] }`.
- Single audit row `BULK` with `{action, value, count}`.
- UI: Tasks list gains row checkboxes; when ≥1 selected a bulk bar appears (role-gated by
  `task:bulk`) with controls for the four actions. Selecting an action applies to all checked.

### 4.3 KPI endpoint — ③

`GET /tasks/kpi`, region-scoped through `taskVisible`, gated by `task:read`.

Computes over the scoped set:
- `total`, `open` (any status in the existing `OPEN` constant), `completed`.
- `overdue` — open tasks with `due_date < now` (same definition as `?overdue=true`).
- `critical_overdue` — overdue AND `priority === 'CRITICAL'`.
- `completion_rate` — completed/total %, rounded.
- `avg_cycle_hours` — mean of `actual_end - scheduled_start` over COMPLETED tasks that have both;
  null when none.
- `completed_this_week` — COMPLETED tasks whose `actual_end` falls in the current ISO week.
- `by_status` and `by_type` counts (mirrors dashboard shape).

UI: Home dashboard shows overdue / critical-overdue / completion-rate / completed-this-week
cards (region-scoped as today); Tasks page header chips reuse the same endpoint.

### 4.4 Crew & person performance — ④

`GET /performance?scope=crew|person`, gated by `report:write`, region-scoped.

- `scope=crew`: one row per visible crew (or crews within the manager's region for managers):
  `{ id, name, tasks, completed, completion_rate, on_time, on_time_rate, findings, gps_violations }`
  where `on_time` counts COMPLETED tasks with `actual_end <= due_date`.
- `scope=person`: same shape keyed by `person` (executors referenced by
  `checklist_execution.executed_by`), counting executions rather than whole tasks, so both crew
  leads and members get a view of what they actually performed.
- Filter query params `status`, `date_from`, `date_to` (on task creation / execution date)
  optional.
- UI: Reports page gains a "Performance" block (rendered only when the user holds `report:write`)
  with crew/person toggle and small rate tables.

### 4.5 Checklist progress % — ⑤

`taskProgress(taskId)` helper in `backend/routes/tasks.js`:
- Take the latest submitted execution for the task (`checklist_execution` where
  `task_id=?` and `submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1`).
- `graded` = items with `result IN ('PASS','FAIL')`; `passed` = items with `result='PASS'`.
- `progress_pct` = `round(passed/graded*100)` when `graded>0` else `0`; also expose
  `progress_graded` and `progress_passed`.
- **Display only**: never used to change status.

Wired into:
- `taskDetail` output (each task row and detail); executions section shows per-execution
  pass/fail counts (already present for the checklist-executions list) plus progress bar.
- TASK/ASSET/LINE dossiers and the export column (§4.1).
- UI: small progress bar chip on Tasks rows and in Crews "assigned work" lists.

## 5. Files touched

- `backend/auth.js` — add `task:bulk` to `OPERATIONS_WORKFLOW` and `PLANNER`.
- `backend/routes/tasks.js` — `GET /tasks/export.csv`, `POST /tasks/bulk`, `GET /tasks/kpi`,
  `taskProgress`, serializer additions.
- `backend/routes/performance.js` (new, mounted in `server.js`) — `GET /performance`.
- `backend/routes/reports.js` — dossier summaries include progress fields.
- Frontend: `Tasks.jsx` (export button, checkboxes + bulk bar, KPI chips, progress bars),
  `Home.jsx` (KPI cards), `Reports.jsx` (Performance block), `TaskDetail.jsx` & dossier
  components (progress display), roles/permission mirror file.

## 6. Error handling & verification

- CSV and bulk reject invalid action/values with 400 + message.
- Bulk rejects if any id is invisible (403), missing (404), or the action value fails validation.
- Verification: restart backend, run API e2e as manager (`mgr.c1.tlom`): export honours
  filters (compare row count to `GET /tasks`), bulk `assign` + `priority` applied + audit row
  written, crew-lead bulk attempt → 403, KPIs match hand-counted rows, performance rows render.
  `node -c` all touched backend files, `npm run build` clean. Frontend buttons gated per role
  login set from the RBAC plan.

## 7. Out of scope

Status changes driven by progress (the reference's Scheduled→In Progress→Awaiting Completion
logic) — TMMS's explicit workflow is correct and must not be bypassed. JSON export, per-task
`duration`/`cost`, API tokens.
