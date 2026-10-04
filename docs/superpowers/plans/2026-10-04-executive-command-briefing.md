# Executive Command Briefing v2 - Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Turn the executive page into a portfolio briefing distinct from the operational dashboard, backed by additive region-load and intervention-register fields on `/executive/summary`.

**Architecture:** `computeSummary` in `backend/routes/dashboard.js` gains two derived fields (`region_load`, `interventions`) computed from existing tables and helpers, so they inherit region scoping and the shared `scopedSummary` cache. `frontend/src/pages/ExecutiveSummary.jsx` is re-laid out into sections that render those fields, keeping its single cached request and existing drawers.

**Tech Stack:** Node 22 (`node:sqlite`, `node --test`), Express; React 19, Vite 7, Tailwind 4. Verify with backend tests, `npm run build`, and headless Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-executive-command-briefing-design.md`

## Global Constraints

- All payload changes are additive; no existing field is removed or renamed.
- No new tables or migrations; no destructive SQL.
- Executive gate stays `ADMIN` / `EXECUTIVE`; region scoping continues to flow through `commandScope` / `computeSummary`.
- No code comments. Stage explicit paths only; never `git add -A`.
- New styles are scoped under `.exec-briefing` and use tokens only (no hardcoded white), so dark mode stays high-contrast.
- Motion respects `prefers-reduced-motion`; keyboard focus stays visible.

## File Structure

- `backend/routes/dashboard.js` - add `region_load` and `interventions` to `computeSummary`'s return value; add small local helpers.
- `backend/test/executiveBriefing.test.js` - new tests for region load and interventions.
- `frontend/src/pages/ExecutiveSummary.jsx` - sectioned briefing layout.
- `frontend/src/styles.css` - `.exec-briefing` section/region/intervention styles.

## Phase E1 - Backend fields

### Task E1.1: Region load

- [ ] Step 1: Import/derive per-region substations using `parseVoltageLevels` (`../voltage`) and `substationBayCounts()` (`../integrity`); group by `operational_status`.
- [ ] Step 2: Sum line `length_km` into `route_km` and `length_km * circuit_count` into `circuit_km`; group lines by `voltage_kv` as `{ count, km }`.
- [ ] Step 3: Reuse the existing scoped `assets`/`condition` computation for per-region condition bands.
- [ ] Step 4: Compute `effectiveness` (`availability`, `delivery`, `condition`) with the weights in the spec; renormalise when a denominator is absent.
- [ ] Step 5: Append `region_load` to the returned object.

### Task E1.2: Intervention register

- [ ] Step 1: Build `REPLACE` rows from `renewalCandidates` (already computed).
- [ ] Step 2: Build `UPGRADE` rows from `degradationAttention` (severity below the poor band) and `overloadExposure`.
- [ ] Step 3: Build `REPAIR` rows from critical/poor assets not already included.
- [ ] Step 4: De-duplicate by asset, assign `urgency`, sort by urgency then condition, cap at 40, append `interventions` to the returned object.

### Task E1.3: Tests and verify

- [ ] Step 1: Add `backend/test/executiveBriefing.test.js` using the existing test harness to assert `region_load` shape/totals and `interventions` action/urgency fields for the seeded data.
- [ ] Step 2: Run `node --test "test/*.test.js"`; all pass.
- [ ] Step 3: Cold/warm call `/executive/summary` and confirm the new keys are present and the payload stays bounded.

## Phase E2 - Frontend briefing

### Task E2.1: Section scaffolding

- [ ] Step 1: Convert the page from `.content-fill` single-screen to a scrolling `.exec-briefing` document with the header strip and KPI strip.
- [ ] Step 2: Keep the single `api` request and region filter; add the new data reads defensively.

### Task E2.2: Section content

- [ ] Step 1: Human capital and readiness section.
- [ ] Step 2: Capital and cost of operation section.
- [ ] Step 3: Network condition and degradation section.
- [ ] Step 4: Regional load and effectiveness cards (substations, voltage, bays, route/circuit km, effectiveness ring + components).
- [ ] Step 5: Assets needing intervention register with filter tabs and drill-down.

### Task E2.3: Styles

- [ ] Step 1: Add `.exec-briefing` section/region/intervention styles using tokens only.
- [ ] Step 2: Responsive collapse (KPI 6->3->2, single-column below 720px).
- [ ] Step 3: `npm run build` succeeds.

## Phase E3 - Verify and ship

- [ ] Step 1: Backend tests pass; `npm run build` passes.
- [ ] Step 2: Playwright admin + executive at 1440x900 and 390x844, light and dark: zero console errors; contrast checker returns zero low-contrast elements; region cards and intervention rows render.
- [ ] Step 3: Commit explicit paths (spec, plan, backend route, test, page, styles) and push.
