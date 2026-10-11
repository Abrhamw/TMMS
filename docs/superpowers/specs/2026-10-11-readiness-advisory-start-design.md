# Readiness Advisory Start Design

Date: 2026-10-11.

## 1. Problem

Starting a task that fails the readiness gate returns a bare error:

```
409 { error: 'Task is not ready to dispatch', code: 'READINESS_BLOCKED', blockers, warnings }
```

(`backend/routes/tasks.js:1096-1113`, gate in `backend/readiness.js:170`).

Two gaps for the field user:

1. **The reasons are hidden.** The web/mobile API layer keeps only `data.error`
   (`frontend/src/api.js:50`), so the operator sees "Task is not ready to dispatch" with no
   indication of what is missing or how to fix it. The `blockers` array already carries the
   detail but is never rendered.
2. **It is a hard stop.** `dispatchGate` turns mandatory conditions into blockers that stop the
   start unless an authorised manager (`task:manage`) supplies `readiness_override_reason`.
   Field leads (`task:start`/`task:lead`) have no way to proceed and no explanation.

The operator asked for the gate to become advisory: show what is missed with recommendations,
require a short reason, allow the start, and log it.

## 2. Goals

1. Surface every unmet readiness condition, each with a plain-language recommendation.
2. Stop hard-blocking: `start` proceeds once the operator records a reason.
3. Record who started despite the gaps, the reason, and the blockers at that moment.
4. Show the same notice on web and mobile, and let mobile start a task too.

## 3. Non-goals

- No change to the transition graph or statuses (`TRANSITIONS`, `tasks.js:1018`).
- No change to `taskReadiness` (the advisory audit) or to `controlTower`'s use of the gate.
- No new permissions; the reason requirement replaces the old `task:manage` override gate for
  `start`.
- No event-sourced history: the override is recorded on the existing `task` columns and audit log.
- Recommendations do not perform the fix; they describe it (no one-click actions).

## 4. Backend changes

### 4.1 Blockers carry a recommendation

In `backend/readiness.js`, `dispatchGate` attaches a `recommendation` string to each blocker.
Blockers become `{ code, message, recommendation }`. This is additive: `controlTower.js:63` and
`GET /tasks/:id/readiness` (`tasks.js:676`) pass the array through unchanged.

| `code` | `recommendation` |
|---|---|
| `NOT_FOUND` | `Task not found.` |
| `NO_CREW` | `Assign a crew before starting.` |
| `TEAM_SHORTFALL` | `Add members so the crew meets the required team size.` |
| `MISSING_SKILL` | `Assign a member with the required skill: <skill>.` |
| `MISSING_CERT` | `Assign a member holding the required certification: <cert>.` |
| `EQUIPMENT_UNCONFIRMED` | `Confirm this equipment is available: <item>.` |
| `RESOURCE_UNAVAILABLE` | `Release or replace the reserved resource: <name>.` |
| `RESOURCE_CALIBRATION_DUE` | `Recalibrate or replace the reserved resource: <name>.` |
| `CRITICAL_SPARE_SHORT` | `Restock the critical spare or release its reservation: <desc>.` |
| `PERMIT_NOT_APPROVED` | `Record the permit/isolation approval.` |

An unknown `code` falls back to `Resolve: <message>`. The recommendation is derived from the
blocker's own `code` and message, so `taskReadiness` and the gate need no new plumbing.

### 4.2 `start` becomes advisory with a required reason

In `backend/routes/tasks.js`, the `action === 'start'` block (`tasks.js:1096-1113`) changes to:

- `gate.ready === true` → start exactly as today.
- `gate.ready === false` and no `readiness_override_reason` → respond `409` with
  `code: 'READINESS_REASON_REQUIRED'` and the same `blockers`/`warnings`:
  ```json
  {
    "error": "Task is missing readiness items — record a reason to start anyway",
    "code": "READINESS_REASON_REQUIRED",
    "blockers": [{ "code": "...", "message": "...", "recommendation": "..." }],
    "warnings": [{ "code": "...", "message": "..." }]
  }
  ```
- `gate.ready === false` and a reason is given → start, and record the override via the existing
  columns and audit `detail` (`tasks.js:1242-1251`).

The reason requirement applies to anyone who may start the task; the `can(req, 'task:manage')`
restriction on overriding is removed.

### 4.3 Crew requirement folds into the gate

`TRANSITIONS.start.needsCrew` currently stops an uncrewed task before the gate
(`tasks.js:1089`). To keep one path, the `needsCrew` hard stop is dropped for `start` so a missing
crew surfaces as the `NO_CREW` blocker and flows through the required-reason path. No other
transition uses `needsCrew`.

`GET /tasks/:id` already returns `dispatch_gate` (`tasks.js:660`), so clients need no extra fetch.

## 5. Web changes

- **`frontend/src/api.js`**: when a request fails, attach `code`, `blockers` and `warnings` from
  the response body onto the thrown `Error`. Additive; existing callers only read `message`.
- **New `frontend/src/readinessNotice.js`** (pure, unit-tested): `readinessSummary(gate)` returns
  `{ ready, missing: string[], recommendations: string[], blockers }`, mapping each blocker to its
  message and recommendation and defaulting unknown codes to `Resolve: <message>`.
- **New `frontend/src/components/ReadinessNotice.jsx`**: a `tone-warn` panel titled
  "This task is not ready to start", a bullet per missed item with its recommendation, a reason
  `textarea` and a "Start anyway" button disabled until the reason is non-empty. Renders nothing
  when `ready`.
- **Wire in** where Start exists, using `dispatch_gate` already loaded with the task:
  - `frontend/src/pages/TaskDetail.jsx:599` (Start work).
  - `frontend/src/components/TaskRunner.jsx:395-397` (start step).
  - `frontend/src/components/TaskWorkPanel.jsx:162` (Start work).
  Each calls `act('start', { readiness_override_reason: reason })` and reuses one reason input.
- New strings go through `frontend/src/i18n.js` (`en` plus existing locales fall back to `en`).

If the notice is present, the Start button is only enabled once a reason is entered; when the gate
is ready the notice is absent and Start behaves as before.

## 6. Mobile changes

- **`mobile/src/api/checklistTypes.ts`** (or the task detail type): add `dispatch_gate` to the task
  detail shape (`{ ready, blockers: {code,message,recommendation}[], warnings }`).
- **`mobile/src/app/task/[id].tsx`**: render a notice from `detail.dispatch_gate` listing each
  blocker's message and recommendation. When the task is `ASSIGNED` and the user may start, show a
  reason `TextInput` and a **Start work** button that enqueues the existing `task_state` outbox op:
  `{ task_id, action: 'start', readiness_override_reason }` (`mobile/src/db/outbox.ts:11`,
  `mobile/src/sync/engine.ts:84` already post it). The button is disabled until a reason is typed
  when the gate is not ready; when ready it starts without a reason.
- A small pure helper (shared shape with web's `readinessSummary`) may be extracted for testing.

## 7. Testing

- **Backend** `backend/test/readinessGate.test.js`: assert blockers include a `recommendation`;
  start with blockers and no reason → `409 READINESS_REASON_REQUIRED` carrying the blockers; start
  with a reason → task reaches `IN_PROGRESS` and `readiness_override_reason`/`_by`/`_at` are set;
  a ready task starts with no reason.
- **Web** `frontend/src/readinessNotice.test.js`: message/recommendation mapping, unknown-code
  fallback, `ready` short-circuit.
- **Mobile** `mobile/src/lib/readinessNotice.test.ts` if a helper is extracted; otherwise covered
  by `tsc --noEmit` and existing suites.

## 8. Rollout and compatibility

- No schema migration; the override columns already exist (`db.js:1352-1354`).
- Additive response fields only. Clients without the update keep their current behaviour and now
  receive `READINESS_REASON_REQUIRED` instead of `READINESS_BLOCKED` on an unexcused start.
- Removing the `task:manage` override restriction widens who can start a not-ready task, but only
  with a recorded reason; the audit trail is unchanged.
