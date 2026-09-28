# Infrastructure Counting Standards Design (Sub-project B1)

Date: 2026-09-10. Sub-project B1 of the six-part operations enhancement workstream
(crew status lifecycle; auto-counting substation bays + tower/asset standards; follow-up
auto-checklist; recurring schedule engine; line-inspection route tracing). Sub-project A (crew
status lifecycle) is complete. Requested workstream B was split, in agreement with the user,
into B1 (data integrity & counting standards) and B2 (registration & geo UX). This spec covers
B1 only: auto-counting substation bays, verifying tower/tower-asset counting, and per-tower-type
standard part sets.

## 1. Problem

Counting of the physical network today is a mix of hand-entered and cached values that can drift:

- `substation.bay_count` (`backend/db.js:61`) is a hand-typed integer with no relation to the
  `asset.bay` values actually registered under the substation, so it goes stale silently.
- `transmission_line.tower_count` (`backend/db.js:80`) is a cached mirror of
  `COUNT(tower WHERE line_id = ?)`. New code updates it inline after every tower CRUD/import
  (`backend/routes/core.js:641,672,720,874`), but legacy or partially-imported rows can still be
  out of step.
- Every tower is supposed to have exactly one `TWR-<tower_id>` mirror asset in `asset`
  (created on tower create/import, `core.js:635,677`), but nothing verifies this invariant or
  repairs legacy rows that predate mirroring.
- `tower_component` parts are seeded from a single fixed catalog (`backend/towerComponents.js:6-29`)
  for **every** tower, so a suspension tower and a terminal tower get an identical part set. There
  is no notion of a per-tower-type standard and no way to tell whether a tower's recorded parts
  match its type's standard.

As a result there is no single, trustworthy definition of "how many bays / towers / parts" a piece
of infrastructure has, and no way to check registered data against a standard.

## 2. Goals

1. `substation.bay_count` is **derived** from the distinct, trimmed, non-empty `asset.bay` values
   of that substation's non-`REMOVED` assets. It is no longer hand-entered.
2. `transmission_line.tower_count` and the one-`TWR-*`-mirror-asset-per-tower invariant are
   verified, and drift is repairable.
3. A **per-tower-type standard part set** exists for all six tower types, newly registered towers
   receive their type's set, and recorded parts can be checked against the standard.
4. Drift is repaired automatically at boot (non-destructively) and can be repaired on demand
   through a validation/reconcile API; existing edited parts are never wiped without an explicit
   user action.
5. The UI surfaces derived bay counts, per-tower standard compliance, line-level rollups, and an
   Infrastructure "Data validation" view.

## 3. Non-goals

- No admin editor for the tower standards in this sub-project (the table is seeded and read-only;
  editing is a future concern).
- No changes to bay labels themselves (still free text on `asset.bay`); only their counting.
- No deletion or rewriting of existing tower parts at boot or on read. Only the explicit
  "reset to standard" actions replace parts.
- No pricing/valuation changes, no report changes beyond reusing existing counts.
- Registration UX and map-based line/tower selection are deferred to sub-project B2.
- No status/history timeline for validation results.

## 4. Data Model

### 4.1 New table `tower_component_standard`

Created in `initSchema()` alongside the other `CREATE TABLE IF NOT EXISTS` statements in
`backend/db.js`, seeded at boot.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `tower_type` | TEXT NOT NULL | one of the six tower types |
| `component_type` | TEXT NOT NULL | matches `tower_component.component_type` |
| `name` | TEXT NOT NULL | display name |
| `material` | TEXT NOT NULL | default material |
| `default_quantity` | INTEGER NOT NULL | standard quantity for this type |
| `unit` | TEXT NOT NULL | `pcs` / `set` / `span` |
| `active` | INTEGER NOT NULL DEFAULT 1 | |
| UNIQUE | | `(tower_type, component_type)` |

The six tower types are `SUSPENSION`, `TENSION`, `ANGLE`, `TERMINAL`, `TRANSITION`, `DEAD_END`
(the same set offered in `frontend/src/pages/Towers.jsx:15`). Each type gets a full row set using
the existing ~22-part vocabulary from `COMPONENT_CATALOG`. Quantities differ by type: suspension
towers use single suspension insulator strings and no jumper/tension hardware; the tension family
(tension/angle/terminal/transition/dead-end) carries tension strings, jumpers, yoke plates and
extra clamps. Unknown types fall back to the `SUSPENSION` standard.

### 4.2 Derived counters

No new columns are added. Existing columns change meaning:

- `substation.bay_count` — derived cache; recomputed by `syncSubstationBayCount`.
- `transmission_line.tower_count` — derived cache; recomputed by `syncLineTowerCount`.
- `asset.bay` — unchanged (free text). Counting trims whitespace and ignores empty values.

## 5. Standards & Integrity Module

### 5.1 `backend/towerStandards.js`

- `STANDARD_SETS` — per-type seed data (`tower_type` → array of component rows).
- `seedTowerComponentStandards()` — idempotent insert into `tower_component_standard`
  (`INSERT OR IGNORE` on the unique key).
- `getStandardForType(towerType)` — returns the standard rows for a type, falling back to
  `SUSPENSION` for unknown/empty types.
- `seedStandardComponents(towerId, towerType)` — inserts the type's standard set into
  `tower_component`. Replaces the current fixed `seedDefaultComponents` from
  `backend/towerComponents.js`; the old export is removed and all call sites
  (`core.js` tower create/import/from-route) pass the tower type.
- `COMPONENT_CATALOG` remains the master part vocabulary and still backs
  `GET /tower-component-types`.

### 5.2 `backend/integrity.js`

- `syncSubstationBayCount(substationId)` — recompute `bay_count` for one substation from
  `SELECT COUNT(DISTINCT TRIM(bay)) FROM asset WHERE substation_id = ? AND lifecycle_status != 'REMOVED' AND bay IS NOT NULL AND TRIM(bay) != ''`.
- `syncLineTowerCount(lineId)` — recompute `tower_count` from the `tower` table.
- `syncTowerMirror(towerId)` — ensure exactly one `TWR-*` mirror asset exists for a tower and is
  current (create if missing; update fields if drifted). Duplicate mirrors are reported, not
  silently deleted.
- `reconcileAll()` — run the three syncs across the whole database; return
  `{ lines_fixed, towers_fixed, mirrors_created, substations_fixed }`. Idempotent.
- `validateIntegrity({ regionIds })` — read-only report; never writes.

### 5.3 Wiring

- `backend/routes/assets.js` create/update/delete calls `syncSubstationBayCount` for the affected
  substation (both the old and the new substation id when an asset is moved).
- `backend/routes/core.js` tower create/update/delete/import/from-route calls
  `syncLineTowerCount` + `syncTowerMirror`, replacing the inline
  `UPDATE transmission_line SET tower_count = ...` statements.
- `backend/server.js` runs `seedTowerComponentStandards()` and then `reconcileAll()` at boot,
  after schema/seed, and logs the reconcile summary.

## 6. API Endpoints

All endpoints are region-scoped like existing infrastructure endpoints (`isGlobal` /
`checkRegion`).

### 6.1 `GET /api/infrastructure/validation`

Read-only report:

```json
{
  "summary": { "lines": 0, "towers": 0, "substations": 0, "issues": 0 },
  "lines": [
    { "id": 0, "line_id": "", "name": "", "tower_count": 0, "actual_tower_count": 0,
      "missing_mirrors": 0, "non_standard_towers": 0 }
  ],
  "towers": [
    { "id": 0, "tower_id": "", "line_id": 0, "tower_type": "",
      "standard_count": 0, "recorded_count": 0,
      "missing": [], "extra": [],
      "qty_mismatches": [{ "component_type": "", "expected": 0, "actual": 0 }] }
  ],
  "substations": [
    { "id": 0, "substation_id": "", "name": "", "bay_count": 0, "actual_bay_count": 0 }
  ]
}
```

`summary.issues` counts all disclosed discrepancies (stale counts, mirror problems, non-standard
towers, bay drift).

### 6.2 `POST /api/infrastructure/reconcile`

Non-destructive repair of caches and mirrors (`reconcileAll()`). Requires `tower:write` or
`asset:write` (it repairs both tower and asset-derived counters) and is region-scoped to the
caller. Returns the reconcile summary. Does **not** change recorded parts.

### 6.3 `POST /api/towers/:id/reset-components`

Replaces the tower's `tower_component` rows with its type's standard set. Requires `tower:write`
and region scope; audited. Returns the tower's compliance summary after the reset.

### 6.4 `POST /api/lines/:id/reset-tower-components`

Same as 6.3 for every tower on the line. Requires `tower:write` and region scope; audited.
Returns `{ towers_reset, components_written }`.

## 7. UI Surfaces

1. **Substations** (`frontend/src/pages/Substations.jsx`, `SubstationSummary.jsx`)
   - The editable `bay_count` field is removed from the substation form; "Bays" is shown as a
     derived read-only value.
   - The substation detail/summary shows a bay breakdown: distinct bay labels with per-bay asset
     counts, plus a note when assets have a blank bay.
2. **Towers list** (`frontend/src/pages/Towers.jsx`)
   - New **Standard** column showing `recorded/standard` (e.g. `22/24`), green when compliant,
     amber when not.
3. **Tower detail modal**
   - "Expected vs recorded parts" section: missing, extra, and quantity-mismatched parts against
     the type standard.
   - **Reset to standard** button (permission-gated) calling `POST /towers/:id/reset-components`.
4. **Line detail modal** (`frontend/src/pages/Lines.jsx`)
   - Standards rollup: towers total, non-standard count, missing mirror assets.
   - **Reset all towers to standard** button calling `POST /lines/:id/reset-tower-components`.
5. **Infrastructure hub** (`frontend/src/pages/Infrastructure.jsx`)
   - New "Data validation" manage view rendering `frontend/src/pages/DataValidation.jsx`, fed by
     `GET /infrastructure/validation`: issue counts, expandable line/tower/substation rows, a
     **Reconcile** action (`POST /infrastructure/reconcile`), and per-item reset links.

## 8. Seed & Demo Data

- `backend/seed.js` creates towers through the per-type standard (`seedStandardComponents`) so the
  demo towers reflect their type.
- Seeded substation assets carry proper `bay` labels so the recomputed `bay_count` matches the
  intended demo values; any hand-set `bay_count` in the seed is either removed or left to be
  overwritten by the boot reconcile.

## 9. Migration & Testing

- **Migration:** `tower_component_standard` added with `CREATE TABLE IF NOT EXISTS` in
  `initSchema()`; seeded via `seedTowerComponentStandards()`. No other schema change.
- **Boot:** `reconcileAll()` after seed, logging the summary.
- Existing towers keep their recorded parts and are flagged non-standard until a user resets them.
- **Testing** (repo convention: no test framework):
  - `node --check` on every touched backend file; `npm run build` for the frontend.
  - Scratch backend on an isolated DB copy (ports 3011–3013, always stopped afterwards) plus
    curl checks:
    1. `bay_count` updates when an asset's `bay` is set, changed, or cleared;
    2. `tower_count` and the `TWR-*` mirror are consistent after tower create/update/delete/import;
    3. the validation endpoint reports seeded non-standard towers and any stale counts;
    4. `reset-components` produces a tower that matches its type standard;
    5. region scoping is enforced on validation/reconcile/reset;
    6. boot `reconcileAll` repairs artificially corrupted caches and missing mirrors.

## 10. Out of Scope

- Admin editing of tower standards; per-region standards.
- Registration UX improvements and map-based line/tower selection (sub-project B2).
- Follow-up auto-checklist (C), recurring schedule engine (D), line-inspection route tracing (E).
