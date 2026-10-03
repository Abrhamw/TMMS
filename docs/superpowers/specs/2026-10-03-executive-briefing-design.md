# Executive Briefing - Design

Date: 2026-10-03
Status: Approved (design), pending implementation plan

## 1. Summary

The Executive Command Center currently presents a five-tab report with dense tables
(asset mix, owner register, spend by class and region, roles, certifications, recent
work orders) on top of a KPI strip. Executives do not need the whole register on this
screen; they need a briefing they can read at a glance and a set of visualizations
that communicate system health.

This design reduces the executive page to a single-screen briefing: a compact header,
one KPI strip, a grid of visualizations, and a short recommendations strip. The
detailed tables are removed from the executive page and remain available through the
Reports and Admin areas. No data is deleted and no capability is removed; the density
is moved to where it belongs.

The guiding sentence: the executive page is a briefing, not the register.

## 2. Goals

- Present the Executive Command Center as a single window with no page scroll on a
  normal desktop, tablet, or mobile viewport.
- Lead with visualizations (distributions, trends, readiness, composition) rather
  than tables.
- Keep every figure precise; the reduced surface must not round away meaning.
- Reduce front-end type scale and spacing on the executive page only, scoped so the
  rest of the application is unaffected.
- Keep drill-down available: the page links to Reports, Admin, and the integrated map
  for anyone who needs the underlying tables.

## 3. Non-goals

- No change to the executive summary endpoint shape or to any other page.
- No removal of data, tables, or records. Detailed tables stay in Reports/Admin.
- No site-wide font reduction.
- No new runtime dependencies.

## 4. Single-screen layout

The page is a vertical grid that occupies the available viewport height:
`header / KPI strip / visual grid / briefing strip`. It renders through the existing
`Page` component with its `fill` prop, which applies the app shell's `.content-fill`
mode (`flex: 1; min-height: 0; display: flex; flex-direction: column; overflow:
hidden`). The `.exec-briefing` root then uses `flex: 1; min-height: 0` as a grid, so it
fills exactly the space below the shell topbar without hardcoding a header height, and
the page itself does not scroll. Only the recommendations list is allowed to scroll
internally if it overflows.

- **Header (compact).** The page title and crumbs stay in the shell topbar; the region
  selector, live indicator, and export button render in the topbar actions. A slim meta
  line inside the grid shows the generated timestamp and scope.
- **KPI strip.** The five KPIs already returned by the endpoint (Assets in service,
  Mean condition, Open work orders, 12-month spend, Crew readiness), each with its
  existing sparkline where available.
- **Visual grid.** Condition donut (center shows mean condition), 12-month maintenance
  spend trend, work-status stacked bar with open/overdue counts, readiness rings for
  certification and crew, cost-composition stacked bar (planned / unplanned /
  emergency / capital), and the top three degradation items with severity badges.
- **Briefing strip.** The top four executive recommendations with severity badges and
  an "Open reports" link to the Admin reports area.

## 5. Content moved off the executive page

The following remain in the product but are no longer rendered on the executive page:
asset mix by class, owner register and cost allocation, spend by asset class, spend by
region and owner, workforce by role, certifications by type, and recent work orders.
They are reachable through the Reports and Admin areas.

## 6. Responsive behavior and type scale

All new styling is scoped under a single `.exec-briefing` selector so no other page
changes.

- Base type ~13px; KPI numbers and headings use `clamp()` so they scale with the
  viewport while staying legible.
- Breakpoints at 1024px and 720px:
  - KPI strip columns 5 -> 3 -> 2.
  - Visual grid columns 3 -> 2 -> 1.
- On phones the layout stacks to a single column; charts shrink and secondary legends
  or captions hide so the briefing still fits without page scroll.

## 7. Data flow

The page keeps its existing single request to `GET /executive/summary` (optionally
with `?region=`). The endpoint already returns portfolio counts, KPIs, condition
distribution, cost composition, spend and condition trends, degradation attention,
workforce readiness, equipment gaps, task status, and structured recommendations, so
no backend change is required. The endpoint payload is approximately 27 KB.

## 8. Verification

- `npm run build` succeeds.
- Headless Playwright capture at 1440x900, 1024x768, and 390x844.
- For each viewport, assert the document does not vertically scroll
  (`scrollHeight <= innerHeight`) and that no console errors occur.
- Confirm the removed tables are still reachable through Reports/Admin.
