# System Simplification - Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Simplify TMMS presentation to four areas (Dashboard, Assets, Work, Admin) with basic visualizations and server-side aggregates, so the database stays the system of record but is not all displayed at once.

**Architecture:** A new pure `backend/summary.js` aggregation module backs four additive read-only endpoints. Existing list endpoints gain backward-compatible pagination. The React SPA is reorganized around four areas with redirects from old routes, reusing the existing detail pages and `components/viz` primitives.

**Tech Stack:** Node >=22 (`node:sqlite`, `node --test`), Express 5, React (Vite) SPA. Verify via `node --check`, `node --test`, live curl, and `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-02-system-simplification-design.md`

## Global Constraints

- The database is the system of record. No destructive SQL. Deprecate in code only; hand the user SQL for any physical removal.
- `backend/summary.js` is pure (no DB, no Express) and unit-tested with `node --test`.
- Endpoints are additive: existing response shapes must not change when the new parameters are absent.
- Pagination: when `page` is absent, list endpoints return the current array exactly as today; when present, `{ items, total, page, page_size }`.
- Permission: summaries require an authenticated user and are scoped with the existing `commandScope`; Admin area stays admin/executive only.
- No new runtime npm dependencies. No code comments (repo convention).
- Reuse the existing design tokens and `frontend/src/components/viz` primitives.
- Stage explicit paths only.

## File Structure

- `backend/summary.js` - new pure aggregation helpers.
- `backend/test/summary.test.js` - unit tests for the helpers.
- `backend/routes/dashboard.js` - new `/dashboard/summary`, `/assets/summary`, `/work/summary`, `/reports/summary`.
- `backend/util.js` - shared pagination parser.
- `backend/routes/assets.js`, `backend/routes/tasks.js` (or equivalent), `backend/routes/register.js` - wire pagination.
- `frontend/src/App.jsx` - four-area navigation and routes/redirects.
- `frontend/src/pages/Dashboard.jsx` - new Dashboard screen.
- `frontend/src/pages/AssetsHub.jsx` - Assets area with Overview / Infrastructure / Register tabs.
- `frontend/src/pages/WorkHub.jsx` - Work area tabs.
- `frontend/src/pages/AdminHub.jsx` - Admin area tabs.
- `frontend/src/components/DataList.jsx` - shared paginated list pattern.
- `frontend/src/styles.css` - hub/tab/list styling as needed.

## Phase S - Backend aggregates

### Task S1: Aggregation helpers (TDD)

- Create: `backend/test/summary.test.js`.
- Create: `backend/summary.js`.

- [ ] Step 1: Write failing tests for `conditionDistribution(assets)`, returning `{ critical, poor, fair, good }` with the existing 1-3 / 4-5 / 6-7 / 8-10 buckets, ignoring null ratings.
- [ ] Step 2: Write failing tests for `costComposition(byEventType)` mapping PREVENTIVE+INSPECTION -> planned, CORRECTIVE+REPAIR -> unplanned, EMERGENCY -> emergency, REPLACEMENT -> capital, returning `{ total, buckets[] }`.
- [ ] Step 3: Write failing tests for `fillMonths(rows, now, { months: 12, key, value })` producing exactly 12 month-keyed entries with zero fill.
- [ ] Step 4: Write failing tests for `crewReadiness(crews)` and `certificationReadiness(certs, now)` returning percentages and counts.
- [ ] Step 5: `node --test "test/summary.test.js"` fails for the right reason.
- [ ] Step 6: Implement the helpers minimally until green. Keep them pure.
- [ ] Step 7: `node --check backend/summary.js`; `node --test "test/summary.test.js"` passes.

### Task S2: Dashboard summary endpoint

- Modify: `backend/routes/dashboard.js`.

- [ ] Step 1: Extract the existing `/executive/summary` aggregation into reusable local functions so `/dashboard/summary` can share them; keep `/executive/summary` output unchanged.
- [ ] Step 2: Add `GET /dashboard/summary` (authenticated, `commandScope`-scoped, optional `?region=`): `hero`, `kpis[]`, `condition`, `trends`, `degradation_attention[]`, `recommendations[]`, `generated_at`, `scope`.
- [ ] Step 3: `node --check backend/routes/dashboard.js`; live curl as admin and confirm the shape.

### Task S3: Assets summary endpoint

- Modify: `backend/routes/dashboard.js`.

- [ ] Step 1: Add `GET /assets/summary` (authenticated, scoped): population by class/family/region, condition distribution, valuation totals, top degradation.
- [ ] Step 2: `node --check`; live curl.

### Task S4: Work summary endpoint

- Modify: `backend/routes/dashboard.js`.

- [ ] Step 1: Add `GET /work/summary` (authenticated, scoped): task counts by status/type/priority, overdue, schedule frequency, crew availability, certification readiness.
- [ ] Step 2: `node --check`; live curl.

### Task S5: Reports summary endpoint

- Modify: `backend/routes/dashboard.js`.

- [ ] Step 1: Add `GET /reports/summary` (authenticated, scoped): cost composition, monthly spend, spend by region/class/owner, valuation by class.
- [ ] Step 2: `node --check`; live curl.

### Task S6: Pagination parameters

- Modify: `backend/util.js`, `backend/routes/assets.js`, `backend/routes/tasks.js` (or the actual task route file), `backend/routes/register.js`.

- [ ] Step 1: Add `parsePage(query)` in `backend/util.js` returning `{ page, pageSize, q, sort, paginated }`.
- [ ] Step 2: In each list route, when `paginated`, slice and return `{ items, total, page, page_size }`; otherwise return the current array.
- [ ] Step 3: Live curl each route with and without `page` to confirm both shapes.

### Task S7: TTL cache

- Modify: `backend/routes/dashboard.js`.

- [ ] Step 1: Add a small in-memory TTL cache (20s) keyed by scope + region, wrapping the four summary handlers.
- [ ] Step 2: Confirm repeated calls return identical payloads and that scope keys do not collide across users.

### Task S8: Phase S verification and commit

- [ ] Step 1: `node --test "test/*.test.js"` all pass; `node --check` touched files.
- [ ] Step 2: Capture response sizes before/after for `/assets` to show the over-fetch improvement.
- [ ] Step 3: Stage explicit paths and commit.

## Phase N - App shell and navigation

### Task N1: Navigation

- Modify: `frontend/src/App.jsx`.

- [ ] Step 1: Rebuild `buildNav` to Home, Mailbox, then Dashboard, Assets, Work, and Admin (admin/executive only).
- [ ] Step 2: `npm run build`.

### Task N2: Routes and redirects

- Modify: `frontend/src/App.jsx`.

- [ ] Step 1: Add routes `/dashboard`, `/assets/*`, `/work/*`, `/admin/*`.
- [ ] Step 2: Redirect old paths (`/overview` -> `/dashboard`, `/lines` -> `/assets/infrastructure`, `/substations`, `/towers`, `/regions` -> `/assets/infrastructure`, `/reports` -> `/admin/reports`, `/value` -> `/admin/value`, `/gps`, `/validation`, `/model` -> `/admin/tools`) so deep links keep working.
- [ ] Step 3: `npm run build`; verify each old path resolves.

### Task N3: Phase N verification and commit

- [ ] Step 1: Manual pass of the sidebar per role (admin, executive, crew).
- [ ] Step 2: Stage explicit paths and commit.

## Phase D - Dashboard

### Task D1: Dashboard screen

- Create: `frontend/src/pages/Dashboard.jsx`.
- Modify: `frontend/src/App.jsx`.

- [ ] Step 1: Build the hero strip, region selector, KPI strip, condition donut, spend and condition trends, degradation attention (top 5) and recommendations (top 5) from `/dashboard/summary`, reusing `components/viz`.
- [ ] Step 2: Tolerate empty payloads with `EmptyState`.
- [ ] Step 3: `npm run build`; live check against the running API.

### Task D2: Phase D verification and commit

- [ ] Step 1: Visual pass at desktop and narrow widths; confirm no full-collection fetch in the network panel.
- [ ] Step 2: Stage explicit paths and commit.

## Phase A2 - Assets area

### Task A2.1: Shared list pattern

- Create: `frontend/src/components/DataList.jsx`.

- [ ] Step 1: Implement a reusable paginated list: search box, filters slot, rows, detail drawer slot, loading/empty/error states, server `page`/`page_size`/`q`/`sort`.
- [ ] Step 2: `npm run build`.

### Task A2.2: Assets hub

- Create: `frontend/src/pages/AssetsHub.jsx`.
- Modify: `frontend/src/App.jsx`, `frontend/src/styles.css`.

- [ ] Step 1: Overview tab from `/assets/summary` (mix, condition donut, valuation, top degradation).
- [ ] Step 2: Infrastructure tab with sub-tabs Lines / Substations / Towers / Regions using `DataList`.
- [ ] Step 3: Register tab: paginated assets with the existing detail/performance panel reused.
- [ ] Step 4: `npm run build`; live check each tab.

### Task A2.3: Phase A2 verification and commit

- [ ] Step 1: Confirm RegionSummary / LineSummary / SubstationSummary data is reachable from the new tabs.
- [ ] Step 2: Stage explicit paths and commit.

## Phase W - Work area

### Task W1: Work hub

- Create: `frontend/src/pages/WorkHub.jsx`.
- Modify: `frontend/src/App.jsx`.

- [ ] Step 1: Tabs Tasks / Schedules / Checklists / Crews / Certifications, each with summary tiles and a `DataList` reusing the existing modals.
- [ ] Step 2: `npm run build`; live check each tab.

### Task W2: Phase W verification and commit

- [ ] Step 1: Confirm create/edit flows from the old pages still work inside the tabs.
- [ ] Step 2: Stage explicit paths and commit.

## Phase AD - Admin area

### Task AD1: Admin hub

- Create: `frontend/src/pages/AdminHub.jsx`.
- Modify: `frontend/src/App.jsx`.

- [ ] Step 1: Tabs Reports / Value and Cost / Organization / Settings, gated to admin/executive, reusing the existing pages.
- [ ] Step 2: Tools tab absorbing Gps, DataValidation, Operating Model / System Map, and bulk import.
- [ ] Step 3: `npm run build`; confirm non-admins cannot reach `/admin/*`.

### Task AD2: Phase AD verification and commit

- [ ] Step 1: Role pass (admin, executive, crew).
- [ ] Step 2: Stage explicit paths and commit.

## Phase C - Sweep and deprecation

### Task C1: Remove eager full-collection fetches

- Modify: `frontend/src/pages/Home.jsx`, `frontend/src/pages/Overview.jsx`, remaining pages as found.

- [ ] Step 1: Search for list endpoint calls that fetch without a filter/page and replace with summary endpoints or paginated calls.
- [ ] Step 2: `npm run build`.

### Task C2: Deprecation record

- Create: `docs/superpowers/notes/system-simplification-deprecations.md`.

- [ ] Step 1: List tables/routes no longer used by the UI, with the exact SQL for the user to run if they choose to physically remove anything.
- [ ] Step 2: Commit.

### Task C3: Final verification and commit

- [ ] Step 1: `node --test "test/*.test.js"`, `npm run build`, and a full click-through of the four areas.
- [ ] Step 2: Stage explicit paths and commit.
