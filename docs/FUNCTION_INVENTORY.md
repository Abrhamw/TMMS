# Function Inventory and Issue Register

Scope: `backend/auth.js`, `backend/routes/core.js`, `backend/routes/tasks.js`
Generated: 2026-09-12
HEAD: `4cca250`

Purpose: go function to function, agree on behavior, and fix the issues listed in
section 4 together. Line numbers are from the above HEAD.

Severity tags:
- `S` security / authorization / spoofing
- `C` correctness / data integrity
- `P` performance
- `Q` code quality / maintainability

---

## 1. backend/auth.js (226 lines)

| # | Function | Line | What it does | Issues |
|---|----------|------|--------------|--------|
| 1.1 | `hashPassword(password)` | 7 | scrypt + 16-byte salt, returns `salt:hash` | Blocking `scryptSync` on login path; acceptable but note. `Q` |
| 1.2 | `verifyPassword(password, stored)` | 13 | Split `salt:hash`, timing-safe compare | Handles malformed hash via length check. OK |
| 1.3 | `createSession(userId)` | 24 | 32-byte hex token, 12h expiry, insert `session` | No cap on sessions per user. `Q` |
| 1.4 | `destroySession(token)` | 33 | Delete session row | OK |
| 1.5 | `getUserFromToken(token)` | 37 | Reject expired, load user+person, attach `crew_id` | OK |
| 1.6 | `getUserCrew(user)` | 52 | Crew where person leads or is member | `LIMIT 1` with no `ORDER BY`; person in/leading 2 crews resolves nondeterministically. `C` |
| 1.7 | `hasPerm(user, perm)` | 117 | ADMIN wildcard, else role set | Redundant ADMIN special-case vs `'*'` in set. `Q` |
| 1.8 | `inRegion(user, regionId)` | 124 | Global true, null region true, else id equality | Returns true for `regionId == null`; permissive default can bypass scope when a caller passes a missing related row. `S` |
| 1.9 | `isGlobal(user)` | 131 | Role in GLOBAL_ROLES | OK |
| 1.10 | `isCrewUser(user)` | 137 | Role in CREW_ROLES | OK |
| 1.11 | `requireAuth(req,res,next)` | 144 | Parse `Bearer`, attach `req.user`/`req.token` | OK |
| 1.12 | `requirePerm(perm)` | 154 | Middleware factory, 403 on missing perm | OK |
| 1.13 | `can(req, perm)` | 163 | `hasPerm(req.user, perm)` | OK |
| 1.14 | `checkRegion(req,res,regionId)` | 167 | 403 when outside region | Same null-permissive behavior as 1.8. `S` |
| 1.15 | `scopeRows(user, rows, getRegion)` | 176 | Filter rows by region for non-global | Null `user.region_id` keeps only null-region rows. `Q` |
| 1.16 | `audit(user, action, entity, entityId, detail)` | 182 | Insert `audit_log`, non-fatal | Detail not size-capped. `Q` |
| 1.17 | `auditMiddleware(req,res,next)` | 192 | On 2xx mutation, log method+url+body | Strips only `password`/`token`; logs attachment `data`, GPS, notes; row can be huge. `S`/`Q` |

Cross-file notes:
- `auth.js` exports `isCrewUser` but `homeFeed.js` defines its own `isCrewRoleString`; potential drift. `Q`

---

## 2. backend/routes/core.js (1130 lines)

### 2.1 Internal helpers

| # | Function | Line | What it does | Issues |
|---|----------|------|--------------|--------|
| 2.1.1 | `rebuildLineRoute(lineId)` | 17 | Rebuild route from towers by `km_marker`, recompute length | Early-returns when `< 2` towers, leaving stale `route_json`. `C` |
| 2.1.2 | `listComponents(towerId)` | 30 | Tower components ordered by id | OK |
| 2.1.3 | `withTx(fn)` | 36 | BEGIN/COMMIT/ROLLBACK unit | Not reentrant; nested `withTx` would error. No current nesting. `Q` |
| 2.1.4 | `defaultVegClearance(kv)` | 52 | Voltage-class vegetation clearance | OK |
| 2.1.5 | `regionGuard(req,res,body)` | 61 | Force scoped writes into own region, reject mismatch | Mutates `req.body`; not used by `lines/import-route`. `Q` |
| 2.1.6 | `regionAssetCount(regionId)` | 72 | Count assets via substation/line/tower joins | Counts rows, not distinct: asset linked to both a line and a tower double-counts. `C` |
| 2.1.7 | `regionSummary(region)` | 83 | Region row + counts | Per-region N+1 when mapped over list. `P` |
| 2.1.8 | `cascadeDeleteRegion(id)` | 94 | Manual deep delete of everything in a region | No transaction; a mid-way failure leaves partial data. Duplicates `deleteSubtree` logic. `C`/`Q` |
| 2.1.9 | `idsOf(rows)` / `inClause(n)` | 215-216 | Helpers | OK |
| 2.1.10 | `lineTree(lineId)` | 218 | Collect line/tower/asset/task ids | OK |
| 2.1.11 | `substationTree(id)` | 230 | Collect substation subtree ids | OK |
| 2.1.12 | `deleteSubtree({...})` | 245 | Delete a line/substation subtree | No transaction; duplicates parts of 2.1.8. `C`/`Q` |
| 2.1.13 | `cascadeDeleteSubstation(id)` | 298 | Tree + schedules + gps + row | No transaction. `C` |
| 2.1.14 | `cascadeDeleteLine(id)` | 306 | Tree + gps | No transaction. `C` |
| 2.1.15 | `parseCsvToRecords(csv)` | 1047 | Tab/comma CSV parser with quotes + BOM | OK; no column-count/strictness validation. `Q` |

### 2.2 Routes: regions

| # | Route | Line | Perm | Notes / Issues |
|---|-------|------|------|----------------|
| 2.2.1 | `GET /regions` | 313 | read | Maps `regionSummary` per row (N+1). `P` |
| 2.2.2 | `GET /regions/:id` | 318 | read+region | Loads all `region_personnel` then filters in JS. `P` |
| 2.2.3 | `POST /regions` | 326 | `region:write` | Builds boundary from center; ADMIN-only in practice. |
| 2.2.4 | `PUT /regions/:id` | 342 | `region:write` | Rebuilds boundary when center present. |
| 2.2.5 | `DELETE /regions/:id` | 357 | `region:write` | `force=1` runs non-transactional cascade; no audit of deleted counts. `C` |

### 2.3 Routes: substations

| # | Route | Line | Perm | Notes / Issues |
|---|-------|------|------|----------------|
| 2.3.1 | `GET /substations` | 391 | read | `countSubstationBays` per row (N+1). `P` |
| 2.3.2 | `GET /substations/:id` | 399 | read+region | Loads all assets then filters in JS. `P` |
| 2.3.3 | `POST /substations` | 412 | `substation:write` | regionGuard; builds boundary. |
| 2.3.4 | `PUT /substations/:id` | 433 | `substation:write` | region scoped. |
| 2.3.5 | `DELETE /substations/:id` | 452 | `substation:write` | `force=1` non-transactional cascade. `C` |

### 2.4 Routes: lines

| # | Route | Line | Perm | Notes / Issues |
|---|-------|------|------|----------------|
| 2.4.1 | `GET /lines` | 478 | read | `get(substation)` per from/to (N+1). `P` |
| 2.4.2 | `GET /lines/:id` | 490 | read+region | Loads towers/assets + related tasks; per-task crew N+1. `P` |
| 2.4.3 | `GET /lines/:id/inspection-progress` | 516 | read+region | Coverage calc. OK |
| 2.4.4 | `POST /lines/import-route` | 530 | `line:write` | `create` mode does NOT call `regionGuard` (inconsistent with `POST /lines`); ADMIN-only today. `Q`/`S` |
| 2.4.5 | `POST /lines` | 575 | `line:write` | regionGuard; default veg clearance. Mass assignment via spread. `Q` |
| 2.4.6 | `PUT /lines/:id` | 592 | `line:write` | Mass assignment. `Q` |
| 2.4.7 | `DELETE /lines/:id` | 604 | `line:write` | `force=1` cascade; non-transactional. `C` |
| 2.4.8 | `POST /lines/:id/towers-from-route` | 625 | `tower:write` | Inserts tower+asset+components; no transaction; `syncLineTowerCount`+`rebuildLineRoute` after. `C` |
| 2.4.9 | `POST /lines/:id/route/space` | 685 | (read only) | No explicit read/`line:read` check; any authenticated user can preview. `Q` |
| 2.4.10 | `POST /lines/:id/route` | 700 | `line:write` | `withTx(setLineRoute)`. OK |
| 2.4.11 | `POST /lines/:id/towers/batch` | 715 | `tower:write` | `withTx(batchTowers)`. OK |
| 2.4.12 | `POST /lines/:id/towers/bulk` | 732 | `tower:write` | `withTx(bulkTowers)`. OK |
| 2.4.13 | `POST /lines/:id/towers/bulk-reset-components` | 747 | `tower:write` | `withTx(bulkResetComponents)`. OK |

### 2.5 Routes: towers and components

| # | Route | Line | Perm | Notes / Issues |
|---|-------|------|------|----------------|
| 2.5.1 | `GET /towers` | 763 | read+region | Per tower: `get(line)`, component counts, `towerCompliance` => N+1. `P` |
| 2.5.2 | `POST /towers` | 785 | `tower:write` | region via line; not transactional across tower+asset+seed. `C` |
| 2.5.3 | `PUT /towers/:id` | 812 | `tower:write` | Syncs mirror asset; not transactional. `C` |
| 2.5.4 | `DELETE /towers/:id` | 836 | `tower:write` | Blocks on open tasks; deletes asset+components; not transactional. `C` |
| 2.5.5 | `POST /towers/:id/reset-components` | 853 | `tower:write` | `withTx`. OK |
| 2.5.6 | `POST /lines/:id/reset-tower-components` | 868 | `tower:write` | `withTx`. OK |
| 2.5.7 | `GET /tower-component-types` | 887 | read | Returns catalog. OK |
| 2.5.8 | `GET /towers/:id` | 891 | read+region | OK |
| 2.5.9 | `GET /towers/:id/components` | 902 | read+region | OK |
| 2.5.10 | `POST /towers/:id/components` | 910 | `tower:write` | OK |
| 2.5.11 | `PUT /tower-components/:id` | 937 | `tower:write` | region via parent line. OK |
| 2.5.12 | `DELETE /tower-components/:id` | 949 | `tower:write` | OK |
| 2.5.13 | `POST /towers/import` | 963 | `tower:write` | Per-row commit + `rebuildLineRoute` inside the loop; not atomic. `P`/`C` |
| 2.5.14 | `POST /lines/:id/generate-joint-boxes` | 1085 | `line:write` | Dry-run and insert paths; uses COUNT for sequence. OK |

---

## 3. backend/routes/tasks.js (1071 lines)

### 3.1 Internal helpers

| # | Function | Line | What it does | Issues |
|---|----------|------|--------------|--------|
| 3.1.1 | `taskRegion(t)` | 17 | Returns `t.region_id` | Dead code (unused). `Q` |
| 3.1.2 | `taskVisible(user, t)` | 21 | Global all / crew own crew / region match | OK |
| 3.1.3 | `taskDetail(t)` | 27 | Enrich task with region/substation/line/tower/asset/crew/template/schedule/links | Multiple `get()` per task => N+1 when mapped. `P` |
| 3.1.4 | `listWorkItems(taskId)` | 42 | Work items by sequence | OK |
| 3.1.5 | `deriveWorkItems(source)` | 50 | Build follow-up work items from failed evidence | OK |
| 3.1.6 | `scopedTasks(req)` | 84 | Load all tasks, filter in JS by query | Full-table load + `taskDetail` per row => N+1. `P` |
| 3.1.7 | `csvField(v)` | 108 | CSV escape | OK |
| 3.1.8 | `taskTarget(t)` | 113 | Resolve target type+name | Per-call `get`. `P` |
| 3.1.9 | `isoWeekStart(d)` | 188 | Monday 00:00 ISO | Uses local timezone then ISO. `Q` |
| 3.1.10 | `validateTargets(req,res,t)` | 283 | Ensure target rows exist in task region | Asset branch does NOT check asset region (only substation match). `C` |
| 3.1.11 | `canControlWorkflow(req,action)` | 335 | Crew-lead/start/reopen/manage gate | OK |
| 3.1.12 | `applyCompletionSideEffects(req,t,cost)` | 427 | On verify: asset event, schedule advance, auto follow-up | Not transactional with the verify update; partial failure can complete without side effects. `C` |
| 3.1.13 | `isFollowUpTask(t)` | 469 | AUTO or has FOLLOW_UP link | OK |
| 3.1.14 | `checklistFailureRatio(taskId)` | 481 | failed/total checklist items | OK |
| 3.1.15 | `currentTaskSeq()` | 493 | Scan all task_numbers for max seq | O(n) per create; hardcodes 4-digit year format. `P`/`C` |
| 3.1.16 | `nextTaskNumber()` | 502 | `TK-2026-000001` | Hardcoded `2026`; drifts in 2027. `C` |
| 3.1.17 | `sameTarget(a,b)` | 506 | Compare target keys | OK |
| 3.1.18 | `openTaskLike(source,type)` | 510 | Find open same-target task | Full `list('task')` scan. `P` |
| 3.1.19 | `followUpSignals(t)` | 516 | Aggregate failure signals | Several queries per call. `P` |
| 3.1.20 | `followUpReason(s)` | 549 | Human-readable reason | OK |
| 3.1.21 | `hasFollowUpSignal(s)` | 564 | Any signal present | OK |
| 3.1.22 | `isEmergency(s)` | 571 | ratio > 0.4 | OK |
| 3.1.23 | `baseFollowUpTask(source)` | 575 | Common target fields | OK |
| 3.1.24 | `buildFollowUpPlans(source)` | 589 | auto EMERGENCY / recommend CORRECTIVE | OK |
| 3.1.25 | `createFollowUpTask(req,source,plan)` | 633 | Insert follow-up + work items + link | Inserts not wrapped in a transaction. `C` |
| 3.1.26 | `applyAutoFollowUps(req,source)` | 676 | Materialize auto plans | OK |
| 3.1.27 | `taskFollowUpView(source)` | 682 | Existing + recommended follow-ups | Per-child `taskDetail` N+1. `P` |
| 3.1.28 | `parseCriteria(v)` | 724 | Safe JSON parse of pass_criteria | OK |
| 3.1.29 | `itemResult(item,sub,responseValue)` | 780 | Derive PASS/FAIL per response type | NUMERIC and GPS_POINT branches `JSON.parse` without try/catch => 500 on bad data. `C` |
| 3.1.30 | `deviceTarget(t)` | 855 | Resolve expected device coords/tolerance | OK |
| 3.1.31 | `validateGps(t,pos,opts)` | 888 | Compare measured vs expected, always persist row | `validated_by: t.crew_id` (crew not person); asset/substation/tower updates outside a transaction. `C` |
| 3.1.32 | `nearestRouteDistance(route,lat,lng)` | 971 | Min distance to route | OK |
| 3.1.33 | `pointToSegmentMeters(...)` | 982 | Equirectangular point-segment distance | OK |
| 3.1.34 | `lineCoverageFor(lineId,route)` | 1012 | Coverage wrapper | OK |

### 3.2 Routes

| # | Route | Line | Perm | Notes / Issues |
|---|-------|------|------|----------------|
| 3.2.1 | `GET /tasks` | 104 | `task:read` via visibility | Full scan + `taskDetail` per row (N+1). `P` |
| 3.2.2 | `GET /tasks/export.csv` | 121 | `task:read` | Builds whole export in memory; per-row lookups. `P` |
| 3.2.3 | `POST /tasks/bulk` | 154 | `task:bulk` | Validates ids; loops `get('task')` per id (N+1). `P` |
| 3.2.4 | `GET /tasks/kpi` | 196 | `task:read` | Aggregates in JS over full scan. `P` |
| 3.2.5 | `GET /tasks/:id` | 227 | visibility | Adds executions/gps/findings/work items/attachments/follow-ups. Several queries but bounded. OK |
| 3.2.6 | `POST /tasks` | 248 | `task:create` | `...req.body` spread after `task_number`: client can mass-assign fields (task_number, result, verified_by, id via insertRow). `S` |
| 3.2.7 | `PUT /tasks/:id` | 271 | `task:manage` | Same mass-assignment concern. `S` |
| 3.2.8 | `POST /tasks/:id/state` | 343 | per-action | `assign` accepts any `crew_id` (no existence/region check); `verify` result not enum-validated; schedule fixed to `task:assign or task:manage`. `C` |
| 3.2.9 | `POST /tasks/:id/follow-ups` | 699 | `task:create` | Creates follow-up; not transactional. OK otherwise |
| 3.2.10 | `GET /tasks/:id/checklist` | 729 | `task:execute` | OK |
| 3.2.11 | `POST /tasks/:id/checklist` | 741 | `task:execute` + crew own | `executed_by` client-spoofable; `itemResult` unguarded parse (3.1.29); GPS/asset writes not transactional. `C`/`S` |
| 3.2.12 | `PATCH /tasks/:id/work-items/:itemId` | 994 | execute/lead/manage | OK |
| 3.2.13 | `POST /tasks/:id/trace` | 1019 | `task:execute` + crew own | OK |
| 3.2.14 | `GET /tasks/:id/trace` | 1055 | visibility | OK |

---

## 4. Consolidated issue register (fix together)

Ordered by severity. Each item lists the affected function(s).

### Security (S)
- **S1. Mass assignment in task create/update.** `POST /tasks` (3.2.6) spreads `req.body` after generating `task_number`; `PUT /tasks/:id` (3.2.7) passes `req.body` straight to `updateRow`. Client can set fields such as `task_number`, `result`, `verified_by`, `revision`, or `id`. Whitelist writable columns.
- **S2. Permissive null-region scope.** `inRegion` / `checkRegion` (1.8, 1.14) return true when `regionId` is null/undefined. Tighten to deny for non-global users, or make callers explicit.
- **S3. `executed_by` spoofable.** `POST /tasks/:id/checklist` (3.2.11) honours `req.body.executed_by`; should derive from `req.user.person_id`.
- **S4. Audit body over-collection.** `auditMiddleware` (1.17) logs full request body minus password/token, including base64 attachment `data` and GPS. Cap field size / whitelist keys.

### Correctness (C)
- **C1. Non-transactional cascades.** `cascadeDeleteRegion`, `deleteSubtree`, `cascadeDeleteSubstation/Line` (2.1.8-2.1.14) and `DELETE` routes (2.2.5, 2.3.5, 2.4.7) can leave partial data on failure. Wrap in `withTx`.
- **C2. Non-transactional multi-write routes.** Tower create/update/delete (2.5.2-2.5.4), `towers-from-route` (2.4.8), `POST /tasks` side effects (3.1.12), `createFollowUpTask` (3.1.25), `validateGps` asset writes (3.1.31), checklist asset writes (3.2.11). Wrap each logical unit in `withTx`.
- **C3. `getUserCrew` nondeterminism.** (1.6) Add deterministic ordering or explicit lead-first rule.
- **C4. Stale line route.** `rebuildLineRoute` (2.1.1) leaves old `route_json` when towers drop below 2. Clear or flag.
- **C5. Asset-region validation gap.** `validateTargets` (3.1.10) does not verify an asset's region/line. Add the check.
- **C6. Unvalidated state inputs.** `assign` accepts arbitrary `crew_id`; `verify` accepts arbitrary `result`. Validate existence + enum (3.2.8).
- **C7. Unguarded JSON.parse in checklist scoring.** `itemResult` (3.1.29) NUMERIC/GPS branches can throw 500. Use `parseCriteria` / try-catch.
- **C8. Hardcoded task-number year.** `POST /tasks` (3.2.6) and `nextTaskNumber` (3.1.16) hardcode `2026`. Derive from current year.
- **C9. `regionAssetCount` double counting.** (2.1.6) Count distinct asset ids.

### Performance (P)
- **P1. N+1 + full-table scans in list endpoints.** DONE for `GET /regions`, `/towers`, `/assets`, `/assets/summary`, and `scopedTasks`/`taskDetail` (3.1.3, 3.1.6). Measured on a 2k-tower / 3k-asset / 4k-task DB: `/towers` 20.1s -> 0.56s, `/tasks` 12.0s -> 1.8s, `/assets` 1.5s -> 1.0s. Responses verified byte-identical. Residual (not yet needed at this scale): `countSubstationBays` per substation, `/substations`, `/lines`, `/tasks/kpi`, `/tasks/export.csv`, follow-up view (3.1.27) remain per-row.
- **P2. `currentTaskSeq` full scan.** DONE. Extracted `backend/taskNumber.js`; uses SQL `MAX(CAST(substr(task_number,9) AS INTEGER))` with a numeric GLOB, shared by `tasks.js`, `schedules.js`, `scheduler.js`. Old-vs-new value verified identical on real data.
- **P3. `towers/import` rebuilds route per row.** DONE. Rebuilds `syncLineTowerCount` + `rebuildLineRoute` once per affected line; all target lines are authorized before any write. 300-row import ~1.4s with one route rebuild.

### Quality (Q)
- **Q1. Duplicated cascade logic.** DONE, and while verifying it surfaced a correctness bug: the old cascades never deleted `task_finding` / `attachment` / `task_work_item` for removed tasks, and deleting crews left `asset.default_crew_id` / `task.crew_id` / `checklist_execution.crew_id` / `task_finding.crew_id` references behind, so `DELETE /regions/:id?force=1` failed with `FOREIGN KEY constraint failed` on realistic data. `cascadeDeleteRegion` and `deleteSubtree` now share one `purgeSubtree` core; it also clears execution-scoped findings/attachments, task children, parent-asset links, and crew references. Verified: region/line/substation deletes leave `foreign_key_check` empty and `integrity_check ok`, plus an end-to-end HTTP `DELETE /regions/1?force=1` returns 200.
- **Q2. Dead code:** `taskRegion` (3.1.1). DONE (removed).
- **Q3. Duplicate crew-role detection** between `auth.isCrewUser` and `homeFeed.isCrewRoleString`. DONE (`homeFeed` uses shared `isCrewRole`).
- **Q4. Inconsistent region guard:** `lines/import-route` create (2.4.4) skips `regionGuard`. DONE (`checkRegion` in create mode).
- **Q5. Missing read-perm on preview route:** `lines/:id/route/space` (2.4.9). DONE (requires `line:read`).
- **Q6. Session/audit growth:** no expired-session cleanup (1.3); uncapped audit detail (1.16). DONE (`createSession` prunes expired; audit detail capped/redacted).
- **Q7. `isoWeekStart` timezone** uses local time then `.toISOString()` (3.1.9). DONE (UTC-based).

---

## 5. Fix order (all items resolved)

1. S1-S4 (security; small, high value). DONE.
2. C6, C7, C8, C5 (input validation and crashes). DONE.
3. C1, C2 (transactions; larger but localized). DONE.
4. C3, C4, C9 (targeted correctness). DONE.
5. P1-P3 (performance; measured and fixed on a realistic-volume DB). DONE.
6. Q1-Q7 (cleanup; Q1 also fixed an incomplete-cascade integrity bug). DONE.
