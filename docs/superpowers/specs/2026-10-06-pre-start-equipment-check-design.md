# Pre-Start Equipment Availability Check - Design

Date: 2026-10-06
Status: Approved (design)

## 1. Summary

The equipment a task's checklist requires is already modelled and surfaced, but
the check is advisory and can only be filled by a dispatcher. `task_equipment_check`
exists, `PUT /tasks/:id/equipment-checks` records availability, `GET /tasks/:id/readiness`
and the dashboard/readiness reports read it, and the crew notification lists the
equipment to secure. However:

1. The endpoint requires `task:assign` or `task:manage`, so the assigned crew
   cannot record the check.
2. Starting work (`POST /tasks/:id/state` with `action: 'start'`) never consults
   the check. Readiness is documented as "decision support: it warns, it never
   blocks."

This design makes the pre-start equipment check a hard, recorded gate owned by
the assigned crew: every required item must have a recorded availability answer
before the task can transition from ASSIGNED to IN_PROGRESS.

## 2. Goals

- Let any active member of the task's assigned crew record the equipment
  availability check, in addition to the existing dispatcher permissions.
- Block `start` while any required equipment item is unanswered, returning the
  missing names so the client can guide the crew.
- Surface the check as a first step in the crew's guided execution surface
  (`TaskRunner.jsx`) and enable the existing box on `TaskDetail.jsx` for crew.
- Reuse the existing table, endpoint, readiness payload, and reporting with no
  schema change.

## 3. Non-goals

- No new database tables or migrations.
- No removal or rename of the existing `taskReadiness` fields, and no change to
  the readiness/report aggregations. The one addition is the per-item `answered`
  flag described in 4.2.
- No gate on `hold`, `resume`, `reopen`, or any transition other than the
  initial `start`. Resuming an already-started task keeps today's behaviour.
- No change to who may `start` a task (crew lead via `task:lead`/`task:start`,
  or supervisors via `task:manage`).
- No inventory tracking; "available" remains a recorded boolean, not a stock
  quantity.

## 4. Backend

### 4.1 `equipmentCheckBlocker(t)`

Add and export `equipmentCheckBlocker(t)` in `backend/readiness.js`, alongside
the existing `taskRequirements`/`taskReadiness` helpers.

- Required set = `(taskRequirements(t) || {}).equipment || []`. When the task
  names no checklist template, or the template requires no equipment, the
  required set is empty.
- Recorded set = `SELECT equipment_name FROM task_equipment_check WHERE task_id = ?`.
- Return `null` when nothing is required or every required name has a row;
  otherwise return the sorted array of missing names.

### 4.2 Readiness payload addition

`taskReadiness(t)` currently maps each required item to `available: true` only
when a row exists with `is_available = 1`, otherwise `false` — so an unrecorded
item and an explicitly "unavailable" item look identical to the client. That is
fine for a record of reality but not for a UI that must show "not yet answered".

Add an `answered` boolean to each entry in `equipment_checks`:
`available` stays `equipmentChecks.get(name) === true`, and `answered` is
`equipmentChecks.has(name)`. This is the only payload change; `equipment_to_secure`
and every existing field keep their current meaning, and no aggregation changes.

### 4.3 Gate in `POST /tasks/:id/state`

In the `action === 'start'` validation block in `backend/routes/tasks.js`,
alongside the existing checklist and GPS blockers and before any mutation,
call `equipmentCheckBlocker(t)`. When it returns a non-empty list, respond:

```
409 { "error": "Equipment check incomplete: <items>. Record equipment availability before starting work.", "missing_equipment": ["<item>", ...] }
```

The gate applies uniformly to crew and to supervisors forcing Start via
`task:manage`, matching the existing `checklistCompletionBlocker` behaviour.

### 4.4 Permission on `PUT /tasks/:id/equipment-checks`

Replace the current `task:assign || task:manage` check with:

- allow when `can(req, 'task:assign') || can(req, 'task:manage')`, or
- allow when the caller is a crew user on the task's crew
  (`isCrewUser(req.user) && isOnCrew(req.user, t.crew_id)`).

The existing status guard (only `DRAFT`, `SCHEDULED`, `ASSIGNED`), the
all-or-nothing validation against the current required set, the delete/reinsert
transaction, and the audit entry are unchanged. A crew user off the task's crew
still receives `403`.

## 5. Frontend

### 5.1 `frontend/src/components/TaskRunner.jsx`

- Track `equipmentDraft`, initialized from `task.readiness.equipment_checks`
  (mapping each item to its `available` value), the same pattern TaskDetail
  already uses.
- When `task.readiness.equipment_checks.length > 0`, prepend an **Equipment**
  step: `{ key: 'equipment', icon: PackageCheck, label: t('stepEquipment'),
  done: equipmentDone }`, where `equipmentDone` is true when every item reports
  `answered` (the server-authoritative flag from 4.2), so the step completes
  once the saved check covers the full required set. Tasks without required
  equipment keep the current four steps.
- The stepper grid uses `grid-cols-4` or `grid-cols-5` based on `steps.length`
  (both class literals present for Tailwind's scanner).
- The Equipment step renders a checkbox list mirroring TaskDetail's
  `equip-check-list`, plus a Save button that `PUT`s the full set to
  `/tasks/:id/equipment-checks` and reloads. Enabled when `canStart || canManage
  || canExecute`.
- Disable the Start button with a short hint while `!equipmentDone`. This is a
  convenience only; the server remains the enforcement point.

### 5.2 `frontend/src/pages/TaskDetail.jsx`

- Enable the existing "Recommended equipment availability" box and Save button
  for crew (`canAssign || canExecute`) instead of `canAssign` only.
  `saveEquipmentChecks` is unchanged.

### 5.3 i18n

- Add a `stepEquipment` phrase ("Equipment") to the phrase map next to the
  existing `stepChecklist` / `stepLocation` entries, including the Amharic
  translation used by the mobile surfaces.

## 6. Data and edge cases

- Reuses `task_equipment_check` and its `checked_by`/`checked_at` columns. No
  migration.
- Task requiring no equipment, or with no checklist, has an empty required set:
  no Equipment step, Start proceeds.
- A checklist template edited after a check changes the required set; stale rows
  no longer satisfy it, so Start blocks until re-saved. Since the endpoint is
  all-or-nothing, a successful save always records the complete current set.
- An item explicitly marked unavailable is a valid recorded answer and does not
  block Start; the record shows reality.
- Tasks already `IN_PROGRESS` when this ships are unaffected.
- The dashboard, crew readiness, and report aggregation that already read
  `task_equipment_check` need no change; the data simply becomes complete.

## 7. Testing

Backend (`cd /workspace/backend && node --test "test/*.test.js"`):

- Start on a task with required equipment and no recorded checks returns `409`
  with `missing_equipment`.
- After a full `PUT /tasks/:id/equipment-checks`, Start returns success and sets
  `actual_start`.
- A crew member of the task's crew can `PUT`; a crew user from another crew
  receives `403`.
- A task with no required equipment starts freely.
- Changing the required set after a check re-blocks Start for the new item.

Frontend (`cd /workspace/frontend && npm run build`) plus a Playwright check as
`ayu` (crew 1): the Equipment step appears, Start is disabled until every item
is answered, then succeeds. Confirm the TaskDetail box is usable by crew.

## 8. Rollout

- Backend and frontend ship together; the gate is additive and no existing task
  record is mutated.
- Commit each phase separately with explicit paths, never `git add -A`, and
  never stage `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, or
  `mobile/LICENSE`.
