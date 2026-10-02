# Line-Inspection Sectioning and Report Layers — Design

Status: approved (brainstorming complete)
Date: 2026-10-02
Sub-project: F (extends the line-inspection route-tracing work)

## 1. Summary

Two connected capabilities for long line inspections:

1. **Sectioning** — one line-inspection task can be split across crews by tower
   range. A section task targets a start tower and an end tower (inclusive) on
   the same line; completing it marks every tower in that range inspected.
2. **Report layer options** — the generated report's location map gains
   checkbox controls to include or exclude the inspection path (crew trace),
   inspected spans, tower status colouring, and route, and section towers are
   drawn with inspected/remaining colouring on task reports.

The feature is web/backend only this round. The mobile field app is out of
scope.

## 2. Background

- `backend/inspectionTrace.js` holds the pure coverage maths. `coverage()`
  takes the line's towers (`id`, `km_marker`) and the line's tasks
  (`id`, `status`, `tower_id`) and decides which towers are inspected. A line
  is complete when a `COMPLETED` task has `tower_id == null`; otherwise each
  `COMPLETED` task with a `tower_id` marks that one tower. Covered km spans are
  merged runs of consecutive inspected towers.
- `backend/lineInspection.js` `lineCoverageFor()` selects the towers and tasks
  for a line and calls `coverage()`. `lineCoverageFor()` currently selects only
  `id, status, tower_id` from `task`.
- `backend/routes/reports.js` `TASK_DETAIL` builds the report document and calls
  `inspectionForLine(line.id, route)` for any line-targeted task, giving the
  map its `inspection` block (inspected tower ids, covered spans, trace points).
- `frontend/src/components/DocumentGeo.jsx` renders the report map. `buildLine()`
  draws all line towers coloured teal (inspected) / gray (remaining) using the
  `inspection` block; `buildTask()` draws only the single target tower, so a
  line/line-section task report does not currently show inspected/remaining
  towers. `addInspection()` draws the green inspected spans and the orange crew
  trace unconditionally.
- `frontend/src/components/DocumentReport.jsx` renders the report and embeds
  `DocumentGeo` in the "Location map" card.
- The `task` table has a single `tower_id` and no start/end tower columns.

## 3. Goals / Non-goals

Goals:

- Add a `tower_from_id` / `tower_to_id` range to a task so a line inspection can
  be split across crews.
- Derive section coverage from completed section tasks, keeping coverage
  idempotent and free of a second source of truth.
- Draw inspected vs remaining towers on section task reports.
- Let readers include/exclude inspection-path layers on the generated report
  map, both on screen and in print.

Non-goals (YAGNI):

- Automatic section splitting (the operator creates each section task
  manually).
- A persisted/materialised coverage table.
- A scheduler change: the recurring schedule engine still generates
  whole-line/single-tower tasks.
- Any mobile field-app change.
- Blocking overlapping sections (coverage is a set; overlaps are harmless) or
  editing/deleting stored traces.
- Changing `checklist_execution` or GPS semantics.

## 4. Data model

Add two nullable columns to `task` through the existing `migrate()` pattern in
`backend/db.js`:

- `tower_from_id INTEGER REFERENCES tower(id)`
- `tower_to_id INTEGER REFERENCES tower(id)`

Semantics:

- A task with **both** set is a **line-section inspection**. `line_id` is
  required and `tower_id` is null. The range is inclusive and ordered by
  `km_marker, id`.
- A task with `line_id` and no tower columns is a **whole-line** inspection
  (unchanged).
- A task with `tower_id` is a **single-tower** task (unchanged).
- One of the two range columns alone is invalid; the API rejects it.

## 5. Coverage

In `backend/inspectionTrace.js` `coverage()`:

- A `COMPLETED` task with `tower_from_id` and `tower_to_id` inspects every tower
  whose ordered index lies between the from-index and the to-index (inclusive).
- Build an index map from the ordered tower list; resolve the two endpoints;
  mark the inclusive slice.
- Existing merge logic then turns consecutive inspected towers into covered km
  spans, so section completions produce green spans with no extra code.
- `lineComplete` (whole-line task) and single-tower completion are unchanged.

`backend/lineInspection.js` `lineCoverageFor()` adds `tower_from_id,
tower_to_id` to the task `SELECT`.

`emptyCoverage()` is unchanged; the map shape stays the same, so no consumer
changes.

## 6. Task API

`backend/routes/tasks.js`:

- Add `tower_from_id` and `tower_to_id` to `TASK_WRITABLE`.
- `validateTargets` gains a section branch:
  - reject when exactly one of the two is set;
  - both towers must exist, share a `line_id`, and that line must match
    `line_id` and the task region (reusing the existing region rules);
  - when both are set, `tower_id` must be null;
  - normalise the pair so `tower_from_id` is the lower `km_marker` (ties broken
    by `id`), so a reversed selection is stored correctly.
- `resolveTarget` (`backend/target.js`) resolves `tower_from` and `tower_to`
  and exposes them on the target.
- `targetHeadline` appends `Towers A–B` for a section so report titles read
  `... — Line X — Towers A–B`.

`backend/routes/reports.js` `TASK_DETAIL`:

- The Target row shows the tower range when the task is a section.
- The document includes `towers` limited to the section (from-index to
  to-index) so the report map can colour them. A whole-line task keeps its
  current document (no tower list) to avoid shipping hundreds of tower rows;
  the LINE report remains the full-line view.
- The `inspection` block is unchanged (line-wide), so progress percentages stay
  consistent across task and line reports.

The `GET /lines/:id/inspection-progress` and `GET /tasks/:id/trace` shapes are
unchanged.

## 7. Web form

`frontend/src/pages/Tasks.jsx`:

- Add `tower_from_id: null, tower_to_id: null` to `blank`.
- When a line is selected, show "Section from tower" and "Section to tower"
  selects listing that line's towers ordered by `km_marker, id`.
- Selecting a section clears `tower_id`; selecting a single tower clears the
  section. The form submits `tower_from_id`/`tower_to_id` only when both are
  chosen.
- A short hint states that leaving both blank inspects the whole line, and
  choosing a single tower inspects one tower.

No change to the task list or filters.

## 8. Report layers

`frontend/src/components/DocumentGeo.jsx`:

- Accept a `layers` prop `{ route: true, covered: true, trace: true, towers:
  true }` (all default true).
- `addLine` / `addSub` are drawn when `route` is on.
- `addInspection` draws covered spans only when `covered` is on and the trace
  only when `trace` is on.
- When `towers` is off, the inspected/remaining tower layer is omitted (for a
  line report this is every tower marker; for a section task report it is the
  section tower list). The primary work-target marker (the single target tower
  or asset) is always drawn, since it identifies the work rather than the
  status overlay.
- `buildTask()` draws `d.towers` (when present) using the inspected set so a
  section task report shows inspected teal and remaining gray.

`frontend/src/components/DocumentReport.jsx`:

- The "Location map" card gains four checkboxes: **Route**, **Inspected
  spans**, **Crew trace**, **Tower status**. Default all on.
- The controls carry `no-print` so they never appear in a printed report.
- Toggle state is component state; no persistence and no API parameter.

## 9. Verification

- Backend: `node --check` on every touched file.
- Backend live: create a section task via `POST /tasks`; confirm validation
  (missing half, mismatched line, reversed pair normalisation); complete it via
  `POST /tasks/:id/state` (verify) and confirm
  `GET /lines/:id/inspection-progress` flips the range's towers to inspected and
  adds the covered span and km.
- Frontend: `npm run build`; confirm the report map renders with each layer
  toggled off (no covered span, no trace, plain/omitted towers) using the
  existing SSR harness or the running dev server.
- Confirm the report toggles do not appear in print output.

## 10. Risks

- **Large line reports**: 700-tower lines must not ship every tower in a task
  document; the section-only tower list and the `addTower` cap of 400 keep the
  TASK payload bounded. The LINE report already caps drawn towers at 400.
- **Section/task mode ambiguity**: `tower_id` plus a range is rejected, and the
  form clears one when the other is chosen, so a task can never be in two modes.
- **Overlaps**: two crews may own overlapping ranges; coverage is a set, so the
  result is still correct (towers are simply inspected). A non-blocking warning
  may be added later.

## 11. Rollout

Additive columns and an additive coverage rule; existing tasks and reports are
unaffected. No mobile release is required this round.
