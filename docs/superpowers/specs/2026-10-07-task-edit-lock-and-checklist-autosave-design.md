# Task Edit Lock and Checklist Autosave Design

Date: 2026-10-07.

## 1. Problem

Three related gaps in the task execution lifecycle:

1. **Checklist responses are not held.** A clicked response only updates local component
   state (`frontend/src/components/ChecklistItem.jsx`). It reaches the server only on an
   explicit **Submit execution** or **Save draft** (`frontend/src/pages/TaskDetail.jsx:151`,
   `frontend/src/components/TaskRunner.jsx:101`, `frontend/src/components/TaskWorkPanel.jsx:89`,
   `mobile/src/app/checklist/[id].tsx:140`). Closing or refreshing the page loses a partially
   answered run.
2. **Equipment checks lock too early.** `PUT /tasks/:id/equipment-checks`
   (`backend/routes/tasks.js:703`) rejects any write unless the task status is
   `DRAFT`, `SCHEDULED`, or `ASSIGNED` (`tasks.js:712-714`). Once work starts the crew cannot
   correct or re-confirm availability while progressing.
3. **There is no server-side lock after submission.** `POST /tasks/:id/checklist`,
   `POST /tasks/:id/checklist/draft`, `PATCH /tasks/:id/work-items/:itemId`,
   `PUT /tasks/:id` and `POST /tasks/:id/findings` apply no status guard. Only the UI hides
   buttons, so the API still accepts edits on a `PENDING_VERIFICATION`, `COMPLETED` or
   `CANCELLED` task.

## 2. Goals

1. Clicking a checklist response debounce-saves it to the per-user server draft, so it
   survives refresh, navigation and device switches. The task still advances to
   `PENDING_VERIFICATION` only on an explicit submit.
2. Equipment availability checks are editable while the task is in progress
   (`IN_PROGRESS`, `ON_HOLD`) as well as before work (`DRAFT`, `SCHEDULED`, `ASSIGNED`), and are
   locked once the task is submitted for verification.
3. Once submitted for verification (or completed/cancelled), the server hard-blocks changes to
   the checklist, equipment checks, work-items, task metadata and new findings. Comments stay
   open. Reopen (`PENDING_VERIFICATION -> IN_PROGRESS`) unlocks.

## 3. Non-goals

- No change to checklist submit semantics, result derivation, GPS validation, or the automatic
  advance to `PENDING_VERIFICATION` (`tasks.js:1883-1896`).
- Attachments remain allowed after submission (they are shared evidence).
- No event-sourced revision history; a single per-user draft is overwritten in place.
- No change to the pre-start dispatch gate that requires required equipment to be confirmed
  before `start` (`backend/readiness.js:191-195`).
- No new task statuses.

## 4. Status policy

A single rule, mirrored by the backend and both clients:

- `EDITABLE_STATUSES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD']`
- `LOCKED_STATUSES = ['PENDING_VERIFICATION', 'COMPLETED', 'CANCELLED', 'FAILED']`

`reopen` moves `PENDING_VERIFICATION -> IN_PROGRESS` (`tasks.js:1014-1027`), which returns the
task to the editable set. `verify` (`-> COMPLETED`) and `cancel` (`-> CANCELLED`) keep it
locked. `FAILED` is treated as locked for consistency even though no transition currently
produces it.

## 5. Backend changes

### 5.1 Shared guard

In `backend/routes/tasks.js`, add a pure predicate reused by every handler:

```js
const EDITABLE_STATUSES = new Set(['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD']);
const isTaskEditable = (t) => EDITABLE_STATUSES.has(t.status);
```

Each guarded handler performs an early return before mutating:

```js
if (!isTaskEditable(t)) {
  return res.status(409).json({ error: 'Task is locked after submission for verification', code: 'TASK_LOCKED' });
}
```

This matches the existing early-return style of these handlers. `backend/routes/attachments.js`
imports the same `isTaskEditable` predicate (exported from `tasks.js` or a small shared module)
so the rule has one definition.

### 5.2 Guarded endpoints

| Endpoint | File | Change |
|---|---|---|
| `POST /tasks/:id/checklist` | `routes/tasks.js:1728` | reject when locked (entry guard) |
| `POST /tasks/:id/checklist/draft` | `routes/tasks.js:1677` | reject when locked |
| `PUT /tasks/:id/equipment-checks` | `routes/tasks.js:703` | widen allowed window to `EDITABLE_STATUSES`; keep 409 when locked |
| `PATCH /tasks/:id/work-items/:itemId` | `routes/tasks.js:2050` | reject when locked |
| `PUT /tasks/:id` (metadata/crew/template) | `routes/tasks.js:851` | reject when locked |
| `POST /tasks/:id/findings` | `routes/attachments.js:34` | reject when locked |
| `POST /tasks/:id/permit` | `routes/tasks.js:674` | align existing `COMPLETED|CANCELLED` check to `LOCKED_STATUSES` |

All rejections return `409` with `code: 'TASK_LOCKED'`.

### 5.3 Checklist GET

`GET /tasks/:id/checklist` (`tasks.js:1634`) already returns `task` (`tasks.js:1670`). Add a
top-level `editable` boolean derived from the same set so both clients can render read-only
without re-deriving the policy (the `task.status` field is also still present).

## 6. Web changes

- **New** `frontend/src/taskLifecycle.js`: exports `EDITABLE_STATUSES`, `LOCKED_STATUSES`,
  `isTaskLocked(status)` and `isEditable(status)`. Pure, unit-tested, mirrored by the hook and UI.
- **New** `frontend/src/hooks/useChecklistDraft.js`: owns the checklist state and template load,
  debounce-saves (~700 ms) the current items to `POST /tasks/:id/checklist/draft`, flushes on
  blur, unmount and template switch, and exposes `{ items, setItemValue, saving, saved, locked }`.
  Auto-save is skipped when `locked`.
- **Wire in** `TaskDetail.jsx`, `TaskRunner.jsx` and `TaskWorkPanel.jsx`, replacing their local
  `checklist` state and manual Save-draft path with the hook. A small `Saving... / Saved`
  indicator sits next to the run controls.
- When `locked`, render items read-only, show a "Submitted for verification - locked" banner,
  and keep the run/submit buttons hidden (they already are outside `IN_PROGRESS`).
- Equipment inputs: enable when `isEditable(status)` (new) instead of the hardcoded
  `DRAFT/SCHEDULED/ASSIGNED` checks (`TaskDetail.jsx:559-571`, `TaskRunner.jsx:186-187,370`).

## 7. Mobile changes

- `mobile/src/lib/taskLifecycle.ts`: mirror `EDITABLE_STATUSES` / `LOCKED_STATUSES` /
  `isTaskLocked`.
- `mobile/src/app/checklist/[id].tsx`: track `task.status` from the existing
  `ChecklistResponse.task` (`mobile/src/api/checklistTypes.ts:39`); debounce the existing
  `saveDraft` (outbox-backed, offline-safe) on any state change; when locked, disable inputs and
  hide Save/Submit with a locked banner. `template.draft` continues to restore saved answers on
  load.

## 8. Testing

- **Backend** `backend/test/taskLocks.test.js`: for each guarded endpoint assert `409
  TASK_LOCKED` at `PENDING_VERIFICATION` and `COMPLETED`, and success at `IN_PROGRESS` /
  `ON_HOLD`; assert equipment accepts `IN_PROGRESS` but rejects `PENDING_VERIFICATION`; assert
  `reopen` re-enables checklist draft/submit.
- **Web** `frontend/src/taskLifecycle.test.js`: lock-set membership; `useChecklistDraft` debounce
  helper extracted as a pure function where practical.
- **Mobile** `mobile/src/lib/taskLifecycle.test.ts`: lock-set membership.

## 9. Rollout and compatibility

- No schema migration; the policy is code-only and derived from existing statuses.
- The change is backward compatible: existing drafts keep working; the equipment window only
  widens, and the only newly rejected calls are edits to already-submitted tasks, which the UI
  never issues.
- Clients without the update keep their current UI gating and will start receiving `409
  TASK_LOCKED` on the endpoints they should not call after submission.
