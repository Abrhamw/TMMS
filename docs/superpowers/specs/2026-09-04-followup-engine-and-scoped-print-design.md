# Follow-up Task Engine + Scoped Report Printing

Date: 2026-09-04. Extends the `2026-09-04-rbac-reporting-assets` plan (Tasks 4-10 now closed
and re-verified; see that plan for the RBAC/roles migration, crew-role field split, findings,
attachments, report dossiers and asset register work).

## 1. Result-based follow-up tasks (hybrid)

**Behaviour**
- When a task is *verified* the backend evaluates its outcome signals:
  - `task.result` (`FAIL`/`PARTIAL`/`DEFERRED`/`PASS`),
  - recorded field findings severities (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`),
  - failed **critical** checklist steps (join `checklist_execution_item` →
    `checklist_item.critical_step`),
  - failed GPS evidence (`GPS_POINT` item FAIL or `gps_validation.result='FAIL'`).
- **Auto-create (EMERGENCY):** result `FAIL`, any CRITICAL/HIGH finding, critical-step
  failure, or GPS FAIL => an `EMERGENCY`, priority `HIGH`, status `ASSIGNED`, due in 48h,
  same region/crew and identical target keys (substation/line/tower/asset) as the source.
- **Recommend (one-click):** otherwise, `PARTIAL`/`DEFERRED` result or LOW/MEDIUM findings
  => a `CORRECTIVE`, priority `MEDIUM`, status `DRAFT`, due in 7 days, offered in the UI.
- **Dedupe:** never create a follow-up if an *open* task of the same `task_type` targets the
  identical key set. Linked via `task_link(link_type='FOLLOW_UP')` (child=task_id,
  parent=linked_task_id); parent GET includes `follow_ups` (created children) and
  `recommended_follow_ups` (remaining not-yet-created plans).

**API**
- `POST /tasks/:id/follow-ups` `{key}` (requires `task:create`) materialises the selected
  plan server-side (mirrors auto logic, returns 409 on dedupe, 403 without permission).
- Task number generation hardened: scans numeric `TK-\d{4}-\d+` suffixes (a legacy
  `TK-SCRATCH-CAP` row previously produced `TK-2026-000NaN`).

**UI (TaskDetail)**
- "Raised follow-up tasks" table (auto-created children, each with Open link).
- "Recommended follow-up" cards (reason + description + due/priority + "Create task",
  shown only to `task:create` holders).

## 2. Scoped report printing

- A `.print-report-scope` marks the *only* intended print area. When the Print button is
  pressed while such a scope exists, `body.report-printing` is toggled and the print CSS
  hides everything else (`@media print body.report-printing .content > *:not(.print-report-scope)`)
  so the printed output is just the active dossier/report - not the rest of the page.
- Every `printable` `Modal` (Lines/Reports/Crews/Checklists dossiers) is automatically a
  scope; the TaskDetail inline dossier is wrapped in `.print-report-scope`.
- No scope present (e.g. plain list view) => default full-view print unchanged.

## 3. Closing gaps from Tasks 4-10

- Added the missing `DELETE /tasks/:id/attachments/:attId` (Task 6): only the uploader, the
  task's crew lead, or a global role; removes the physical file then the row, with audit.
- Role-gated button sweep: Crews (Edit only for `crew:write`, dossier only for
  `report:write`), Schedules (Edit only for `schedule:write`), Checklists (Activate/Add-step
  only for `checklist:write`).

## 4. Files touched

- `backend/routes/tasks.js` - follow-up engine, `GET /tasks/:id` enrichment, robust task
  numbering.
- `backend/routes/attachments.js` - DELETE endpoint.
- `frontend/src/pages/TaskDetail.jsx` - follow-up/recommendation UI + scoped dossier card.
- `frontend/src/pages/Crews.jsx`, `Schedules.jsx`, `Checklists.jsx` - button gating.
- `frontend/src/components.jsx` (`PrintButton`, printable `Modal` scope), `styles.css`
  (scoped print rules).

## 5. Verification

- Crew member restricted (start/finding/submit 403); member checklist capture saved
  (`executed_by` person, `crew_id`) while task stays IN_PROGRESS; lead submit +
  manager verify completes. FAIL verify auto-created EMERGENCY child; second materialise
  409 (dedupe); crew-lead create 403. Dossiers generate (TASK/LINE). All endpoints smoke
  checked after restart; `npm run build` clean.
