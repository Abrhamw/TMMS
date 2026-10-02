# Line-Inspection Sectioning and Report Layer Options — Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`.

**Goal:** Let a long line inspection be split across crews by tower range, derive inspected/remaining coverage from completed section tasks, and add report-map layer toggles (route, inspected spans, crew trace, tower status) including section tower colouring.

**Architecture:** Additive task columns (`tower_from_id`, `tower_to_id`); coverage stays a pure derivation in `inspectionTrace.js` so no new source of truth exists. Report layers are a client-side filter over the document already returned by the API. Web/backend only.

**Tech Stack:** Node >=22 (`node:sqlite`), Express 5, React (Vite) SPA, Leaflet. No test framework; verify via `node --check`, `node -e`, live curl, and `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-02-line-inspection-sectioning-and-report-layers-design.md`

## Global Constraints

- Schema changes are additive via `migrate()` in `backend/db.js`; never rewrite/delete data.
- `backend/inspectionTrace.js` stays pure (no DB, no Express).
- `updateRow` drops `null` values: clearing `tower_from_id`/`tower_to_id` requires an explicit `UPDATE ... SET col = NULL` (mirror the existing `crew_id` clear).
- No mobile changes. No code comments (repo convention).
- Keep report payloads bounded: section task documents ship only the section's towers, not all 700.
- Every mutating route keeps `audit()`.
- Verified end state: a completed section task flips exactly its tower range to inspected and adds the covered km span; report toggles hide layers on screen and in print.

## File Structure

- `backend/db.js` — add `task.tower_from_id`, `task.tower_to_id` migrations.
- `backend/inspectionTrace.js` — section-aware `coverage()`.
- `backend/lineInspection.js` — select the new task columns.
- `backend/target.js` — resolve `tower_from`/`tower_to`; headline `Towers A–B`.
- `backend/routes/tasks.js` — writable fields, section validation, normalisation, null clears.
- `backend/routes/reports.js` — TASK_DETAIL target row + section towers in the document.
- `frontend/src/pages/Tasks.jsx` — from/to tower selects.
- `frontend/src/components/DocumentGeo.jsx` — `layers` filter + section towers on task maps.
- `frontend/src/components/DocumentReport.jsx` — layer checkboxes.

## Task 1: Schema

- Modify: `backend/db.js` (inside the same migration block as the other `migrate()` lines, after line 855).

- [ ] Step 1: Add:
  - `migrate('task', 'tower_from_id', 'ALTER TABLE task ADD COLUMN tower_from_id INTEGER REFERENCES tower(id)');`
  - `migrate('task', 'tower_to_id', 'ALTER TABLE task ADD COLUMN tower_to_id INTEGER REFERENCES tower(id)');`
- [ ] Step 2: `node --check backend/db.js`; boot once to apply: `node -e "require('./backend/db')"` (or restart server) and confirm via `PRAGMA table_info(task)` that both columns exist.

## Task 2: Section coverage

- Modify: `backend/inspectionTrace.js`, `backend/lineInspection.js`.

- [ ] Step 1: In `coverage()`, after the `inspected` set is built from `lineComplete`/`completedTowers` and before `out.inspected_tower_ids` is set, add an index map and mark section ranges:
  ```js
  const index = new Map(ordered.map((tw, i) => [Number(tw.id), i]));
  for (const s of list) {
    if (s.status !== 'COMPLETED' || s.tower_from_id == null || s.tower_to_id == null) continue;
    const a = index.get(Number(s.tower_from_id));
    const b = index.get(Number(s.tower_to_id));
    if (a == null || b == null) continue;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) inspected.add(ordered[i].id);
  }
  ```
- [ ] Step 2: In `backend/lineInspection.js` `lineCoverageFor()`, change the task `SELECT` to `SELECT id, status, tower_id, tower_from_id, tower_to_id FROM task WHERE ...`.
- [ ] Step 3: Verify with a pure `node -e` harness: fabricate `towers` at km 0,1,2,3,4 with ids 10..14, and a `COMPLETED` section task `{tower_from_id:11, tower_to_id:13}`; assert `inspected_tower_ids` is `[11,12,13]`, `covered_spans` is `[[1,3]]`, `inspected_km` 2, `tower_progress` 0.6. Also assert a `PENDING_VERIFICATION` section task marks nothing.
- [ ] Step 4: `node --check` both files.

## Task 3: Target resolution and headline

- Modify: `backend/target.js`.

- [ ] Step 1: In `resolveTarget()`, resolve:
  - `const towerFrom = task && task.tower_from_id ? get('tower', task.tower_from_id) : null;`
  - `const towerTo = task && task.tower_to_id ? get('tower', task.tower_to_id) : null;`
  and add `tower_from: towerFrom || null, tower_to: towerTo || null` to the returned object.
- [ ] Step 2: In `targetHeadline()`, after the `infra` bit is added, push a section label when both endpoints exist:
  - `const section = target && target.tower_from && target.tower_to ? `Towers ${target.tower_from.tower_id}–${target.tower_to.tower_id}` : null;`
  - `if (section && !bits.some((b) => b.includes(section))) bits.push(section);`
- [ ] Step 3: `node --check backend/target.js`; `node -e` a fake section task through `targetHeadline` and confirm the title ends with `Towers A–B`.

## Task 4: Task API — validation and null clears

- Modify: `backend/routes/tasks.js`.

- [ ] Step 1: Add `'tower_from_id', 'tower_to_id'` to `TASK_WRITABLE`.
- [ ] Step 2: Add a helper near `validateTargets`:
  ```js
  function sectionEndpoints(t) {
    const has = (v) => v !== undefined && v !== null && v !== '';
    const f = has(t.tower_from_id) ? Number(t.tower_from_id) : null;
    const g = has(t.tower_to_id) ? Number(t.tower_to_id) : null;
    return { f, g, any: f != null || g != null, both: f != null && g != null };
  }
  ```
- [ ] Step 3: In `validateTargets`, after the `tower_id` block, add:
  - if `endpoints.any && !endpoints.both` → 400 `Section requires both tower_from_id and tower_to_id`.
  - if `both`: both towers must exist; `f.line_id === g.line_id`; that line's region must equal `regionId`; if `t.line_id` set it must equal `f.line_id`; if `t.tower_id` set → 400 `A task cannot target both a single tower and a section`.
- [ ] Step 4: Add a normaliser applied to the fields being written:
  ```js
  function normalizeSection(fields) {
    const { f, g, both } = sectionEndpoints(fields);
    if (!both) return;
    const a = get('tower', f);
    const b = get('tower', g);
    if (!a || !b) return;
    const ka = Number(a.km_marker) || 0;
    const kb = Number(b.km_marker) || 0;
    const swap = kb < ka || (kb === ka && b.id < a.id);
    fields.tower_from_id = swap ? b.id : a.id;
    fields.tower_to_id = swap ? a.id : b.id;
  }
  ```
- [ ] Step 5: In `POST /tasks` and `PUT /tasks/:id`, after `validateTargets(...)` passes and before `insertRow`/`updateRow`, call `normalizeSection(fields)`. For PUT, build the validation view as today (`{...t, ...fields}`) so a partial update that sets only `tower_from_id` still validates against the stored `tower_to_id`; after normalisation the PUT `fields` must carry both columns when a section is set.
- [ ] Step 6: In the PUT clear list, extend `const clears = ['crew_id']...` to also clear section columns: include `'tower_from_id'`/`'tower_to_id'` when `fields[k] === null`. When the caller sets `tower_id` non-null, clear both section columns; when the caller sets a section, clear `tower_id`.
- [ ] Step 7: Confirm `pickTaskFields` passes `tower_from_id`/`tower_to_id`; a section POST with `tower_id` also set is rejected.
- [ ] Step 8: `node --check backend/routes/tasks.js`. Live curl (admin token):
  - create a section task `{task_type:'INSPECTION', line_id, tower_from_id, tower_to_id}` → 201 with normalised order;
  - reversed pair → 201 but stored with the lower km as `tower_from_id`;
  - only one endpoint → 400; mismatched line → 400; section plus `tower_id` → 400.

## Task 5: Report — target row and section towers

- Modify: `backend/routes/reports.js` (`TASK_DETAIL`, around lines 557-648).

- [ ] Step 1: Build a section label for the target row. When `resolved.tower_from` and `resolved.tower_to` exist, append ` · Towers A–B` to the line target string.
- [ ] Step 2: Include section towers in the document so the map can colour them:
  - when the task is a section, select the line's towers `ORDER BY km_marker, id`, find the from/to indices, and slice the inclusive range; put that slice on `document.towers` (cap is handled by the renderer).
  - keep `document.towers` absent for whole-line and single-tower tasks.
- [ ] Step 3: Add `section: resolved.tower_from && resolved.tower_to ? { from: resolved.tower_from, to: resolved.tower_to } : null` to the target block for downstream consumers.
- [ ] Step 4: `node --check backend/routes/reports.js`; live `POST /reports/TASK_DETAIL` for a section task → 201, document has `towers` only for the range and target includes the range.

## Task 6: Web form — section selects

- Modify: `frontend/src/pages/Tasks.jsx`.

- [ ] Step 1: Add `tower_from_id: null, tower_to_id: null` to `blank`.
- [ ] Step 2: Add `formLineTowers = useMemo(() => [...formTowers].sort((a,b) => (Number(a.km_marker)||0)-(Number(b.km_marker)||0) || a.id-b.id), [formTowers])`.
- [ ] Step 3: After the "Target tower" field, render "Section from tower" and "Section to tower" `SearchSelect`s fed by `formLineTowers` (option label `tower_id (tower_number)`). Choosing either sets the column and `line_id`, and clears `tower_id`. The existing "Target tower" handler clears both section columns when a tower is chosen.
- [ ] Step 4: Add a muted hint: leaving both blank inspects the whole line; choosing a single tower inspects one tower; choosing a from and to inspects that inclusive range.
- [ ] Step 5: `npm run build` (in `frontend`) passes.

## Task 7: DocumentGeo — layer filter and section towers

- Modify: `frontend/src/components/DocumentGeo.jsx`.

- [ ] Step 1: Default layers and a merge helper:
  ```js
  const DEFAULT_LAYERS = { route: true, covered: true, trace: true, towers: true };
  ```
  `build(document, layers)` merges `{ ...DEFAULT_LAYERS, ...(layers || {}) }` and passes it down.
- [ ] Step 2: Gate `addLine`/`addSub` calls in `buildAsset`/`buildLine`/`buildTask` on `L.route`.
- [ ] Step 3: `addInspection(out, insp, L)` draws covered spans only when `L.covered`, the trace only when `L.trace`; still set `out.inspection = insp` so progress still describes the map.
- [ ] Step 4: Gate tower drawing on `L.towers`: in `buildLine` skip the tower loop when off; in `buildTask` draw `d.towers` (when present) with the inspected set only when `L.towers`. The primary target tower/asset marker is always drawn.
- [ ] Step 5: In `buildTask`, when `d.towers` is present, draw each with `inspected` from the `inspection` set (same colours as `buildLine`).
- [ ] Step 6: Accept `layers` in the exported `DocumentGeo({ document, title, showTitle, layers })` and pass to `build`.
- [ ] Step 7: `npm run build` passes; existing callers (`Document.jsx`, `TargetProfile.jsx`) stay valid because `layers` is optional.

## Task 8: DocumentReport — layer checkboxes

- Modify: `frontend/src/components/DocumentReport.jsx` (map card around lines 34-39).

- [ ] Step 1: Add `const [layers, setLayers] = useState({ route: true, covered: true, trace: true, towers: true });` near the top of `DocumentReport` (the component already imports `useState`).
- [ ] Step 2: In the Location map card, render four labelled checkboxes with the class `no-print`: Route, Inspected spans, Crew trace, Tower status. Each toggles its key in `layers`.
- [ ] Step 3: Pass `layers={layers}` to `DocumentGeo`.
- [ ] Step 4: Show the controls only for `TASK`/`LINE` documents (the entities that carry an inspection block); keep the map for `ASSET` with no controls.
- [ ] Step 5: `npm run build` passes; in the running app, toggling each off removes only that layer and the controls do not print.

## Task 9: End-to-end verification and commit

- [ ] Step 1: Backend live: create two section tasks on one long line (e.g. 61) with different crews and adjacent ranges; verify the list shows both. Complete one via `POST /tasks/:id/state` (verify); `GET /lines/:id/inspection-progress` shows exactly that range inspected and the covered span/km, the other range still remaining.
- [ ] Step 2: Generate `TASK_DETAIL` for the completed section task and confirm the map payload carries only the section towers plus the line-wide inspection block.
- [ ] Step 3: Frontend `npm run build`; exercise the report toggles on the running dev server.
- [ ] Step 4: `node --check` every touched backend file.
- [ ] Step 5: Stage explicit paths and commit (do not stage the db/uploads/design artifacts), e.g. `git add backend/db.js backend/inspectionTrace.js backend/lineInspection.js backend/target.js backend/routes/tasks.js backend/routes/reports.js frontend/src/pages/Tasks.jsx frontend/src/components/DocumentGeo.jsx frontend/src/components/DocumentReport.jsx`; push.

## Self-Review Notes

- Spec coverage: schema (Task 1), coverage (Task 2), API validation/normalisation (Tasks 3-4), form (Task 6), report towers + layers (Tasks 5, 7, 8), verification (Task 9).
- Preserved behaviour: single-tower and whole-line coverage, `emptyCoverage` shape, `/lines/:id/inspection-progress` and `/tasks/:id/trace` shapes, LINE report full tower colouring, ASSET report map unchanged.
- Deferred (spec non-goals): auto-split, persisted coverage table, scheduler sections, mobile, overlap blocking.
