# Executive Command Center and Dynamic Asset Condition — Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`.

**Goal:** Add a shared app-wide design system, rebuild the Executive Summary as a Command Center, and add a dynamic, advisory, what-if asset condition model driven by age, operational readings and performance events from all available sources.

**Architecture:** A frontend token + component layer reused by every page. Backend gains two additive time-series tables and extends the existing `asset_health_snapshot` change-log; a pure `assetPerformance.js` engine produces a combined rating from the existing age baseline plus per-family performance factors. The existing `assetMonitor.js` revaluation agent is extended to consume the new factors. The executive page reads one extended `/executive/summary` payload.

**Tech Stack:** Node >=22 (`node:sqlite`, `node --test`), Express 5, React (Vite) SPA, Leaflet. Verify via `node --check`, `node --test`, live curl, and `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-02-executive-command-center-and-dynamic-asset-condition-design.md`

## Global Constraints

- Schema changes are additive via `migrate()` in `backend/db.js`; never rewrite or delete data.
- `backend/assetPerformance.js` stays pure (no DB, no Express); it is unit-tested with `node --test`.
- The model is advisory: it must never write `asset.condition_rating` directly. Only `POST /assets/:id/evaluation` changes the stored rating.
- With no readings and no events, `suggestAssetCondition()` must return exactly today's output.
- New write endpoints require `asset:evaluate`; reads require `asset:read`; executive stays ADMIN/EXECUTIVE.
- `client_ref` uniqueness makes retries and imports idempotent; use `byClientRef()` from `backend/util.js`.
- No code comments (repo convention). No new runtime npm dependencies.
- Every mutating route keeps `audit()`. Stage explicit paths only.

## File Structure

- `frontend/src/styles.css` — tokens and app-wide shell styling.
- `frontend/src/components/viz/` — new chart/UI primitives.
- `frontend/src/components/InfraVisuals.jsx` — upgraded KPI/bar primitives.
- `frontend/src/pages/ExecutiveSummary.jsx` — Command Center.
- `frontend/src/pages/Assets.jsx` — Condition & Performance section and what-if simulator.
- `backend/db.js` — new tables, extended snapshot columns, indexes.
- `backend/assetPerformance.js` — new pure engine and vocabularies.
- `backend/assetCondition.js` — merge performance factors into the suggestion.
- `backend/assetMonitor.js` — candidate selection and snapshot writes.
- `backend/routes/assets.js` — performance/readings/events/simulate/import endpoints.
- `backend/executiveRecommendations.js` — new recommendation engine.
- `backend/routes/dashboard.js` — extended `/executive/summary` and `/executive/degradation`.
- `backend/test/assetPerformance.test.js`, `backend/test/executiveRecommendations.test.js` — unit tests.

## Phase A — Shared design system

### Task A1: Design tokens

- Modify: `frontend/src/styles.css` (`:root` block).

- [ ] Step 1: Add tokens while keeping all existing ones: surfaces and elevation (`--surface-1/2/3`, `--elev-1/2`), spacing (`--space-1`..`--space-8`), type scale (`--text-xs`..`--text-2xl`), severity (`--severity-high: #dc2626`, `--severity-medium: #d97706`, `--severity-low: #0e7490`), chart palette (`--chart-1`..`--chart-6`), `--hero-gradient`, `--radius-sm`, `--radius-lg` and a focus-ring token.
- [ ] Step 2: `npm run build` (in `frontend`) passes.

### Task A2: Shared viz components

- Create: `frontend/src/components/viz/` files; Modify: `frontend/src/components/InfraVisuals.jsx`.

- [ ] Step 1: Add `Gauge.jsx` (SVG arc 0-100 with center value, label, colour band), `Donut.jsx` (segments with center value and legend), `StackedBar.jsx` (labelled segments and total), `Sparkline.jsx` and `TrendLine.jsx` (small time series), `ProgressRing.jsx`, `SeverityBadge.jsx`, `SectionCard.jsx`, `Tabs.jsx` (accessible `role="tablist"`), `EmptyState.jsx`, `Skeleton.jsx`.
- [ ] Step 2: Reimplement `InfraVisuals.jsx` `KpiTile` and `BarRow` on the new tokens, keeping their current props so existing callers are unchanged.
- [ ] Step 3: `npm run build` passes; the existing SSR harness renders the new components server-side without touching `window`.

### Task A3: App-wide adoption

- Modify: page/shared class usage in `frontend/src/styles.css` and, where a shared component replaces ad hoc markup, the affected page files.

- [ ] Step 1: Restyle the shared shell via tokens: `.topbar`, `.card`, tables, buttons, `.pill`, modals, and the loading/empty states. Preserve class names so no page logic changes.
- [ ] Step 2: Swap ad hoc KPI/bar/donut markup on the highest-traffic pages (Home, Assets, ExecutiveSummary, reports) to the shared components.
- [ ] Step 3: Add print CSS (`@media print`) hiding chrome and `.no-print`, used by the executive Export view.
- [ ] Step 4: `npm run build` passes; do a manual visual pass of every top-level page on the dev server.

### Task A4: Phase A verification and commit

- [ ] Step 1: `node --check` is not needed (no backend change); confirm no console errors on each page.
- [ ] Step 2: Stage and commit explicit paths, e.g. `git add frontend/src/styles.css frontend/src/components/viz frontend/src/components/InfraVisuals.jsx` plus any page files touched.

## Phase C — Dynamic asset condition

### Task C1: Schema

- Modify: `backend/db.js`.

- [ ] Step 1: Add inside `initSchema()`:
  ```sql
  CREATE TABLE IF NOT EXISTS asset_reading (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES asset(id),
    reading_type TEXT NOT NULL,
    value_num REAL NOT NULL,
    unit TEXT,
    recorded_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'MANUAL',
    recorded_by INTEGER REFERENCES person(id),
    task_id INTEGER REFERENCES task(id),
    client_ref TEXT,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS asset_performance_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES asset(id),
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    occurred_at TEXT NOT NULL,
    magnitude REAL,
    duration_min REAL,
    source TEXT NOT NULL DEFAULT 'MANUAL',
    recorded_by INTEGER REFERENCES person(id),
    task_id INTEGER REFERENCES task(id),
    client_ref TEXT,
    notes TEXT
  );
  ```
- [ ] Step 2: Extend the snapshot table via `migrate()`: `base_rating`, `performance_delta`, `degradation_rate`, `factors_json`, `model_version`, `created_by` on `asset_health_snapshot`.
- [ ] Step 3: Add indexes after the migrate calls: `idx_asset_reading_asset (asset_id, recorded_at)`, `idx_asset_event_asset (asset_id, occurred_at)`, and unique partial indexes on `asset_reading(client_ref)` and `asset_performance_event(client_ref)` where not null.
- [ ] Step 4: `node --check backend/db.js`; boot once and confirm the tables and snapshot columns exist via `PRAGMA table_info`.

### Task C2: Performance engine

- Create: `backend/assetPerformance.js`; Create: `backend/test/assetPerformance.test.js`.

- [ ] Step 1: Export `READING_TYPES` and `EVENT_TYPES` arrays exactly matching the spec vocabularies, plus `EVENT_SEVERITIES`.
- [ ] Step 2: Implement a `FAMILY_PRESETS` map from `asset_type` to a factor list; each factor declares `key`, `label`, `weight` and an evaluation function over readings/events. Cover at least transformer, breaker, line/conductor and tower families; unknown families fall back to a generic recency factor.
- [ ] Step 3: Implement `evaluatePerformance(asset, readings, events, { now } = {})` returning `{ base_rating, performance_delta, combined_rating, health_index, rul_years, degradation_rate, factors, confidence, recommendation, reasons }`. Reuse `ageBaseline` for `base_rating`; clamp `combined_rating` to 1-10; `performance_delta` is negative for degradation. Use rolling 30/90/365-day windows and recency decay for events.
- [ ] Step 4: With empty `readings` and `events`, assert the result equals the current age-based numbers.
- [ ] Step 5: `node --test backend/test/assetPerformance.test.js` passes; `node --check backend/assetPerformance.js`.

### Task C3: Merge into the suggestion

- Modify: `backend/assetCondition.js`.

- [ ] Step 1: `suggestAssetCondition(asset)` loads the asset's readings and events and calls `evaluatePerformance`, merging `performance_delta` with the existing evidence score before clamping. Add each performance factor reason to `reasons`, and expose `base_rating`, `performance_delta`, `combined_rating`, `degradation_rate` and `factors` on the returned object.
- [ ] Step 2: Assert the no-data path is byte-for-byte identical to the current output (same `suggested_rating`, `health_index`, `recommendation`).
- [ ] Step 3: `node --check backend/assetCondition.js`; run `node --test` for the engine and confirm no regression.

### Task C4: Performance API

- Modify: `backend/routes/assets.js`.

- [ ] Step 1: Import `byClientRef` from `../util`, `evaluatePerformance` and the vocabularies from `../assetPerformance`, and `parseCsv`/`pick` from `../infraImport`.
- [ ] Step 2: `GET /assets/:id/performance` — `asset:read` plus scope check; return readings, events, the computed breakdown and the snapshot trend.
- [ ] Step 3: `POST /assets/:id/readings` and `POST /assets/:id/performance-events` — `asset:evaluate`; validate type against the vocabulary, numeric value/severity, and ISO date; idempotent via `byClientRef`; `audit()`; return the recomputed breakdown.
- [ ] Step 4: `POST /assets/:id/performance/simulate` — `asset:evaluate`; computes from supplied hypothetical inputs plus stored data, persists nothing.
- [ ] Step 5: `POST /assets/:id/performance/snapshots` — `asset:evaluate`; insert a snapshot row with `source=AUTO|WHATIF` and the new columns.
- [ ] Step 6: `POST /assets/performance/import` — `asset:evaluate`; parse CSV via `parseCsv`, support `dry_run` preview, report per-row outcomes, skip bad rows, idempotent by `client_ref` or a natural key (asset_code + kind + type + date).
- [ ] Step 7: `node --check backend/routes/assets.js`; live curl with the admin token for reading/event CRUD, simulate, snapshot and a dry-run import.

### Task C5: Extend evaluation

- Modify: `backend/routes/assets.js` (`POST /assets/:id/evaluation`).

- [ ] Step 1: When `use_suggested` is set, use the merged suggestion (which now includes performance). Accept an explicit `combined: true` to record the performance-inclusive score, and always write an `EVALUATION` snapshot row carrying the breakdown.
- [ ] Step 2: `node --check`; live curl an evaluation and confirm the snapshot row and the updated `condition_rating`.

### Task C6: Asset UI — Condition & Performance

- Modify: `frontend/src/pages/Assets.jsx` (import `Gauge`, `Donut`, `Sparkline`/`TrendLine`, `SeverityBadge`, `SectionCard` from the Phase A components).

- [ ] Step 1: In the asset detail view, add a "Condition & Performance" section: combined gauge, a base-versus-performance contribution bar, a factor table (factor, value, weight, contribution, reason), remaining useful life and a reading/snapshot trend line.
- [ ] Step 2: Add forms to record a reading and a performance event, and a CSV import that first calls the endpoint with `dry_run` and shows a preview before applying.
- [ ] Step 3: Show an advisory banner: the official rating changes only when an evaluator accepts.
- [ ] Step 4: `npm run build` passes; exercise against the running dev server.

### Task C7: What-if simulator

- Modify: `frontend/src/pages/Assets.jsx`.

- [ ] Step 1: Add a simulator panel with sliders for load percent, ambient/thermal, through-faults, trips, age and months since maintenance, plus an environment select.
- [ ] Step 2: On change, debounce a call to `/assets/:id/performance/simulate` and show the simulated rating, the delta against the current score and the recommended action.
- [ ] Step 3: Actions: Accept as evaluation (calls `/evaluation` then refreshes), Reset, and Save scenario (`source=WHATIF`).
- [ ] Step 4: `npm run build` passes; verify the delta updates live in the running app.

### Task C8: Monitor integration

- Modify: `backend/assetMonitor.js`.

- [ ] Step 1: Extend `candidateAssets()` to also include assets with rows in `asset_reading` or `asset_performance_event`.
- [ ] Step 2: Extend the snapshot `INSERT` to write `base_rating`, `performance_delta`, `degradation_rate`, `factors_json` and `model_version`; keep the "only when the rating or recommendation moves" rule.
- [ ] Step 3: `node --check backend/assetMonitor.js`; run `POST /asset-monitor/run` with a token and confirm new columns populate for an asset with readings.

### Task C9: Executive degradation feed

- Modify: `backend/routes/dashboard.js` (new route) or `backend/routes/reports.js`.

- [ ] Step 1: `GET /executive/degradation` — ADMIN/EXECUTIVE; read `recentRevaluationData()` plus the current performance breakdown and return the top-N assets by negative `performance_delta`/`degradation_rate`, each with code, name, region, rating, delta and recommendation. Return an empty list when no performance data exists.
- [ ] Step 2: `node --check`; live curl and confirm the shape, including the empty case.

### Task C10: Phase C verification and commit

- [ ] Step 1: `node --check` every touched backend file; `node --test` all backend tests.
- [ ] Step 2: Regression: an asset with no readings/events yields the same suggestion as before; `/asset-monitor` still returns its summary.
- [ ] Step 3: `npm run build` (frontend) and a manual pass of the asset detail page.
- [ ] Step 4: Stage explicit paths and commit.

## Phase B — Executive Command Center

### Task B1: Recommendation engine

- Create: `backend/executiveRecommendations.js`; Create: `backend/test/executiveRecommendations.test.js`.

- [ ] Step 1: Implement `buildRecommendations(summaryInputs, { now })` returning an ordered array of `{ id, severity, title, detail, action, link, metric }`. Cover current signals (overdue work, low condition, certification expiry, equipment gaps, cost concentration) and dynamic signals (accelerated degradation, overload/through-fault exposure, renewal candidates).
- [ ] Step 2: Order by severity (high, medium, low) then impact; deduplicate by `id`.
- [ ] Step 3: `node --test backend/test/executiveRecommendations.test.js` passes.

### Task B2: Extend the executive summary backend

- Modify: `backend/routes/dashboard.js`.

- [ ] Step 1: Keep every existing top-level field. Add `hero` (`generated_at`, `scope`, `regions`), `kpis[]` (`key`, `label`, `value`, `sub`, `tone`, `spark`), `cost_composition` (Planned = PREVENTIVE + INSPECTION; Unplanned = CORRECTIVE + REPAIR; Emergency = EMERGENCY; Capital = REPLACEMENT), `trends` (12-month spend and condition), `degradation_attention[]` (from Task C9), `workforce_readiness`, and structured `recommendations[]` from Task B1 while keeping a plain `recommendation_text` array.
- [ ] Step 2: Support optional `?region=<id>` to filter to one region; omit it for all regions.
- [ ] Step 3: `node --check`; live curl and confirm old and new fields coexist; test with and without `?region`.

### Task B3: Command Center UI

- Modify: `frontend/src/pages/ExecutiveSummary.jsx` (use Phase A components).

- [ ] Step 1: Replace the header with a hero band: title, generated-at, region scope selector, live status dot and an Export view button that calls `window.print()`.
- [ ] Step 2: Add the KPI strip from `kpis[]`, each tile with tone and optional sparkline.
- [ ] Step 3: Replace the four sections with tabs **Overview / Assets / Cost / Work / Workforce** using the `Tabs` component, mapping existing data into each tab as described in the spec; render recommendations as severity cards that link to their records.
- [ ] Step 4: `npm run build` passes; manual visual pass on the dev server for both an all-regions and a single-region scope.

### Task B4: Phase B verification and commit

- [ ] Step 1: `node --check` the backend files; `node --test`.
- [ ] Step 2: Confirm `/executive/summary` old fields are intact for any other consumer.
- [ ] Step 3: `npm run build`; manual pass of all five tabs.
- [ ] Step 4: Stage explicit paths and commit.

### Task B5: Final integration verification

- [ ] Step 1: Backend live: pick an asset with evidence, add a load reading and a through-fault event, confirm the performance breakdown, run a what-if simulate, accept it as an evaluation, confirm the stored rating and the `EVALUATION` snapshot.
- [ ] Step 2: Run `POST /asset-monitor/run` and confirm the extended snapshot columns populate.
- [ ] Step 3: Confirm `/executive/summary` `degradation_attention` and `recommendations` reflect the new data; confirm the Command Center renders them.
- [ ] Step 4: `node --check` every touched backend file; `node --test`; `npm run build`.
- [ ] Step 5: If any task from an earlier phase was skipped or left partial, finish it here, then commit and push.

## Self-Review Notes

- Spec coverage: design system (A1-A3), schema (C1), engine (C2), suggestion merge (C3), API (C4), evaluation (C5), asset UI (C6), what-if (C7), monitor integration (C8), degradation feed (C9), recommendations (B1), summary backend (B2), Command Center (B3), integration (B5).
- Preserved behaviour: no-data suggestion identical; `/asset-monitor` unchanged in shape; `/executive/summary` existing fields retained; existing chart/component props unchanged.
- Deferred (spec non-goals): auto-applied ratings, ML, weight-tuning UI, live SCADA streaming, mobile capture.
