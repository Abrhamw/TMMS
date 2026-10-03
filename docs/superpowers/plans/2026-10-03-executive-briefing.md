# Executive Briefing - Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Reduce the Executive Command Center to a single-screen briefing with KPIs and visualizations that fits one window on desktop, tablet, and mobile, with scoped font reduction.

**Architecture:** Rewrite `frontend/src/pages/ExecutiveSummary.jsx` as a fixed-height grid (header / KPI strip / visual grid / briefing strip) that reuses the existing `components/viz` primitives and the existing `GET /executive/summary` response. Add a scoped `.exec-briefing` CSS block with `clamp()` type and breakpoints; no other page or backend is touched.

**Tech Stack:** React (Vite) SPA, CSS. Verify via `npm run build` and headless Playwright viewport captures.

**Spec:** `docs/superpowers/specs/2026-10-03-executive-briefing-design.md`

## Global Constraints

- No backend change; the single `GET /executive/summary` call (plus optional `?region=`) is unchanged.
- All new styles scoped under `.exec-briefing`; do not alter global tokens or other pages.
- The page must not scroll vertically; only the recommendations list may scroll internally.
- Reuse existing `components/viz` and `components/InfraVisuals` primitives. No new runtime dependencies. No code comments.
- Keep figures precise; do not change endpoint values.
- Stage explicit paths only.

## File Structure

- `frontend/src/pages/ExecutiveSummary.jsx` - rewritten single-screen briefing.
- `frontend/src/styles.css` - new `.exec-briefing` block and responsive breakpoints.
- `docs/superpowers/specs/2026-10-03-executive-briefing-design.md` - design spec.
- `docs/superpowers/plans/2026-10-03-executive-briefing.md` - this plan.

## Phase E - Executive briefing

### Task E1: Rewrite the executive page

- Modify: `frontend/src/pages/ExecutiveSummary.jsx`.

- [x] Step 1: Replace the tab shell with a fixed grid container `.exec-briefing` containing the compact header, KPI strip, visual grid, and briefing strip.
- [x] Step 2: Keep the single `GET /executive/summary` effect, the region selector, the loading state, and the error state.
- [x] Step 3: Render the five KPIs from `summary.kpis` using the existing `KpiTile` with sparklines; keep the fallback tiles when `kpis` is empty.
- [x] Step 4: Render the visual grid: condition `Donut` (center = mean condition), spend `TrendLine`, work-status `StackedBar` with open/overdue stats, readiness `ProgressRing`s for certification and crew, cost-composition `StackedBar`, and top-three degradation items with `SeverityBadge`.
- [x] Step 5: Render the briefing strip with the top four recommendations (severity badge, title, action) and an "Open reports" link to `/admin`.
- [x] Step 6: Remove the tab imports and all removed tables (asset mix, owner register, spend by class/region, roles, certifications by type, recent work orders).

### Task E2: Scoped styles

- Modify: `frontend/src/styles.css`.

- [x] Step 1: Add `.exec-briefing` as `flex: 1; min-height: 0; display: grid` with a row template for KPI / visual / briefing, `overflow: hidden`, base `font-size: 13px`. Render the page with `<Page fill>` so it uses the shell's `.content-fill` mode.
- [x] Step 2: Add `clamp()` sizes for KPI values and section headings; tighten paddings.
- [x] Step 3: Add breakpoints at 1024px and 720px: KPI columns 5 -> 3 -> 2, visual grid 3 -> 2 -> 1; hide secondary legends/captions below 720px.
- [x] Step 4: Allow only `.exec-briefing-recs` to scroll internally (`overflow: auto`).
- [x] Step 5: Add a print rule so export still prints cleanly.

### Task E3: Verify and commit

- [x] Step 1: `npm run build` succeeds.
- [x] Step 2: Headless capture at 1440x900, 1024x768, 390x844; assert `document.scrollingElement.scrollHeight <= window.innerHeight` and zero console errors at each.
- [x] Step 3: Confirm no other route changed and removed tables remain reachable in Reports/Admin.
- [x] Step 4: Commit explicit paths (`frontend/src/pages/ExecutiveSummary.jsx`, `frontend/src/styles.css`, spec, plan) and push.
