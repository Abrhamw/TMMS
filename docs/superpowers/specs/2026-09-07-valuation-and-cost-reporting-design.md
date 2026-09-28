# Asset Valuation & Maintenance Cost Reporting (B)

Date: 2026-09-07. Second workstream (B) of the requested enhancement set described in
`2026-09-07-asset-register-taxonomy-design.md`. This spec adds pricing + valuation and
maintenance cost capture/reporting, surfaced on a dedicated financial page. Related sibling
specs cover checklist attribution + performance reports (C), task-from-follow-up (D), print
hardening (E).

## 1. Goal

Give managers and executives visibility of the network's asset value and maintenance spend:

- A **register valuation**: replacement cost new (RCN) and a condition-adjusted current value
  per asset, rolled up by region, family, asset type and location, with an explicit "unpriced"
  gap so the register never silently under-reports.
- **Maintenance cost reporting**: total spend, event counts and averages over a period, broken
  down by region/asset type/event type, plus a 12-month series.
- **Lightweight cost capture** so crews can record spend without a procurement workflow.
- Both surfaced as scoped, generated report types AND on a dedicated **Value & Cost** page with
  tabbed Valuation / Maintenance cost / Prices views.

## 2. Current state

- `asset_catalog` already carries `default_unit_price` and unit of measure; the seed
  (`backend/assetCatalog.js`) never populates prices, so they are all 0/NULL today. `TOWER_PARTS`
  rows are vocabulary for tower-component labels, deliberately excluded from the register
  population (`register.js:47`).
- Register counts live in `register.js:loadTree()`: scope per region, population excludes
  `lifecycle_status = 'REMOVED'`, and the count invariant is
  `counts.assets = counted.length + towerAssetByTower.size`.
- `asset_maintenance_event` already has `cost REAL` (db.js:147). Events are auto-created at task
  completion in `tasks.js:applyCompletionSideEffects` (no cost today) or inserted manually via
  `POST /maintenance-events` (`routes/assets.js:365`, body pass-through). Task transition payload
  is handled in `routes/tasks.js`; the completion fields are applied as a `patch`.
- `system_config` already seeds `currency` = `USD` (seed.js ~line 756); admin CRUD for
  `system_config` exists (`routes/admin.js`), so no new setting is required.
- Reports: `report_template` rows are seeded idempotently; `routes/reports.js:96` `switch`
  computes each type; `GET /report-templates` + `POST /reports/generate` drive the Reports page.
- Frontend: nav is a plain list in `App.jsx:buildNav()`; pages gate actions with `can()`; there
  is no chart library (CSS bar rows + tables are the established pattern). All strings go through
  i18n files.
- Spans store `km_from..km_to` on the `asset` row (db.js migrations); unit of measure `KM` means
  value quantity = length, all other units = 1.

## 3. Decisions (confirmed with user)

1. **Approach**: valuation reuses the register tree population/scope logic so values never drift
   from the register count invariant (rejected: a second, independent SQL-only aggregation).
2. **Cost capture is lightweight**: an optional numeric `cost` on (a) the task-completion flow
   and (b) manual maintenance events on the asset detail. No procurement/purchase model. The
   existing `cost` column is reused; no schema change.
3. **Currency**: reuse `system_config.currency` code; symbol derived from a shared formatter. No
   new setting, no per-region currency.
4. **Surface**: a dedicated **Value & Cost** page (`/value`) with Valuation, Maintenance cost and
   Prices tabs, PLUS scoped on-demand report types `ASSET_VALUATION` and `MAINTENANCE_COST` on the
   existing Reports page.
5. **Pricing**: prices are RCN benchmark values seeded per used catalog class (excluding
   `TOWER_PARTS`); editable by `asset:write` users via the Prices tab. Unpriced asset types are
   reported as an explicit gap.
6. **Demo/testability**: idempotent seeds add realistic catalog prices and a handful of
   cost-carrying maintenance events in the C1 demo so valuation and cost views are demonstrable
   in a clean database.

## 4. Data, pricing, cost capture

1. Seed realistic `default_unit_price` for each used catalog asset class in `assetCatalog.js`
   (prices already stored per row). `TOWER_PARTS` stays unpriced/excluded (not part of the
   valuation population).
2. No new tables/columns. Reuse `asset_catalog.default_unit_price`,
   `asset_maintenance_event.cost`, `system_config.currency`.
3. Cost capture points:
   - task completion: frontend completion modal gets an optional numeric `cost`; backend threads
     it from the transition patch into `applyCompletionSideEffects` and stores it on the
     auto-created `asset_maintenance_event`;
   - asset detail: manual "add maintenance event" form gains a `cost` input (POST body is
     pass-through already); event-history lists gain a cost column.

## 5. Computation & endpoints

1. **Valuation** (per scoped region, same population as `loadTree`):
   - per asset: `qty` = `1` (EA/PANEL/BANK/etc.) or `km_to - km_from` for `KM` assets;
     `rcn = default_unit_price * qty`; `current = rcn * (condition_rating / 10)`;
   - assets whose catalog class has no price are excluded from value totals and counted as
     `unpriced_count` (the gap); the endpoint also lists unpriced catalog types for the admin;
   - breakdowns: by region, family, asset type, location (substation/line/tower).
   - New `GET .../register/valuation?region_id=` returning totals + breakdowns + currency meta.
2. **Maintenance cost**:
   - `GET .../maintenance-cost?region_id=&from=&to=` returning total spend, event count, avg per
     event, by-region, by-asset/event-type, 12-month series (default trailing 12 months) and a
     recent-events list; scoped by region under the same rules as other asset endpoints.
3. **Reports**: seed templates `ASSET_VALUATION` and `MAINTENANCE_COST` (name + description) in
   `ensureReportTemplates`, and add `switch` cases in `routes/reports.js` producing scoped HTML
   that reuses the same computation helpers. No new report framework.

## 6. UI

1. New page **Value & Cost** at `/value`, nav item in a new management group, i18n'd, no new
   frontend dependencies (CSS bar rows + tables).
   - **Valuation tab**: region selector; summary cards (asset count, RCN, current value, unpriced
     count); CSS bars by region and family; tables by asset type and location.
   - **Maintenance cost tab**: period range defaulting to trailing 12 months; total-spend cards;
     monthly bar series; by-region and by-type tables; recent events list.
   - **Prices tab**: family → type editable rows for `default_unit_price` (saves via
     `PUT .../asset-catalog/:id`), currency symbol shown; save/edits gated by `asset:write`;
     currency itself remains an admin setting on the Settings page.
2. Register page: compact "Estimated register value" summary bar above the register tree.
3. Assets detail / task completion: cost inputs and cost column in event history.

## 7. Out of scope / future options

- Labor-cost estimation from crew hours (per-role rates) — explicitly deferred (user chose parts
  cost only this round).
- Depreciation curves / in-service-date aging adjustments; only condition-based write-down now.
- Per-region currencies and full procurement/purchase-order flow.

## 8. Verification expectations

- Valuation population count equals register tree/summary count for the same scope.
- C1 demo yields non-zero RCN/current totals and exactly zero unpriced assets (all demo types
  priced); unpriced-gap path covered by a deliberately unpriced legacy type if present.
- Cost report totals equal the sum of seeded event costs in period/scope.
- Backend isolated-DB smoke for both new report types + endpoints; frontend build passes; no new
  npm dependencies.
