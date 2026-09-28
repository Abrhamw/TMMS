# Chain-of-Command Authority — Design

Date: 2026-09-13
Status: Approved (design); awaiting implementation plan

## Problem

The TMMS org chart already models the real Transmission Substation Operation
hierarchy, but the application does not enforce it. Authority is region-wide
only, so any region-scoped manager can assign work to any crew in the region
regardless of department. Concretely:

- `crew` has no link to an `org_unit`, so the system cannot tell which crews
  belong to which manager.
- Task assignment (`backend/routes/tasks.js`) checks only the assigner's
  `region_id`, so a Substation O&M manager could assign a Transmission Line or
  Relay/SCADA crew.
- Task visibility for management roles is region-wide, not command-scoped.
- `REGION_MANAGER` cannot execute checklists (`task:execute` is not granted).
- Operational Technology (relay/protection/OPGW/SCADA) is modeled as a single
  region department with no cross-region functional reach, even though OT is a
  parallel team that can task region relay crews.

## Target hierarchy

```
CEO
└─ DCEO, Transmission Business Unit
   └─ Executive, Transmission Substation Operations
      ├─ Director, Region Coordinations            (center crews, national special works)
      │  └─ <Regional Directorate>                 (Region Director + regional center crew)
      │     ├─ Dept: Substation Operation & Maintenance   → Region Manager + crews
      │     ├─ Dept: Transmission Line & OPGW Maintenance → Region Manager + crews
      │     └─ Dept: RTU / Telecom / SCADA & Protection   → Region Manager + crews
      └─ Operational Technology (parallel)         (OT center crews, functional cross-region)
```

Department heads are **Region Managers**. Each owns the crews of their
department. The Region Director owns every department in the region plus the
regional center crew. Region Coordination is a corporate coordination office
with its own center crew. OT is a parallel functional line that owns its center
crews and may task the functional (relay/SCADA/OPGW) crews of any region.

## Decisions

- Enforce assignment and management **by org-unit subtree** (not merely by
  region, not a full workflow/routing engine).
- Department heads unify to RBAC role `REGION_MANAGER`; the function is
  derived from their org unit. Legacy role names remain accepted aliases.
- OT has **cross-region functional authority** over functional crews.
- Model all three center-crew pools: Region Coordination (national), Region
  Director (regional), OT (functional).
- Region Managers get **checklist execution** (`task:execute` plus the capture
  permissions needed to complete a run), not the full lead/submit flow.
- Two authority dimensions: administrative (org tree) and functional (OT).

## Data model

- `crew.org_unit_id INTEGER REFERENCES org_unit(id)` — administrative owner.
  Nullable for legacy rows; backfilled by boot reconcile. Added via
  `migrate(...)` in `backend/db.js`.
- New `org_unit.unit_type` value `OPERATIONAL_TECHNOLOGY`, used by the `DIV-OT`
  division under `DIV-TSO-EXEC`.
- `backend/routes/org.js` `UNIT_TYPES` is aligned with the department types the
  seeds already use: `SUBSTATION_MAINTENANCE`, `TRANSMISSION_MAINTENANCE`,
  `RELAY_SCADA_TELECOM`, `SUBSTATION_UNIT`.
- Crew function reuses `crew.crew_type`. Functional set for OT reach:
  `RELAY_AND_PROTECTION`, `SCADA_RTU`, `TELECOM`, `OPGW`.
- Center crews are ordinary crews attached by `org_unit_id`:
  - `CREW-RC-SPECIAL` → `DIV-REGCOORD`
  - `CREW-C1-SPECIAL` → `DIR-C1`
  - `CREW-OT-RLY`, `CREW-OT-SCADA` → `DIV-OT`

## Authority rules

New module `backend/authority.js`:

- `unitSubtree(unitId)` — recursive `org_unit` descendants (recursive CTE).
- `userUnit(user)` — `person.org_unit_id`; for a crew user with no person unit,
  the crew's `org_unit_id`.
- `authorizedCrewIds(user)`:
  - `ADMIN`, `EXECUTIVE` (CEO, DCEO, TSO Exec, Region Coordination) → all crews.
  - Crew roles (`CREW_LEAD`, `CREW_MEMBER`, `FIELD_CREW`) → own crew only.
  - `REGION_MANAGER` → crews whose `org_unit_id` ∈ `unitSubtree(userUnit)`;
    **plus**, if `userUnit.unit_type ∈ {RELAY_SCADA_TELECOM, OPERATIONAL_TECHNOLOGY}`,
    every crew whose `crew_type` is in the functional set, in any region.
  - `PLANNER`, `DISPATCHER` → today's region-scoped reach (unchanged).
  - Legacy aliases (`SUBSTATION_MANAGER`, `TRANSMISSION_MANAGER`,
    `RELAY_SCADA_MANAGER`) resolve to the `REGION_MANAGER` rule.
- `canAssignCrew(user, crewId)` — membership in `authorizedCrewIds`.
- `isFunctionalCrew(crew)` — `crew_type` in the functional set.
- `taskVisible(user, task)`:
  - global → all;
  - crew user → own crew;
  - manager → task's crew is authorized, **or** the task is unassigned within
    their region, **or** they created it.
- Cross-region access bypasses `checkRegion` **only** for a functional crew
  managed by an OT (unit-type-based) `REGION_MANAGER`.

## Permissions

`backend/auth.js` (mirrored in `frontend/src/auth.js`):

- `REGION_MANAGER_PERMS = READ_PERMS + OPERATIONS_WORKFLOW + task:execute +
  gps:write + attachment:write`.
- `REGION_MANAGER` uses `REGION_MANAGER_PERMS`.
- `SUBSTATION_MANAGER`, `TRANSMISSION_MANAGER`, `RELAY_SCADA_MANAGER` remain in
  `ROLE_PERMS` as aliases mapping to `REGION_MANAGER_PERMS` so existing
  sessions/tokens keep working during rollout.

**Segregation of duties:** a task cannot be verified/completed by the same
person who performed its latest checklist execution
(`checklist_execution.executed_by`).

## Enforcement points

- `PATCH /tasks/:id/state` action `assign` → `canAssignCrew`, else 403.
- `PATCH /tasks/:id` when setting `crew_id` → `canAssignCrew`.
- `POST /tasks` with `crew_id` → `canAssignCrew`; unassigned creation allowed.
- `POST /tasks/:id/state` action `verify` → `task:verify` + crew authority +
  segregation-of-duties rule.
- `cancel` / `reopen` → crew authority (or unassigned in-region task).
- `GET /crews` returns an `assignable` flag per crew.
- `GET /crews/eligibility` returns only assignable crews.
- `crews` create/update: a manager may only attach a crew to — and manage crews
  within — their own unit subtree; `ADMIN` unrestricted.
- `crewDetail` (`backend/routes/crews.js`) and `unitDetail`
  (`backend/routes/org.js`) expose the owning org unit; `unitDetail` lists crews
  by `crew.org_unit_id` instead of all crews in the region.

## Seeding, migration & reconcile

`backend/db.js`
- `migrate('crew', 'org_unit_id', ...)`.

`backend/seed_eep.js` (idempotent)
- Add `DIV-OT` under `DIV-TSO-EXEC` (`unit_type = OPERATIONAL_TECHNOLOGY`) and
  an OT head persona (`dir.ot`, role `REGION_MANAGER`).
- Add the three center-crew pools with leads, members, and login accounts.
- Backfill `org_unit_id`: `CREW-C1-SOM → DEPT-C1-SOM`,
  `CREW-C1-TLOM → DEPT-C1-TLOM`, `CREW-C1-RTSP → DEPT-C1-RS`.

`reconcileSeedData()`
- Migrate `user.role` from `SUBSTATION_MANAGER` / `TRANSMISSION_MANAGER` /
  `RELAY_SCADA_MANAGER` → `REGION_MANAGER`.
- Backfill `crew.org_unit_id` for both seed paths by known crew-code mapping;
  unmatched crews stay null until an admin assigns them.
- Ensure `DIV-OT`, the OT head, and the center crews exist; keep the existing
  persona-password reconciliation.

## Frontend

- `frontend/src/auth.js` mirrors the permission change.
- `Organization.jsx` groups crews under their owning unit and shows `DIV-OT`
  plus center crews; adds the `OPERATIONAL_TECHNOLOGY` label.
- `TaskDetail.jsx` assign picker uses the `assignable` flag from `/crews` so a
  manager only sees crews within their authority.
- `Settings.jsx` keeps `REGION_MANAGER` as the primary role; legacy names remain
  selectable but marked legacy. `Login.jsx` demo hints gain the OT head and a
  center-crew login.

## Testing

Scratch-DB integration harness (throwaway script under `/tmp`), booting the real
server against a copy:

1. Substation O&M manager assigns its own crew → 200.
2. Substation O&M manager assigns the TLOM crew → 403.
3. Region Director assigns any C1 crew → 200.
4. OT manager assigns `CREW-C1-RTSP` and an out-of-region functional crew → 200.
5. OT manager assigns an out-of-region non-functional crew → 403.
6. `REGION_MANAGER` has `task:execute` (can POST a checklist execution) plus
   `gps:write` / `attachment:write`.
7. Segregation of duties: verifier = latest executor → 403/409.
8. Crew member cannot assign and only sees its own crew.

Plus `node --check` on touched files, `npm run build` for the frontend, and the
existing 57-check regression suite.

## Rollout

- Additive column and idempotent boot reconcile; no destructive data change.
- Legacy role aliases keep existing sessions/tokens valid.
- Back up the dev DB before the first reconcile boot.
- Commit in logical batches on `master`; do not push.

## Out of scope

- Task auto-routing by function (e.g. automatically dispatch all relay tasks to
  OT); assignment stays manual within the authorized set.
- Approval chains or delegation of authority with expiry.
- Physical/geographic reassignment of regions or the corporate tree beyond the
  OT division and center crews.
- Per-region explicit OT grants beyond the functional crew-type rule.

## Decomposition / build order

1. **Schema + authority module + permission unification** — `crew.org_unit_id`,
   `backend/authority.js`, `REGION_MANAGER_PERMS`, role migration.
2. **Seed + reconcile** — `DIV-OT`, OT head, three center-crew pools, crew
   `org_unit_id` backfill.
3. **Enforcement** — assignment/verify/manage checks, `/crews` `assignable`,
   `crewDetail`/`unitDetail` crew ownership, segregation of duties.
4. **Frontend + tests** — mirror perms, Organization/TaskDetail/Settings/Login,
   integration harness and regression run.
