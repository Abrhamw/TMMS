# RBAC Re-alignment, Field Role Split, Findings/Pictures, Detailed Reports & Asset Register

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline in this repo). Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Re-align the TMMS permission model to utility best practice (admin-only master data, director/manager operational workflow incl. scheduling & generation, crew-lead vs crew-member field duties), add ad-hoc checklist findings + field picture upload/gallery, produce detailed task/line/asset reports that capture exactly who did what with violations, and enrich asset registration with an evaluation section and category counts.

**Architecture:** Single Express + React app. RBAC lives in one matrix mirrored in `backend/auth.js` and `frontend/src/auth.js`. Role assignment is derived from `crew_member` membership (leader vs member). Findings/photos are append-only rows linked to a task/execution. Reports are computed server-side and rendered by a per-entity document viewer. All master-data writes stay ADMIN-only; every mutating action keeps `audit()`.

**Tech Stack:** Node >=22 (node:sqlite), Express 5, React (Vite) SPA, Leaflet. No ORM; no test framework (verify via API scripts in this repo).

## Global Constraints

- Master-data writes (region/substation/line/tower/asset/checklist/user/org-unit) are `ADMIN`-only. Never grant these to director/manager/crew roles.
- Backend and frontend permission matrices must stay byte-identical in shape (`ROLE_PERMS`, `READ_PERMS`, `GLOBAL_ROLES`).
- Field-crew logins are scoped to their own crew + region; crews can only touch their own assigned tasks.
- No deletion of user data; test artifacts are cleaned by exact ids we created.
- Existing data is preserved: schema changes via `migrate()`/`CREATE TABLE IF NOT EXISTS`; role re-seeding idempotent.
- Checklist master templates remain ADMIN-editable only; crew lead "amend" means append-only ad-hoc findings on the execution, never editing master templates.
- Verification does NOT enforce 4-eyes (user decision): a director/manager who created/assigned a task may verify it.
- Out-of-range GPS already flows to the verifier for review (previous change) — must keep working.
- Frontend `can(user, perm)` mirrors backend; UI buttons must be hidden when the backend would 403.

## Target Permission Matrix (per role → extra beyond READ_PERMS)

- ADMIN: `*`.
- EXECUTIVE: TASK_WORKFLOW + `schedule:write`, `schedule:run`, `report:write`, `audit:read` (unchanged + scheduling).
- REGION_DIRECTOR / REGION_MANAGER / SUBSTATION_MANAGER / TRANSMISSION_MANAGER / RELAY_SCADA_MANAGER / SUPERVISOR: TASK_WORKFLOW + `schedule:write` + `schedule:run` + `report:write`.
- PLANNER: READ + `task:create`, `task:manage`, `schedule:write`, `schedule:run`.
- DISPATCHER: READ + `task:create`, `task:assign`.
- VIEWER/AUDITOR: as today.
- CREW_LEAD (new): READ subset + `task:execute`, `task:start`, `task:lead`, `task:amend`, `gps:write`, `attachment:write`.
- CREW_MEMBER (new): READ subset + `task:execute`, `gps:write`, `attachment:write`.
- FIELD_CREW kept for backward compat mapping to CREW_LEAD perms.
- TASK_WORKFLOW = `task:create`,`task:assign`,`task:verify`,`task:manage` (unchanged).
- New perms: `task:start` (lead only), `task:lead` (start/hold/resume/submit/reopen-by-crew), `task:amend` (ad-hoc findings), `attachment:write`, `schedule:write`, `schedule:run`.
- Roles are read from `user.role`. Field access decision helper: treat roles in {FIELD_CREW, CREW_LEAD, CREW_MEMBER} as crew users.

## File Structure

- `backend/auth.js` — ROLE_PERMS, READ_PERMS, GLOBAL_ROLES, `isCrewUser`, export `roleGrant(name)` helper for migrations.
- `frontend/src/auth.js` — mirror matrix.
- `backend/db.js` — new tables `task_finding`, `attachment`; migrations: `checklist_execution.crew_id`, `asset.health_index`, `asset.remaining_useful_life_years`, `asset.evaluation_notes`.
- `backend/seed_eep.js` or new `backend/rolesMigrate.js` invoked from `server.js` — idempotent role re-derivation + crew user provisioning.
- `backend/routes/tasks.js` — per-role gates; record author (`executed_by` person, crew) on checklist submit; `POST /tasks/:id/findings` (lead).
- `backend/routes/attachments.js` (new) + `server.js` static `/uploads` — photo upload/gallery.
- `backend/routes/reports.js` + `backend/seed.js` (`ensureReportTemplates`) — TASK_DETAIL, LINE_DETAIL cases; extend ASSET_DETAIL document.
- `backend/routes/assets.js` — evaluation PATCH endpoint + register summary counts.
- `backend/routes/schedules.js` — unchanged logic; permission comes from matrix.
- `frontend/src/pages/TaskDetail.jsx` — role-aware workflow, findings composer (lead), photo upload (member/lead), per-execution gallery, "Generate task report".
- `frontend/src/pages/Lines.jsx` — related-tasks section + "Generate line report".
- `frontend/src/pages/Tasks.jsx` — target filters (line/tower/asset/substation) and crew filter.
- `frontend/src/pages/Assets.jsx` — evaluation panel + per-category counts summary + document.
- `frontend/src/pages/Reports.jsx` — render `data.document` for TASK/LINE (and reuse for ASSET/CREW) so reports are viewable from Reports page.

## Task 1: Backend permission matrix + crew-user helpers

- Modify: `backend/auth.js` (ROLE_PERMS, READ_PERMS, GLOBAL_ROLES, new `isCrewUser(user)`, `CREW_ROLES` set), `backend/seed.js`/`seed_eep.js` unchanged yet.
- Add roleGrant table of per-role perms; keep `hasPerm` logic.

- [x] Step 1: Implement matrix in `auth.js` (exact arrays above). Export `isCrewUser`, `CREW_ROLES`.
- [x] Step 2: Verify with a node -e script that e.g. `TRANSMISSION_MANAGER` has `schedule:run` but not `asset:write`; `CREW_MEMBER` lacks `task:submit`; `ADMIN` has everything. Use `hasPerm({role}, perm)`.
- [x] Step 3: `node -c backend/auth.js`.

## Task 2: Frontend mirror

- Modify: `frontend/src/auth.js`.

- [x] Step 1: Mirror ROLE_PERMS exactly (same per-role arrays incl. CREW_LEAD/CREW_MEMBER/FIELD_CREW).
- [x] Step 2: `npm run build` passes.

## Task 3: Schema additions (db.js)

- Modify: `backend/db.js` (after the last `migrate()` line, inside same function).

- [x] Step 1: Add:
  - `CREATE TABLE IF NOT EXISTS task_finding (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES task(id), execution_id INTEGER REFERENCES checklist_execution(id), crew_id INTEGER REFERENCES crew(id), created_by INTEGER REFERENCES person(id), title TEXT NOT NULL, detail TEXT, severity TEXT NOT NULL DEFAULT 'INFO', lat REAL, lng REAL, captured_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);`
  - `CREATE TABLE IF NOT EXISTS attachment (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER REFERENCES task(id), execution_id INTEGER REFERENCES checklist_execution(id), checklist_item_id INTEGER, created_by INTEGER REFERENCES person(id), kind TEXT NOT NULL DEFAULT 'PHOTO', file_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT, size_bytes INTEGER, lat REAL, lng REAL, accuracy_m REAL, captured_at TEXT NOT NULL, note TEXT);`
  - Migrations: `checklist_execution.crew_id`; `asset.health_index REAL`; `asset.remaining_useful_life_years REAL`; `asset.evaluation_notes TEXT`.
- [x] Step 2: Boot once via `node -e "require('./db').initSchema()"`; verify PRAGMA columns.

## Task 4: Idempotent role migration + crew users

- Create: `backend/rolesMigrate.js` exporting `migrateRolesAndCrewUsers()`.
- Modify: `backend/server.js` to call it after `ensureReportTemplates()`.

Rules (idempotent, applied on every boot):
1. Any `user.role='FIELD_CREW'` whose person is `crew_member.role='CREW_LEADER'` (or is a `crew.leader_person_id`) → `CREW_LEAD`; otherwise if active member → `CREW_MEMBER`; else keep `FIELD_CREW`.
2. For every active crew in the DB, ensure a user login exists for `crew.leader_person_id` with role `CREW_LEAD` (username `crew.<crew_code lower c1.>` + `.lead` unless exists) and for each `crew_member` with role != CREW_LEADER ensure a `CREW_MEMBER` user (username `crew.<code>.<memberid>`). Password defaults: lead `Crew@123`, member `Member@123`. Username collisions → skip (do not error).
3. Log a summary to console (`rolesMigrate: ...`).

- [x] Step 1: Write `rolesMigrate.js` (use `hashPassword` from auth.js; person email fallback).
- [x] Step 2: Wire into `server.js`.
- [x] Step 3: Restart backend, verify new users: `crew.c1.som.lead` etc. exist and `user.role` in {CREW_LEAD, CREW_MEMBER}; crew.c1 role is CREW_LEAD.
- [x] Step 4: Verify login as a CREW_MEMBER works; as CREW_LEAD works; and they carry `crew_id`.

## Task 5: Backend field-scoping + role gates on tasks.js

- Modify: `backend/routes/tasks.js`.

- [x] Step 1: Replace `isFieldCrew(user)` checks (taskVisible and the "not your assigned task" guards) with `isCrewUser(user)` (import from auth). Keep crew==user.crew scoping for all crew roles.
- [x] Step 2: ACTION_PERM changes: `start: 'task:start'`, `hold:'task:lead'`, `resume:'task:lead'`, `submit:'task:lead'`. Keep `task:execute` on checklist GET/POST. Reopen allowed for `task:verify` OR `task:lead`.
- [x] Step 3: In checklist POST, record author: `executed_by: req.user.person_id || t.crew_id`, plus new `crew_id: t.crew_id` column write; return author info (`executed_by_name` from person) — keep the stored schema clean (do not store crew_id into executed_by).
- [x] Step 4: Verify matrix: as CREW_MEMBER, `start`/`submit` → 403; checklist GET/POST on own task OK; as CREW_LEAD start+submit OK; manager schedule:write; member of other crew → 403.

## Task 6: Ad-hoc findings (crew lead) + attachments upload/gallery

- Create: `backend/routes/attachments.js` (router with `POST /attachments` base64 JSON, `GET /attachments?task_id=`, `DELETE /attachments/:id` admin/author-or-lead), wire in server.js, plus `express.static('/uploads')` serving `backend/uploads`.
- Modify: `backend/routes/tasks.js` — `POST /tasks/:id/findings` (perms: `task:amend` + crew-scoped; allowed statuses ASSIGNED/IN_PROGRESS/PENDING_VERIFICATION(rework)); insert into `task_finding`, audit, return row; `GET /tasks/:id` detail includes `findings` + `attachments`.

- [x] Step 1: Create uploads dir, route file, static mount, delete rule (only author or crew lead of task or admin; NEVER blanket).
- [x] Step 2: Add findings POST + detail includes. Attach gating consistent with Task 5.
- [x] Step 3: API test: member → POST findings 403; lead on own IN_PROGRESS task → 201; upload photo as member → 201; GET list shows both; cleanup by exact ids.

## Task 7: Reports TASK_DETAIL + LINE_DETAIL + richer ASSET_DETAIL

- Modify: `backend/routes/reports.js`, `backend/seed.js` `ensureReportTemplates`, `backend/db.js` seed list guard.

- [x] Step 1: `compute()` cases:
  - `TASK_DETAIL`: params `task_id`. Title `Task Document — <task_number>`. rows: task number/title/type/priority/status/source/created/scheduled dates/due/target (substation|line|tower|asset|none with name), region, crew (name + members), checklist template + requires_gps, assigned_by/verified_by person names, result, completion summary. document: `{entity:'TASK', task:taskDetailWithRels, executions:[checklistsWithItems with executed_by person + crew name], findings:[...], attachments:[...], gps:[...], violations:[fail/geofence rows], comments:[...]}`.
  - `LINE_DETAIL`: params `line_id`. Line identity + route summary + towers + assets + related tasks (line, its towers, its assets) + their executions + GPS validations. document entity 'LINE'.
  - `ASSET_DETAIL` extend: include `upcoming_tasks` (open tasks) separately from historical; add `evaluation` block (condition_rating, health_index, RUL, criticality, next_maintenance_at, evaluation_notes); include `violations` (GPS fail/geofence rows for the asset).
- [x] Step 2: `ensureReportTemplates()` idempotently seeds TASK_DETAIL/LINE_DETAIL templates if missing.
- [x] Step 3: API test generate TASK_DETAIL for existing task, LINE_DETAIL for line 1, ASSET_DETAIL for a tower asset → 201 and document payload present; cleanup generated report rows (exact ids).

## Task 8: Asset register — evaluation + counts

- Modify: `backend/routes/assets.js` (POST/PUT keep ADMIN-only via `asset:write`; add `PATCH /assets/:id/evaluate` ADMIN too, recompute health_index & RUL from condition_rating + criticality + last_maintenance), Assets page.

- [x] Step 1: Backend PATCH evaluate recompute: health_index = round(condition_rating/10*100); RUL = clamp heuristic (condition_rating 10→20y …1→1y); store evaluation_notes, condition_assessed_at=now, last/next maintenance untouched. Return asset.
- [x] Step 2: Frontend Assets page: header summary cards = total assets, per asset_type counts, per lifecycle_status, per operational_status; the add/edit modal gains an "Evaluation" section (condition_rating slider/number, criticality, health/RUL readonly after evaluate, evaluation_notes); detail modal gains Evaluation panel + Evaluate button; document uses existing Document (ASSET_DETAIL) refreshed with Task 7 fields.
- [x] Step 3: Manual UI + API verify (asset:write admin only; manager gets 403).

## Task 9: Line & tower task surfacing + Tasks filters + frontend role gating

- Modify: `backend/routes/core.js` `/lines/:id` add `tasks` (all tasks where line_id = id OR tower line OR asset line, with status), `/towers` list includes `related_tasks` count? (keep list light: add detail).
- Modify: `frontend/src/pages/Lines.jsx` (Related tasks table + "Generate line report" button when `report:write`), `Towers.jsx` detail (link tasks filtered), `Tasks.jsx` (filter selects for target line/tower/asset/substation + crew; reads from `?line_id=` etc.), and TaskDetail/Checklists/Crews/Schedules buttons gated by updated roles.

- [x] Step 1: backend `/lines/:id` returns `tasks`.
- [x] Step 2: Frontend wiring + filters. Build passes.
- [x] Step 3: Verify each role sees correct buttons by logins list from Task 4.

## Task 10: ReportView document rendering + Reports page linkage

- Modify: `frontend/src/pages/Reports.jsx` (`ReportView` handles `data.document` by entity TASK/LINE/ASSET/CREW via a shared renderer) and optionally refactor `components/Document.jsx` to reuse.

- [x] Step 1: Extract `DocumentBody` from Document.jsx to exported renderer OR inline equivalent tables into ReportView for TASK/LINE; ensure printable.
- [x] Step 2: Verify by generating TASK_DETAIL/LINE_DETAIL and viewing from Reports page and from Task/Lines pages.

## Self-Review Notes

- Spec sections covered: user's RBAC matrix, ad-hoc findings on execution (not master templates), real photo upload + per-execution gallery, task report (who/what/violations), asset report (history + future + GPS violations + evaluation), line scheduling visible tasks + line report, asset register evaluation + category counts, all regions/scoping retained.
- Previous behavior preserved: out-of-range GPS → verifier; soft-delete crew members; schedule task_type; checklist pass_criteria parse.
