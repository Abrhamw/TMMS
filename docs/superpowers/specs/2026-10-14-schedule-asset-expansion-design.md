# Schedule Asset Expansion Design

Date: 2026-10-14.

## 1. Problem

Maintenance schedules generate tasks against their scope, but only some scopes
resolve to infrastructure that exists in the asset register. Register assets are
the only rows that carry a valuation price (`cost wise`) and a `condition_rating`
(`conditionally evaluated`), and they are the only rows that completion can
record cost and condition against.

In `backend/routes/schedules.js`, `expandTargets` (`:59`) resolves:

- `ASSET` / `ASSET_CLASS` -> register assets (costable, condition-rated).
- `TOWER` / `LINE_TOWERS` -> `tower` rows (completion now maps them to their
  `TWR-*` register mirror after `fd3cb32`).
- `SUBSTATION` -> one `substation` row (not a register asset).
- `LINE` -> one `transmission_line` row (not a register asset).
- `REGION` -> the region's `substation` rows (not register assets).

A `substation` or `transmission_line` row is not in the asset register, so a task
generated from a `SUBSTATION`/`LINE`/`REGION` schedule can never be costed or
condition-evaluated: cost entries have no asset to attach to and valuation that
scales by `condition_rating / 10` never sees the work. This is the same class of
gap that hid completed tower work from the Value & Cost reports.

In the dev database 155 of 169 substations have no registered equipment and lines
have only their tower mirrors, so coarse scopes are largely unrepresentable in
cost/condition reporting.

## 2. Goals

1. Coarse scopes (`SUBSTATION`, `LINE`, `REGION`) generate one task per register
   asset under the scope, so every generated task is costable and
   condition-evaluable.
2. Keep large expansions manageable with an optional per-occurrence batch cap and
   carry-over, where one occurrence is one full sweep across all targets.
3. Never lose work silently: a scope that resolves to zero register assets is
   surfaced as zero, not generated as an uncostable placeholder.
4. Preserve existing schedule semantics and recurrence for the scopes that
   already resolve to register assets.

## 3. Non-goals

- No register mirror assets for substations or lines (rejected in favour of
  expanding to existing assets).
- No change to the recurrence maths (`backend/recurrence.js`).
- No change to task statuses or the transition graph.
- No change to the Value & Cost page logic itself; it already consumes
  `asset_maintenance_event`.
- No mobile change; mobile only reads task detail.
- No scheduling of `DECOMMISSIONED` assets.

## 4. Design

### 4.1 Target resolution (expansion)

`expandTargets(s)` returns register assets filtered to
`lifecycle_status IN ('IN_SERVICE','UNDER_MAINTENANCE')`, matching the rule
`ASSET_CLASS` already uses:

- `ASSET` -> the named asset (unchanged).
- `ASSET_CLASS` -> assets of `asset_type` (unchanged).
- `TOWER` -> the tower row (unchanged).
- `LINE_TOWERS` -> towers on the line (unchanged).
- `LINE` -> all assets with `line_id = s.line_id` (tower mirrors, joint boxes,
  conductor/OPGW spans).
- `SUBSTATION` -> all assets with `substation_id = s.substation_id`.
- `REGION` -> all assets whose parent (substation/line/tower) resolves to
  `s.region_id`.

For `LINE`/`SUBSTATION`/`REGION` the expanded targets are register assets, so
each generated task carries `asset_id` (the existing `isAsset` path) and
completion records cost + condition against that asset. Tower mirrors (`TWR-*`)
are included as ordinary assets for `LINE`/`REGION`.

Trade-off accepted: under `LINE`, towers become asset-anchored tasks (via
`TWR-*`) rather than tower-anchored, which is uniform and simpler than a mixed
target shape. `TOWER`/`LINE_TOWERS` remain tower-anchored.

### 4.2 Occurrence coverage and batch cap

New schema:

- `maintenance_schedule.batch_size INTEGER` (nullable; NULL/0 = no cap).
- `task.schedule_occurrence INTEGER` (nullable).

A **sweep** is one occurrence covering every target. Each target has a key:
`t:<tower_id>` for tower targets, `a:<asset_id>` for asset targets. Generation
for a due schedule:

1. `occurrence = s.occurrences_generated`.
2. `targets = expandTargets(s)`.
3. `covered` = keys of tasks for `(schedule_id = s.id, schedule_occurrence =
   occurrence)`; for compatibility a task with `schedule_occurrence IS NULL`
   counts as covered when `occurrence = 0`.
4. `remaining = targets - covered`.
5. If `remaining` is empty -> sweep complete -> `skipped_duplicate`.
6. Backlog guard: if `remaining` equals all `targets` (a fresh sweep) and the
   schedule has open tasks from a prior occurrence, skip and wait.
7. Otherwise generate `min(|remaining|, batch_size || infinity)` tasks, each
   stamped `schedule_occurrence = occurrence`. `batch_size` caps the number of
   tasks created per run (per invocation) for the schedule, not per occurrence.
8. If `remaining` is now empty -> advance the recurrence
   (`recurrence.advanceAfterGeneration`: bump `occurrences_generated`, roll
   `next_due_date`). Otherwise leave `next_due_date`/`occurrences_generated`
   untouched so the next run resumes the same sweep.

This replaces the current all-or-nothing `existing > 0` skip, which would block
carry-over. Generation is idempotent: re-running mid-sweep only creates tasks for
still-uncovered targets.

### 4.3 Zero-target surfacing

When a scope resolves to zero register assets, generation creates nothing and
the schedule reports a `NO_TARGETS` state. The planner sees this in the list,
detail and preview so they can register assets or choose another scope. A
`SUBSTATION` schedule stays empty until its equipment is registered; this is
explicit rather than silent.

### 4.4 API and schema

- `migrate('maintenance_schedule','batch_size', 'ALTER TABLE maintenance_schedule
  ADD COLUMN batch_size INTEGER')`.
- `migrate('task','schedule_occurrence', 'ALTER TABLE task ADD COLUMN
  schedule_occurrence INTEGER')`.
- `POST`/`PUT /schedules` accept `batch_size` (integer >= 0; 0/NULL = no cap).
- `GET /schedules` stops materialising targets: compute `target_count` with a
  `COUNT` query so a `REGION` schedule does not load thousands of rows per list
  render.
- Schedule detail and `GET /schedules/:id/preview` keep the target list but cap
  the returned sample (first 200) plus true `target_count`, and add `remaining`
  (uncovered targets for the current occurrence) and `batch_size`.
- Extend the existing `due_state` value set (currently `ENDED`, `OVERDUE`,
  `GENERATING`, `SCHEDULED`) with `NO_TARGETS` (zero register assets) and
  `SWEEP_IN_PROGRESS` (targets remain for the current occurrence). `NO_TARGETS`
  takes precedence over the date-derived states.

### 4.5 Frontend

`frontend/src/pages/Schedules.jsx`:

- Add a **Batch size** field (placeholder `50`, blank = no cap).
- Add `REGION` to the scope dropdown (currently backend-only) so the behaviour is
  usable end to end.
- Update scope help text: `LINE`/`SUBSTATION`/`REGION` generate one task per
  register asset.
- Show expanded `target_count`, a "No registrable assets" warning when zero, and
  sweep progress (`remaining`).
- New i18n keys in `frontend/src/i18n/en.js` (and the other locale files fall
  back to English).

## 5. Testing

New `backend/test/schedules.test.js` with fixtures (region -> substation, line,
towers plus their `TWR-*` mirrors, a joint box, a transformer):

- Expansion per scope; lifecycle filter excludes `DECOMMISSIONED`.
- Zero targets -> no task, state `NO_TARGETS`.
- Coverage/idempotency: two runs for one occurrence generate each target once.
- Batch cap: `batch_size = N` generates N, holds the occurrence, leaves
  `remaining`; the next run resumes; the run covering the last target advances
  the recurrence.
- Backlog guard: an open task from a prior occurrence blocks a fresh sweep.
- Cost/condition tie-in: completing a generated asset task writes an
  `asset_maintenance_event` and updates `last_maintenance_at`.

Frontend: `Schedules.jsx` builds; any extracted pure helper gets a unit test.
Verification: `cd backend && npm test` and `cd frontend && npm run build && npm
test`.

## 6. Rollout

Schema is additive through `migrate()`. Existing schedules are unaffected until
their next run, when coarse scopes expand. The completed-tower-work reporting fix
(`fd3cb32`) already shipped and remains the tower-anchored path.
