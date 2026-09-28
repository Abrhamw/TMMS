# Crew Status Lifecycle Design

Date: 2026-09-10. Sub-project A of the six-part operations enhancement workstream
(crew status lifecycle; auto-counting substation bays + tower/asset standards; follow-up
auto-checklist; recurring schedule engine; line-inspection route tracing). This spec covers
only crew status.

## 1. Problem

A crew's `status` column (`backend/db.js:174`, default `'AVAILABLE'`) is a free-form field with
no UI control and no connection to the tasks the crew is actually working. Dispatchers cannot
tell, from the crew list or the dispatch eligibility check, whether a crew is idle, assigned,
or currently on a task; and `GET /crews/eligibility` (`backend/routes/crews.js:91`) only ever
returns crews whose stored status is literally `AVAILABLE`, so a crew that has an open task
disappears from dispatch candidate lists entirely. Status also never changes when tasks are
assigned, started, or completed.

## 2. Goals

1. Crew status is **derived automatically** from the crew's active tasks: `ON_TASK` while any
   task is being performed, `ASSIGNED` when only assigned/scheduled, `AVAILABLE` otherwise.
2. A crew stays `ON_TASK` through `PENDING_VERIFICATION` until verification completes (or the
   task is cancelled), so a crew awaiting sign-off is not offered as idle.
3. Manual override states `AVAILABLE`, `OFF_DUTY`, `UNAVAILABLE` can be set by users with
   `crew:write`. An override is **sticky** until cleared; a task event does not overwrite it.
4. Clearing the override (`Auto`) resumes derivation from tasks.
5. The crew list shows the effective status plus an active-task count tag; the crew detail shows
   the full task list and the status control; the dispatch eligibility check shows status and
   active count for all crews and marks non-selectable crews.

## 3. Non-goals

- No status history / transition timeline.
- No per-member status (status is crew-level only).
- No automatic revert timer (an override stays until a user clears it).
- No new task statuses; derivation reads the existing status set.
- No status-based restrictions on task state transitions (a released crew can still be assigned
  new work even while a prior task awaits verification).

## 4. Data Model

### 4.1 New column `crew.status_override`

Added via the existing inline migration helper in `backend/db.js` (alongside the `migrate(...)`
calls near `db.js:515`):

```js
migrate('crew', 'status_override', 'ALTER TABLE crew ADD COLUMN status_override TEXT');
```

- `NULL` (or absent) means **Auto** — status is derived from tasks.
- Non-null means a manual override. Allowed values: `AVAILABLE`, `OFF_DUTY`, `UNAVAILABLE`.
- The existing `crew.status` column is retained and becomes a **persisted cache** of the
  effective status, written by the sync helper below, so any code reading `crew.status` raw
  stays correct. `crew.status_override` is the source of truth for manual intent.

### 4.2 Effective status values

`AVAILABLE`, `ASSIGNED`, `ON_TASK`, `OFF_DUTY`, `UNAVAILABLE`.

## 5. Backend

### 5.1 Derivation helper (`backend/crewStatus.js`)

A new module `backend/crewStatus.js` exports `deriveCrewStatus(crewId)` and
`syncCrewStatus(crewId)`. It is imported by both `backend/routes/crews.js` and
`backend/routes/tasks.js`. Placing it in its own module avoids a route-to-route import (which can
be circular), and keeps the derivation logic in one testable unit that depends only on `db`.

- `deriveCrewStatus(crewId, useOverride = true)` — returns a status without writing. When
  `useOverride` is true:
  1. Load the crew; if `status_override` is set, return it.
  2. Query active tasks: `SELECT status FROM task WHERE crew_id = ? AND status NOT IN
     ('COMPLETED','CANCELLED','FAILED')`.
  3. If any status is `IN_PROGRESS`, `ON_HOLD`, or `PENDING_VERIFICATION`, return `'ON_TASK'`.
  4. Else if any status is `ASSIGNED`, `SCHEDULED`, or `DRAFT`, return `'ASSIGNED'`.
  5. Else return `'AVAILABLE'`.
  When `useOverride` is false, steps 2-5 run regardless of `status_override` — used to expose
  the task-derived value for display next to an active override.
- `syncCrewStatus(crewId)` — computes `deriveCrewStatus(crewId)` and writes it to `crew.status`
  (single `UPDATE`), returns the value. Used after task transitions so the cached column is
  current. Returns `null` for a falsy/missing crew id.

`crewDetail` (`crews.js:8`) calls `deriveCrewStatus(c.id)` and `deriveCrewStatus(c.id, false)` and
returns:
- `status` — effective status (overriding the raw column it spreads today),
- `status_override` — manual override or `null`,
- `derived_status` — the task-derived value (`deriveCrewStatus(c.id, false)`), shown as a hint
  when an override is active,
- `open_task_count` — existing active-task count (`crews.js:16`), reused as the count tag.

### 5.2 Crew write endpoints

- `POST /crews` (`crews.js:122`) and `PUT /crews/:id` (`crews.js:139`): accept
  `status_override` from the body. Validate against `{null, 'AVAILABLE', 'OFF_DUTY',
  'UNAVAILABLE'}`; reject other values with 400. Ignore any legacy `status` input. After the
  write, call `syncCrewStatus(id)` and return `crewDetail` (already returned).
- Clearing an override must be explicit: `cleanRow` (`backend/util.js:39`) drops `null`, so
  `updateRow(..., { status_override: null })` is a no-op. The handlers clear via
  `db.prepare('UPDATE crew SET status_override = NULL WHERE id = ?')` when the value is
  `null`/`''`, and use `updateRow` only for a non-null value.
- `PUT /crews/:id` must only call `reconcileMembers(...)` when `members !== undefined`;
  otherwise a status-only PUT would treat the roster as empty and deactivate all members.
- Override changes are covered by the existing `audit(...)` call in these handlers.

### 5.3 Eligibility endpoint

`GET /crews/eligibility` (`crews.js:88`) changes:
- Remove the `.filter((c) => c.status === 'AVAILABLE')` at `crews.js:91`; keep `scopeRows` and
  the `region_id` filter.
- For each crew, base the result on `crewDetail(c)` and add:
  - `status` — effective status,
  - `open_task_count` — active task count,
  - `selectable` — `status !== 'OFF_DUTY' && status !== 'UNAVAILABLE'` (busy `ON_TASK` crews stay
    selectable but flagged),
  - `busy` — `status === 'ON_TASK'`,
  - existing `eligible` (certifications), `missing_certs`, and `score` unchanged. The existing
    `loadFactor` (`crews.js:99`) already lowers the score as `open_task_count` rises, so busy
    crews continue to rank lower.
- Sorting by `score` desc is unchanged.

### 5.4 Task transitions keep status live

In `POST /tasks/:id/state` (`backend/routes/tasks.js:339`), after the `UPDATE task ...` at
`tasks.js:404-408`, the audit, and any completion side effects (`applyCompletionSideEffects`,
which can create a follow-up task carrying `crew_id`), if `t.crew_id` is set call
`syncCrewStatus(t.crew_id)`. This covers `assign`, `start`, `hold`, `resume`, `submit`,
`reopen`, `verify`, and `cancel`. `syncCrewStatus` is imported from `backend/crewStatus.js` (see
5.1); wrap the call in try/catch so a sync failure never aborts the task transition.

## 6. Frontend

### 6.1 Status colors (`frontend/src/api.js`)

Add to `STATUS_COLORS` (`api.js:112`):
- `ON_TASK: '#0ea5e9'`,
- `OFF_DUTY: '#6b7280'`,
- `UNAVAILABLE: '#ef4444'`.

`AVAILABLE` and `ASSIGNED` already exist (`api.js:115`, `:124`). `Pill`
(`frontend/src/components.jsx:4`) already keys color off the value, so no Pill change is needed.

### 6.2 Crews page (`frontend/src/pages/Crews.jsx`)

- Roster table (`Crews.jsx:142`): status pill stays; add an active-task tag beside it, e.g.
  `{c.open_task_count} active` (render only when > 0). The existing "Open Tasks" column may
  remain or be folded into the tag; keep one representation to avoid duplication.
- Detail modal (`Crews.jsx:214`):
  - Show `Status` pill plus the override state; when `status_override` is set, show the derived
    value as muted text (e.g. "auto: ON_TASK").
  - Add a status control (select: `Auto` / `AVAILABLE` / `OFF_DUTY` / `UNAVAILABLE`) for
    `crew:write` users. On change, `PUT /crews/:id` with `{ status_override }`, then reload the
    detail and the roster.
  - Full task list: change `GET /crews/:id`'s task query (`crews.js:117`) from
    `LIMIT 50` to return all tasks (ordered `created_at DESC`) so the detail shows the complete
    task list for the crew.
- Add/edit form (`Crews.jsx:282`): add the same status override select; remove reliance on the
  legacy `status` field in `blank` (`Crews.jsx:11`).

### 6.3 Dispatch eligibility table (`Crews.jsx:174-190`)

Add `Status` and `Active` columns (`Pill value={c.status}` and `c.open_task_count`). Rows where
`!c.selectable` are rendered muted and, if a row is actionable, disabled. `ON_TASK` crews remain
visible and scored but flagged busy.

### 6.4 Crew selectors (tasks/assets/schedules)

For consistency, annotate crew options with effective status and active count and disable
`OFF_DUTY`/`UNAVAILABLE` options:
- `frontend/src/pages/Tasks.jsx:310` (task crew select) and the quick assign at `Tasks.jsx:127`
  (choose the first `selectable` crew instead of `crews[0]`),
- `frontend/src/pages/Assets.jsx:397` (default crew),
- `frontend/src/pages/Schedules.jsx:202` (responsible crew).

Data for these selects already comes from `GET /crews`, which now returns `status` and
`open_task_count`, so no new endpoint is required.

## 7. Error Handling

- Invalid `status_override` on write -> 400 with a clear message; no partial update.
- Derivation is read-only and tolerant: a missing crew or task query returning nothing yields
  `AVAILABLE`.
- `syncCrewStatus` failures must not abort a task transition: the task `UPDATE` and audit are
  authoritative; wrap the sync in a try/catch and log, leaving the next derivation to correct
  the cache.

## 8. Verification

No automated test framework exists, so verification is manual/scripted:

1. Boot the backend and confirm the migration adds `status_override` without error and existing
   crews default to `NULL` (Auto).
2. `curl` `GET /api/crews`: effective `status` reflects task state.
3. Exercise transitions on a crew with one task: `assign` -> `ASSIGNED`; `start` -> `ON_TASK`;
   `hold` -> `ON_TASK`; `resume` -> `ON_TASK`; `submit` -> `ON_TASK`; `verify` -> `AVAILABLE`;
   `cancel` on an assigned task -> `AVAILABLE`.
4. Set `status_override = 'OFF_DUTY'`, then assign/start another task: status stays `OFF_DUTY`
   and `derived_status` shows `ON_TASK`. Clear to `Auto`: status returns to the derived value.
5. `GET /api/crews/eligibility` returns all crews, non-selectable ones flagged; busy crews rank
   lower.
6. Frontend: `npm run build` succeeds; visually confirm roster tag, detail control, eligibility
   columns, and disabled crew options.

## 9. Out of Scope (restated)

Status history, per-member status, auto-revert timers, and status-based transition gating are
explicitly excluded from this sub-project.
