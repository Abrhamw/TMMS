# Executive Command Center and Dynamic Asset Condition — Design

Status: approved (brainstorming complete)
Date: 2026-10-02
Sub-project: G (executive presentation, app-wide design system, and dynamic
asset condition evaluation)

## 1. Summary

This spec combines three connected capabilities delivered as one phased plan:

1. **Shared design system** — a reusable token + component layer applied across
   the whole web app, so the modern visual language is defined once and reused
   everywhere rather than restyled per page.
2. **Executive Command Center** — the web Executive Summary is rebuilt in the
   shape of the reference executive dashboard: hero band, KPI strip with
   trends, and Overview / Assets / Cost / Work / Workforce tabs, with a
   severity-ranked recommendation feed.
3. **Dynamic asset condition** — an evidence-and-performance based condition
   model. Assets gain operational readings (loading, thermal, oil) and
   performance events (through-faults, trips, overloads) from all available
   sources (manual entry, CSV/SCADA import, existing task/finding evidence). A
   transparent rule-based, per-family engine combines the existing age baseline
   with these time-based factors to produce an advisory combined rating, health
   index, remaining useful life and a recommended action. The asset page gains a
   what-if simulator, and the executive recommendations consume the resulting
   degradation signals.

The official `condition_rating` remains human-confirmed. The engine is
advisory: it suggests, the evaluator accepts or overrides.

## 2. Background

- `frontend/src/styles.css` holds a small token set (`--primary`, `--danger`,
  `--ok`, `--warn`, `--accent`, `--radius`, `--shadow`) and shared classes
  (`.card`, `.topbar`, tables, pills). There is one 1272-line stylesheet and no
  component-level styling layer.
- `frontend/src/components/InfraVisuals.jsx` provides `KpiTile`, `BarRow` and a
  three-segment `Donut`. Charts elsewhere are ad hoc bars.
- `frontend/src/pages/ExecutiveSummary.jsx` renders four sections (portfolio,
  assets, execution, people) from a single `GET /executive/summary` payload
  built in `backend/routes/dashboard.js`.
- `backend/assetCondition.js` computes health from asset age and condition only
  (`condFactor * 0.7 + ageFactor * 0.3`) and derives a suggested rating from
  maintenance evidence (failed tasks, checklist failures, findings, GPS
  mismatches, maintenance recency). `suggestAssetCondition()` is advisory; the
  evaluator confirms it via `POST /assets/:id/evaluation`.
- The asset table stores `condition_rating`, `health_index`,
  `remaining_useful_life_years`, `criticality`, `operational_status` and
  maintenance timestamps. It has no loading, fault or runtime data.
- `asset_maintenance_event` records `event_type` values PREVENTIVE, INSPECTION,
  CORRECTIVE, REPAIR, REPLACEMENT, EMERGENCY and a `cost`.
- Permissions are defined in `backend/auth.js`; `asset:evaluate` is part of
  `OPERATIONS_WORKFLOW`. The executive summary is limited to ADMIN and EXECUTIVE
  roles.
- Runtime is Node v22, which provides the built-in `node --test` runner. The
  backend has no test files and the frontend has no test runner; verification is
  `node --check`, live curl and `npm run build`.

## 3. Goals / Non-goals

Goals:

- Define the modern visual language once as tokens and reusable chart/UI
  components, and apply it across all web pages without changing page logic.
- Rebuild the Executive Summary as a Command Center with hero, KPI strip,
  region scope, print export, five tabs and a structured severity-ranked
  recommendation feed.
- Capture asset operational readings and performance events from manual entry,
  import and existing evidence, keyed and idempotent.
- Compute an advisory combined condition from the age baseline plus
  per-family performance factors, with each factor's contribution and reason
  visible and reproducible.
- Provide a what-if simulator that recomputes the score live and can be accepted
  as an evaluation.
- Feed dynamic degradation signals into the executive recommendations.

Non-goals (YAGNI):

- Auto-applying the computed score to `condition_rating` without human
  confirmation.
- Machine-learning or statistical prediction; this is a rule-based model.
- A configurable factor-weight tuning UI. Presets live in code.
- Live SCADA/relay streaming. Import is file/CSV based.
- Capturing readings or events from the mobile field app this round.
- Bespoke rework of every page's content; the app-wide work is a shared layer.

## 4. Architecture and phasing

Three phases, each independently shippable and committed. No phase leaves the
app in a broken state.

- **Phase A — Design system (frontend).** Extend tokens in
  `frontend/src/styles.css`; add shared components under
  `frontend/src/components/viz/`; restyle the shared shell (topbar, cards,
  tables, buttons, pills, modals, loading/empty) and adopt the components across
  pages. No data-flow changes.
- **Phase C — Dynamic asset condition (backend then frontend).** Additive
  tables and migrations in `backend/db.js`; a pure engine in
  `backend/assetPerformance.js`; endpoints in `backend/routes/assets.js`; asset
  UI and the what-if simulator.
- **Phase B — Executive Command Center.** Backend additions to
  `GET /executive/summary` and a new recommendation module; the rebuilt
  `ExecutiveSummary.jsx`. Phase B consumes Phase C's degradation feed and must
  tolerate an empty feed, so B may land before or after C.

No new runtime dependencies are introduced; charts are hand-rolled SVG/CSS to
keep the bundle small and the app offline-friendly.

## 5. Phase A — Shared design system

### 5.1 Tokens

Extend the `:root` block in `frontend/src/styles.css`. Existing tokens are kept
for compatibility. Added tokens:

- Surfaces and elevation: `--surface-1`, `--surface-2`, `--surface-3`,
  `--elev-1`, `--elev-2`.
- Spacing scale: `--space-1` through `--space-8`.
- Type scale: `--text-xs`, `--text-sm`, `--text-base`, `--text-lg`,
  `--text-xl`, `--text-2xl`.
- Status and severity: `--severity-high` (#dc2626), `--severity-medium`
  (#d97706), `--severity-low` (#0e7490); keep `--ok`, `--warn`, `--danger`.
- Chart palette: `--chart-1` through `--chart-6`.
- Hero: `--hero-gradient`.
- Radii: `--radius-sm`, `--radius-lg`; plus a focus-ring token.

### 5.2 Components

New directory `frontend/src/components/viz/` exports:

- `Gauge` — SVG arc 0–100 with a center value, label and colour band.
- `Donut` — segments with center value and a legend; replaces the ad hoc donut
  while preserving its call shape.
- `StackedBar` — labelled segments with totals.
- `TrendLine` / `Sparkline` — small time-series line for KPI tiles and trends.
- `ProgressRing` — compact percentage ring.
- `SeverityBadge` — high/medium/low pill.
- `SectionCard` — titled panel wrapper.
- `Tabs` — accessible `role="tablist"` control used by the executive page.
- `EmptyState` and `Skeleton` — shared empty/loading presentations.

`InfraVisuals.jsx` (`KpiTile`, `BarRow`) is upgraded to the new tokens. Existing
consumers continue to work through unchanged signatures.

### 5.3 Adoption

Shared shell classes and component swaps carry the new language across pages
without touching page logic. Adoption is checked with the existing SSR harness
and a manual visual pass, and by `npm run build`.

## 6. Phase B — Executive Command Center

### 6.1 Backend

`GET /executive/summary` in `backend/routes/dashboard.js` is extended
additively. All existing top-level fields remain so current consumers are not
broken. Added fields:

- `hero` — `{ generated_at, scope, regions: [{ id, name }] }`.
- `kpis[]` — `{ key, label, value, sub, tone, spark[] }` for asset population
  and value, condition health (mean health index across assessed assets),
  open/overdue work, 12-month spend and workforce readiness.
- `cost_composition` — spend grouped as Planned (PREVENTIVE, INSPECTION),
  Unplanned (CORRECTIVE, REPAIR), Emergency (EMERGENCY) and Capital
  (REPLACEMENT), with totals.
- `trends` — 12-month spend and condition series.
- `degradation_attention[]` — top-N assets by degradation (from Phase C); empty
  if no performance data exists.
- `workforce_readiness` — headcount, crew availability and certification
  readiness roll-up.
- `recommendations[]` — structured `{ id, severity, title, detail, action,
  link, metric }`, replacing the current list of strings while keeping a plain
  `recommendation_text` array for compatibility.

An optional `?region=<id>` query filters the summary to one region; omitting it
keeps the current all-regions behaviour.

### 6.2 Recommendation engine

New `backend/executiveRecommendations.js` combines current signals (overdue
work, low condition, certification expiry, equipment gaps, cost concentration)
with dynamic signals from Phase C (accelerated degradation, overload or
through-fault exposure, renewal candidates). Each recommendation has a severity
of high, medium or low, a title, a detail, a suggested action, a link to the
relevant record and the metric that triggered it. Ordering is by severity then
impact. The module is pure given its inputs and unit-tested with
`node --test`.

### 6.3 Frontend

`frontend/src/pages/ExecutiveSummary.jsx` is rebuilt:

- Hero band: title, generated-at, region scope selector, live status dot and an
  Export view action that triggers print with print CSS.
- KPI strip: tiles from `kpis[]`, each with tone and optional sparkline.
- Tabs: Overview, Assets, Cost, Work, Workforce.
  - Overview: hero, KPI strip, condition donut, degradation attention list and
    top recommendations.
  - Assets: asset mix, condition distribution, condition-adjusted value,
    dynamic condition attention and lifecycle.
  - Cost: composition stacked bar, monthly trend, spend-to-value and spend by
    region, class and owner.
  - Work: task status, schedule frequency, overdue work, crew workload and
    recent work orders.
  - Workforce: people and crews, certification readiness, and equipment gaps.
- Recommendation cards use `SeverityBadge` and link to their records; all data
  is read from the single summary payload.

## 7. Phase C — Dynamic asset condition

### 7.1 Data model

Additive tables and migrations in `backend/db.js`:

- `asset_reading(id, asset_id, reading_type, value_num, unit, recorded_at,
  source, recorded_by, task_id, client_ref, notes)` — time-series operational
  readings. `source` is MANUAL, IMPORT or DEVICE.
- `asset_performance_event(id, asset_id, event_type, severity, occurred_at,
  magnitude, duration_min, source, recorded_by, task_id, client_ref, notes)` —
  discrete performance events.
- Extend the existing `asset_health_snapshot` additively with `base_rating`,
  `performance_delta`, `degradation_rate`, `factors_json`, `model_version` and
  `created_by`. The existing `condition_rating` (from), `suggested_rating` (the
  combined rating), `health_index`, `remaining_useful_life_years`,
  `recommendation`, `reasons`, `source` and `report_id` columns already cover
  the rest, so no new snapshot table is introduced. `source` values used by the
  dynamic model are AUTO, WHATIF and EVALUATION (the monitor already writes
  AGENT).

Indexes on `asset_reading(asset_id, recorded_at)` and
`asset_performance_event(asset_id, occurred_at)`. `client_ref` is unique when
present, enabling idempotent retries and imports.

Controlled vocabularies (version 1):

- Readings: `LOAD_PCT`, `AMBIENT_C`, `TOP_OIL_C`, `WINDING_C`, `DGA_H2_PPM`,
  `DGA_CH4_PPM`, `MOISTURE_PPM`, `POWER_FACTOR`, `VOLTAGE_DEV_PCT`, `RUN_HOURS`,
  `VIBRATION_MM_S`, `PD_PC`, `OIL_DIELECTRIC_KV`.
- Events: `THROUGH_FAULT`, `TRIP`, `OVERLOAD`, `OIL_LEAK`, `PARTIAL_DISCHARGE`,
  `TEMP_ALARM`, `CORROSION_SEVERE`, `ENVIRONMENTAL`.
- Event severity: LOW, MEDIUM, HIGH, CRITICAL.

### 7.2 Engine

New `backend/assetPerformance.js` exposes pure functions. The primary entry is:

`evaluatePerformance(asset, readings, events, { now })` returns
`{ base_rating, performance_delta, combined_rating, health_index, rul_years,
degradation_rate, factors: [{ key, label, value, contribution, weight, reason }],
confidence, recommendation, reasons }`.

- The base rating reuses `assetCondition.ageBaseline(ageYears)`.
- Per-family presets map `asset_type` to a factor set. Examples: power
  transformer — loading, thermal, DGA, through-faults/trips, maintenance
  recency, environment; circuit breaker — trips, through-faults, operations;
  line or conductor — loading, clearance, faults; tower — corrosion,
  environment.
- Loading and event factors use rolling windows (30, 90, 365 days) with recency
  decay on discrete events. Each factor contributes a bounded delta with a
  human-readable reason; contributions are summed and clamped so the combined
  rating stays in 1–10.
- Sign convention: `performance_delta` is negative when performance evidence
  degrades the asset and zero or positive when it does not; `combined_rating` is
  `clamp(base_rating + performance_delta, 1, 10)`. `degradation_rate` is rating
  points per year.
- `magnitude` and `duration_min` on an event are optional and event-specific
  (for example fault current in kA, or overload in MW); the engine uses them
  only where a factor defines a scale, otherwise it counts the event.
- `degradation_rate` expresses the change per year implied by the performance
  factors, used by the executive attention list.
- `confidence` is HIGH when recent, relevant readings or events exist, LOW when
  data is sparse.
- With no readings and no events the output reproduces the current age-based
  numbers exactly, so existing behaviour is unchanged.

`suggestAssetCondition(asset)` in `backend/assetCondition.js` is extended to
merge the performance factors with the existing evidence score. It stays
advisory, monotonic and rerunnable (re-running without new data yields the same
number).

### 7.3 API

All write and simulate endpoints require `asset:evaluate`; reads require
`asset:read`.

- `GET /assets/:id/performance` — readings, events, the computed breakdown,
  and snapshot trend.
- `POST /assets/:id/readings` — add a reading.
- `POST /assets/:id/performance-events` — add an event.
- `POST /assets/:id/performance/simulate` — what-if recompute, nothing
  persisted.
- `POST /assets/:id/performance/snapshots` — persist a snapshot with
  `source=AUTO` or `WHATIF`.
- `POST /assets/performance/import` — CSV import with `dry_run` preview;
  idempotent by `client_ref` or natural key; per-row errors are reported and bad
  rows skipped.
- `POST /assets/:id/evaluation` — extended to accept the combined score, write
  the authoritative rating and store an `EVALUATION` snapshot.
- `GET /executive/degradation` — top-N degradation attention for Phase B.

### 7.4 Asset UI and what-if simulator

The asset detail page gains a "Condition & Performance" section:

- Combined gauge with the current rating and health index.
- A base-versus-performance contribution bar showing how much of the score
  comes from age/nameplate versus real-time factors.
- A factor table listing each factor, its value, weight, contribution and
  reason.
- Remaining useful life and a reading/snapshot trend line.
- Forms to add readings and performance events, and a CSV import with preview.

The what-if simulator provides sliders for load percent, ambient/thermal,
through-faults, trips, age and months since maintenance, plus environment. It
recomputes live (debounced through the simulate endpoint) and shows the delta
against the current score and the recommended action. Actions are Accept as
evaluation, Reset, and Save scenario (persists a `WHATIF` snapshot). An advisory
banner states that the official rating changes only on accept.

### 7.5 Integration with the asset-condition monitor

The existing `backend/assetMonitor.js` already performs advisory revaluation,
appends a change-log row to `asset_health_snapshot` only when the rating or
recommendation moves, and exposes `/asset-monitor` (summary plus recent
changes) and `/asset-monitor/run`. The dynamic model plugs into it rather than
duplicating it:

- `candidateAssets()` additionally includes assets that have readings or
  performance events, so they participate in scheduled revaluation.
- `revalueAssets()` uses the extended `suggestAssetCondition()` (age baseline
  plus performance factors) and writes the new snapshot columns. Change
  detection and the idempotent "only when it moves" rule are unchanged.
- `GET /executive/degradation` is a thin read over `recentRevaluationData()`
  plus the current performance breakdown, returning the top-N assets by
  degradation for Phase B; no second history store is created.

## 8. Errors, permissions and edge cases

- Permissions: reads `asset:read`; readings, events, simulate, import,
  snapshots and evaluation `asset:evaluate`; executive ADMIN/EXECUTIVE.
- Validation: reading and event types must be in the vocabulary; numeric values
  bounded; dates ISO-8601; unknown types rejected with a clear error. Import
  returns per-row outcomes and never partially applies a row.
- Idempotency: `client_ref` uniqueness makes mobile and import retries safe.
- Sparse data: LOW confidence, no penalty from missing factors; the engine must
  not invent a trend from a single point.
- Determinism: given the same inputs and clock, the engine returns the same
  result; suggestions never ratchet downward on re-run.
- Performance: batch queries by asset id, avoid N+1, bound rolling windows,
  index the new tables. Migrations are additive and idempotent.
- Compatibility: the executive summary keeps all existing fields; the
  condition suggestion with no performance data matches today's output.

## 9. Testing and verification

- Backend: `node --check` on every changed file; `node --test` unit tests for
  the engine, family presets, cost-composition classification and
  recommendation ranking; live curl for reading/event CRUD, simulate, import,
  snapshot and evaluation.
- Frontend: `npm run build` and the existing SSR harness (for SSR-safe
  rendering) plus a manual visual pass of every page for the design system.
- Regression: confirm `/executive/summary` still returns the original fields,
  and that an asset with no readings/events yields the current suggestion.
- Commits: one per phase, explicit paths only. Never `git add -A`; never commit
  `backend/tmms.db*`, `backend/uploads/`, `dist/` or `design/`.

## 10. Phasing summary

| Phase | Scope | Key files |
|-------|-------|-----------|
| A | Tokens and shared viz components; app-wide adoption | `frontend/src/styles.css`, `frontend/src/components/viz/*`, `InfraVisuals.jsx` |
| C | Tables, engine, endpoints, monitor integration, asset UI, what-if | `backend/db.js`, `backend/assetPerformance.js`, `backend/assetCondition.js`, `backend/assetMonitor.js`, `backend/routes/assets.js`, asset page |
| B | Executive backend fields, recommendation engine, Command Center UI | `backend/routes/dashboard.js`, `backend/executiveRecommendations.js`, `frontend/src/pages/ExecutiveSummary.jsx` |

## 11. Open questions

None outstanding; all scoping decisions were resolved during brainstorming.
