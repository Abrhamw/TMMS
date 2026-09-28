# Infrastructure Hub & Scoped Asset Summaries

Date: 2026-09-08. A frontend-led workstream that reorganizes navigation around a single
**Infrastructure** destination and adds a scoped backend aggregate endpoint. Replaces the four
flat sidebar entries (Regions / Substations / Lines / Towers) with one drill-down tree plus
horizontal Region / Substation / Transmission-line summary tabs, built for "very dynamic,
user-friendly, easy to use" browsing. No schema changes; no new npm dependencies; no chart
library (lightweight CSS bars/donuts only).

## 1. Goal

Give users one place to understand the network's physical structure and its content at any
level, without hopping between flat list pages:

- A **drill-down tree** on the left: All regions → each region → its Substations and Lines
  (with child-count badges).
- **Horizontal summary tabs** inside the hub — Region / Substation / Transmission line — that
  aggregate within the tree's current scope.
- Rich but data-dense summaries (KPI tiles + CSS bar/donut breakdowns + categorized tables)
  at each level, with full CRUD kept reachable via a "Manage" pane that reuses existing screens.

Existing module groups below Infrastructure in the sidebar remain unchanged (Tasks, Crews,
Schedules, Reports, Value, Map, Assets, …), per user decision.

## 2. Current state

- Sidebar is a flat grouped list in `frontend/src/App.jsx:buildNav()`; `infrastructureGroup`
  holds `/regions`, `/substations`, `/lines`, `/towers`, `/assets`. Each entity page is a
  self-contained CRUD list (`Regions.jsx`, `Substations.jsx`, `Lines.jsx`, `Towers.jsx`) with
  forms, map/route import, CSV import, generate-joint-boxes.
- `transmission_line` (db.js:67-89) already carries `voltage_kv`, `line_type`,
  `conductor_type`, `circuit_count` (single/double), `length_km`, `tower_count`,
  `veg_clearance_m`. `substation` carries `voltage_levels` (JSON text), `bay_count`.
  `tower_component` rows per tower include `LINE_CONDUCTOR`, `OPGW`, `JOINT_BOX` etc.
- `asset` rows hang off `substation_id` / `line_id` / `tower_id` (db.js:108-138).
  Tower-mirror `TOWER` assets (asset_type `TOWER`) are created/synced in `core.js` on every
  tower create/update; tower CRUD also calls `seedDefaultComponents` (towerComponents.js:32).
- Region read/write scoping exists: `checkRegion`, `isGlobal`, `scopeRows` (auth.js); the
  register/valuation layers reuse it (`register.js`, workstream B) and keep the count invariant
  `valuation === /register/tree counts.assets === /assets/summary total_assets`.
- Live demo data probed: 13 regions, 6 substations, 3 lines (TL-C1-001 230kV/1 cct/17.2km/40
  towers; TL-C1-002 230kV/1 cct/20.9km/52 towers; TL-C2-001 400kV/2 cct/12.2km/34 towers),
  126 towers, 147 assets. Several demo substations legitimately hold 0 assets; two lines have
  blank `conductor_type`; OPGW tower components cover most towers (39/52/34). These exercise
  the empty/"Not recorded" states by design.

## 3. Decisions (from user)

1. Other modules stay as **groups below Infrastructure** in the sidebar (no new top bar/drawer).
2. Hub interaction = **drill-down tree + horizontal summary tabs** (tree sets the scope; tabs
   choose the summary kind).
3. Existing Regions/Substations/Lines/Towers CRUD, map and import screens are **folded into the
   hub** via Manage panes; their flat sidebar entries disappear but their routes remain as
   redirects into the hub.
4. Visual style = **KPI tiles + CSS charts + categorized tables** (no new deps).
5. Implementation = **Approach A**: one new scoped aggregate endpoint + rebuilt hub page.

## 4. Backend: `GET /api/infrastructure`

New read-only route module `backend/routes/infrastructure.js` mounted in `server.js`. Uses the
existing auth guard + region scoping helpers (`checkRegion`/`isGlobal`/`scopeRows` semantics);
a region-scoped user receives only their own region's subtree. No schema change, no audit rows
(read-only).

Response shape (all lists flat, region-scoped):

```
{
  currency,                          // system_config.currency (for future money display)
  regions: [{
    id, code, name, type, status, center_lat, center_lng, boundary_km,
    substationCount, lineCount, towerCount, circuitLengthKm,
    assetCount, assetTypes: { TYPE: n, ... },     // non-tower categories only
    avgCondition, conditionBands: { good: n, fair: n, poor: n }   // 8-10 / 5-7 / <5
  }],
  substations: [{
    id, substation_id, name, regionId, regionCode, latitude, longitude, status,
    voltageLevels: ["400kV", ...], bayCount, gpsValidated,
    transformerCount, assetCount, assetTypes: { ... },
    incidentLines: [{ id, line_id, name, voltage_kv }]
  }],
  lines: [{
    id, line_id, name, regionId, regionCode, fromSub, toSub,     // {id, substation_id, name}
    voltage_kv, line_type, conductor_type, circuitCount,
    length_km, towerCount, towerSpacingKm,                       // length / towerCount
    jointBoxCount, conductorSpanCount, opgwSpanCount,            // line-level asset types
    fiberOnTowers: { towers: n, qty: n },                        // OPGW tower components
    assetTypes: { ... }, operational_status
  }],
  towers: [{
    id, tower_id, lineId, lineCode, km_marker, tower_type, tower_material,
    height_m, corrosion_rating, gps_validated, componentCount
  }]
}
```

Implementation rules:

- Aggregates are SQL `GROUP BY` / `COUNT` over the scoped id set; filters: exclude
  `lifecycle_status = 'REMOVED'` (same as `/assets/summary`), and split tower-mirror `TOWER`
  assets out of `assetTypes` into `towerCount`.
- Region `circuitLengthKm` = sum of its lines' `length_km`; `conditionBands` from non-REMOVED
  assets (`condition_rating >= 8` good, `5-7` fair, `<5` poor). `avgCondition` over the same set.
- `voltageLevels` parsed from the `substation.voltage_levels` JSON text (defensive: tolerate
  missing/invalid JSON → `[]`).
- `towerCount` etc. must equal the same numbers `/register/tree` reports for the same scope
  (count invariant preserved for the hub's "towers" tiles).
- Unscoped list endpoints already in `core.js` remain untouched (Manage panes still call them).

## 5. Frontend: Infrastructure hub

New route `/infrastructure` renders `pages/Infrastructure.jsx` (the hub). Layout:

```
260px tree (searchable, expandable)
  All regions
  ▾ C1 Central 1  [substation=5, line=2]
      ▸ Substations → leaves (badge)
      ▸ Lines       → leaves
  …
| content: breadcrumb (All regions › C1 › TL-C1-001) with ✕ reset
  horizontal tabs: Region | Substation | Transmission line
  scope-driven summary (KPI tiles + CSS bars/donuts + categorized tables)
  Manage ▾  → embeds existing CRUD component for the current scope
```

Navigation model:

- Tree selects a node = sets scope; root ("All regions") = no region constraint. Selecting a
  leaf focuses that entity's deep summary under its kind's tab. Folder selection lists children.
- Horizontal tab chooses the summary kind. With scope "all", each tab enumerates every scoped
  entity (region/substation/line). With a region selected, Substation/Line tabs enumerate that
  region's children.
- Breadcrumb shows the scope path; ✕ returns to All regions.
- Search filters the tree by name/code.

Routes/URL state:

- Hub state is URL-driven: `/infrastructure?tab=region|substation|line&region=…&substation=…&line=…&manage=regions|substations|lines|towers`. Browser back/forward, refresh and deep links behave.
- Legacy `/regions`, `/substations`, `/lines`, `/towers` redirect to `/infrastructure` with the matching `manage` param, preserving old bookmarks and cross-links.

Components (single-purpose):

- `pages/Infrastructure.jsx` — hub shell: scope state, tab state, breadcrumb, data fetch, error/retry, skeletons.
- `InfraTree.jsx` — searchable region→substation/line tree from the aggregate payload (and `/regions` fallback if the aggregate call fails).
- `RegionSummary.jsx`, `SubstationSummary.jsx`, `LineSummary.jsx` — per-level summary grids/detail.
- `KpiTile.jsx`, `CssBar.jsx`, `CssDonut.jsx` — shared lightweight visual primitives.
- `ManagePane.jsx` — embeds the existing `Regions`/`Substations`/`Lines`/`Towers` page components unchanged; preselects their region/entity filter from the current scope where supported.

Summary content per level (KPI + CSS charts + tables):

- **Region**: KPI substations/lines/towers/circuit-km/assets/avg-condition; asset-mix bar
  (non-tower categories; towers as own tile); condition donut/bands; status/code chips.
- **Substation**: voltage-level chips, KPI transformers/incident lines (with voltage)/bays/
  assets; asset-category bar (transformers split out, protection/SCADA/IED grouped, aux power,
  switchgear, metering); incident-lines list linking to Line summary.
- **Line**: KPI towers/length-km/tower-spacing/conductor (or "Not recorded")/fiber
  (OPGW spans + towers-with-OPGW)/JB count; asset-type bar + towers-by-type bar; compact tower
  strip table (id, km, type, height, corrosion, gps) from the aggregate `towers` payload.
- **Manage panes**: existing CRUD behaviour unchanged.

Text conventions: page-local hard-coded English copy (as existing pages); nav strings through
`i18n` only where the current nav keys change (adding "infrastructure" entry + tab labels);
money/numbers formatted via existing `api.js` helpers where reused.

## 6. Errors, empty states, robustness

- Single fetch on mount → skeleton per tab; failure → error banner with Retry; 403 handled
  (redirect to sign-in or show "out of scope" message as existing pages do).
- Empty states: substation with no assets ("No equipment registered"), line with blank
  conductor_type → "Not recorded", line with 0 towers, region with 0 lines/substations, tree
  folder with no children, search with no matches.
- Defensive parsing of `voltage_levels` JSON; null-safe arithmetic (division by zero tower
  spacing, NaN guards) so a card never crashes the page.
- `vite build` must pass with no new dependencies.

## 7. Testing & verification

Backend (isolated DB harness as used by prior workstreams):

- Aggregate equality: each `region`/`substation`/`line`/`tower` summary field equals a direct
  SQL count/sum for the same scope.
- Scoping: global user sees 13/6/3/126; a C1 region user sees only C1's subtree (and its counts
  match `/register/tree` for C1).
- Empty-state fixtures: a region with 0 lines renders counts of 0 (not errors).

Frontend:

- `vite build` clean; existing suites (if any) still pass; existing nav groups untouched.
- Live smoke on the preview (existing running stack: backend :3001, Vite :5173): hub loads,
  tree search filters, each horizontal tab renders scoped summaries, Manage pane opens the CRUD
  screens, legacy `/regions` redirect works, region user (dir.c1) sees only C1.

## 8. Out of scope

- No new DB columns or migrations; no report types; no chart library; no change to valuation,
  cost, register, task, or checklist logic beyond what the aggregate endpoint reads.
- No changes to other sidebar modules' pages or routes.
- Demo data enrichment (e.g., back-filling blank `conductor_type`) is not part of this spec; the
  UI must handle blanks gracefully.
