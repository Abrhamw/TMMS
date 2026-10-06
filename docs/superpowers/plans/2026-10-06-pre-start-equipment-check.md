# Pre-Start Equipment Availability Check - Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/tmms1.db-shm/-wal`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Make the checklist equipment availability check a hard, recorded gate owned by the assigned crew: any active member of the task's crew may record it, and starting work is blocked until every required item has an answer.

**Architecture:** Reuse the existing `task_equipment_check` table and `PUT /tasks/:id/equipment-checks` endpoint. Add a shared `equipmentCheckBlocker(t)` in `backend/readiness.js`, call it from the `start` branch of `POST /tasks/:id/state`, relax the PUT permission to include the task's crew, and add an `answered` flag to the readiness payload so the client can tell "unanswered" from "answered unavailable". The crew guided surface (`TaskRunner.jsx`) gains an Equipment step that gates Start; `TaskDetail.jsx`'s existing box is enabled for crew.

**Tech Stack:** Node 22 (`node:sqlite`, `node --test`), Express; React 19, Vite 7, Tailwind 4, `motion`, `lucide-react`, vendored `src/ui` kit. Verify with backend tests, `npm run build`, and headless Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-pre-start-equipment-check-design.md`

## Global Constraints

- All API changes are additive; no existing endpoint, field, or response shape is removed or renamed. The only payload addition is `answered` on each `equipment_checks` entry.
- No schema change and no migration; `task_equipment_check` already holds `checked_by`/`checked_at`.
- The gate applies only to the initial `start` (ASSIGNED -> IN_PROGRESS). `hold`, `resume`, and `reopen` are untouched.
- An item marked unavailable is a valid answer and does not block Start; only unanswered required items block.
- No code comments. Stage explicit paths only; never `git add -A`.
- New i18n key `stepEquipment` added to every locale in `frontend/src/i18n.js` and mirrored in `frontend/src/phrases.am.js`.
- Motion respects `prefers-reduced-motion`; light and dark themes use tokens only; preserve the `Page` API and existing routes/role guards.

## File Structure

- `backend/readiness.js` - `missingEquipmentNames(required, recorded)` (pure, exported), `equipmentCheckBlocker(t)` (DB), and `answered` on `taskReadiness().equipment_checks`.
- `backend/routes/tasks.js` - start gate in the state handler; relaxed PUT permission.
- `backend/test/equipmentCheck.test.js` - new unit tests for `missingEquipmentNames`.
- `frontend/src/components/TaskRunner.jsx` - Equipment step, draft state, save handler, Start gating.
- `frontend/src/pages/TaskDetail.jsx` - enable the equipment box and Save for crew.
- `frontend/src/i18n.js`, `frontend/src/phrases.am.js` - `stepEquipment` key.

## Phase E1 - Backend gate and permission

### Task E1.1: Pure helper and blocker (`backend/readiness.js`)

- [ ] Step 1: Add `missingEquipmentNames(required, recorded)` returning the sorted names in `required` absent from the `recorded` set; return `[]` when `required` is empty. Export it.
- [ ] Step 2: Add `equipmentCheckBlocker(t)`: `required = (taskRequirements(t) || {}).equipment || []`; `recorded = new Set(db.prepare('SELECT equipment_name FROM task_equipment_check WHERE task_id = ?').all(t.id).map(r => r.equipment_name))`; return `null` when `missingEquipmentNames` is empty, else the array. Export it.
- [ ] Step 3: Add `backend/test/equipmentCheck.test.js` covering: empty required -> `[]`; all present -> `[]`; one missing -> `['X']`; sorted order; recorded extra names ignored.
- [ ] Step 4: Run `cd /workspace/backend && node --test "test/equipmentCheck.test.js"` and confirm all pass.

### Task E1.2: `answered` flag (`backend/readiness.js`)

- [ ] Step 1: In `taskReadiness`, change the `equipment_checks` map to `({ equipment: name, available: equipmentChecks.get(name) === true, answered: equipmentChecks.has(name), status: equipmentChecks.get(name) === true ? 'USED' : 'MISSED' })`.
- [ ] Step 2: Confirm no other field or aggregation in `readiness.js`, `dashboard.js`, or the report builders references `equipment_checks` in a way this breaks (grep `equipment_checks` under `backend/`).
- [ ] Step 3: Run `cd /workspace/backend && node --test "test/*.test.js"` and confirm the full suite is green.

### Task E1.3: Start gate (`backend/routes/tasks.js`)

- [ ] Step 1: Import `equipmentCheckBlocker` from `../readiness` (alongside the existing `taskReadiness`/`taskRequirements` imports).
- [ ] Step 2: In the `action === 'start'` validation block, before mutation, call `equipmentCheckBlocker(t)`; when non-null return `409 { error: 'Equipment check incomplete: ' + missing.join(', ') + '. Record equipment availability before starting work.', missing_equipment: missing }`.
- [ ] Step 3: Verify by API: pick an ASSIGNED task whose checklist requires equipment with no `task_equipment_check` rows, POST `state { action: 'start' }`, and confirm the 409 body lists the missing names and the task stays ASSIGNED.
- [ ] Step 4: Save a full check via `PUT /tasks/:id/equipment-checks`, POST `start` again, and confirm 200 with `actual_start` set. Restore the task's prior status/rows afterwards (test data only).

### Task E1.4: Relax PUT permission (`backend/routes/tasks.js`)

- [ ] Step 1: Replace the guard at the top of the `PUT /tasks/:id/equipment-checks` handler with: allow when `can(req,'task:assign') || can(req,'task:manage')`, else allow when `isCrewUser(req.user) && isOnCrew(req.user, t.crew_id)`, else `403`.
- [ ] Step 2: Confirm `isCrewUser` and `isOnCrew` are already imported/defined in this module (they are used by the state handler).
- [ ] Step 3: Verify by API: as `ayu` (crew 1) PUT a full check on a task assigned to crew 1 -> 200; PUT on a task of another crew -> 403; as `admin` -> 200.

## Phase E2 - Frontend

### Task E2.1: i18n

- [ ] Step 1: Add `stepEquipment` ("Equipment") to the base locale in `frontend/src/i18n.js` next to `stepChecklist`/`stepLocation`.
- [ ] Step 2: Add the Amharic translation to `frontend/src/phrases.am.js` next to the other `step*` phrases.
- [ ] Step 3: Run `cd /workspace/frontend && npm run build` and confirm it succeeds.

### Task E2.2: Equipment step (`frontend/src/components/TaskRunner.jsx`)

- [ ] Step 1: Add `equipmentDraft` state; initialize from `task.readiness.equipment_checks` (map each item to its `available`) inside `load()` / the load effect.
- [ ] Step 2: Compute `const equipmentChecks = x.readiness?.equipment_checks || []` and `const equipmentDone = equipmentChecks.length === 0 || equipmentChecks.every((i) => i.answered)`.
- [ ] Step 3: Build `steps` conditionally: when `equipmentChecks.length > 0`, prepend `{ key: 'equipment', icon: PackageCheck, label: t('stepEquipment'), done: equipmentDone }`.
- [ ] Step 4: Change the stepper grid class to `cn('mt-3 grid gap-2', steps.length > 4 ? 'grid-cols-5' : 'grid-cols-4')` (both literals present).
- [ ] Step 5: Add `saveEquipment()`: PUT `/tasks/${taskId}/equipment-checks` with `equipmentChecks.map((i) => ({ equipment: i.equipment, available: equipmentDraft[i.equipment] === true }))`, then `load()` and flash.
- [ ] Step 6: Add a `StepBlock` for `activeKey === 'equipment'` rendering the checkbox list (mirror TaskDetail's `equip-check-list`) and a Save button, enabled when `canStart || canManage || canExecute`.
- [ ] Step 7: In the checklist step, disable the Start button and show a hint while `!equipmentDone`; keep the server as the authority.
- [ ] Step 8: Import `PackageCheck` from `lucide-react`.

### Task E2.3: Enable TaskDetail box for crew (`frontend/src/pages/TaskDetail.jsx`)

- [ ] Step 1: In the equipment box, change the Save-button and checkbox `canAssign` gates to `(canAssign || canExecute)`.
- [ ] Step 2: Optionally show "Unanswered" for items with `answered === false` rather than "Missed", using the new flag.

## Phase E3 - Verification and commit

### Task E3.1: Automated verification

- [ ] Step 1: `cd /workspace/backend && node --test "test/*.test.js"` - all pass.
- [ ] Step 2: `cd /workspace/frontend && npm run build` - succeeds.
- [ ] Step 3: Playwright as `ayu` (`/tmp/opencode/diag/` scripts, auth via `addInitScript` + `localStorage.tmms_token/tmms_user/tmms_theme='light'`): open a task with required equipment via the runner, confirm the Equipment step appears, Start is disabled until the check is saved, then Start succeeds.

### Task E3.2: Commit

- [ ] Step 1: `git status` and `git diff`; confirm only intended files are staged.
- [ ] Step 2: Commit backend (readiness.js, routes/tasks.js, test) separately from frontend (TaskRunner.jsx, TaskDetail.jsx, i18n) with explicit paths.
- [ ] Step 3: Push to `origin` on branch `260928-feat-mailbox-reports-schedules`.
