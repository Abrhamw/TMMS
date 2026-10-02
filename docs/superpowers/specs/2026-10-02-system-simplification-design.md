# System Simplification - Design

Date: 2026-10-02
Status: Approved (design), pending implementation plan

## 1. Summary

The TMMS application has grown to roughly thirty top-level pages, and most pages
fetch entire collections (all assets, tasks, lines) just to render a chart or a
short list. This design simplifies the presentation of the system without
changing what it fundamentally is - a transmission asset maintenance management
system (TMMS).

The database remains the system of record. Every table and record stays intact.
The user interface surfaces a curated, small set of aggregates and basic
visualizations, and reaches detailed records only on demand, through paginated
lists and detail views.

The guiding sentence: the database is available, but it is not all subjected for
display.

## 2. Goals

- Reduce the working surface from about thirty top-level pages to four areas
  (Dashboard, Assets, Work, Admin), with Home and Mailbox unchanged.
- Stop pages from downloading full collections. Each screen loads only the
  aggregates it shows, plus a page of rows when the user opens a list.
- Present basic visualizations (KPIs, distributions, trends, short attention
  lists) consistently across the app.
- Preserve the TMMS concept and every existing workflow; no capability is
  removed, only reorganized and de-emphasized.
- Keep the change additive and low risk: existing endpoints keep their current
  response shape unless a new pagination parameter is explicitly requested.

## 3. Non-goals

- No change to what the system does, only to how much it shows at once.
- No rewrite of the data model and no physical deletion of tables. Unused tables
  are deprecated in code only. Any physical removal would be performed manually
  by the user with SQL provided by us.
- No new runtime dependencies.
- No change to the PDF/print report layouts, beyond preserving current print CSS.
- No new auth model. Existing roles and command scoping are reused.

## 4. Approach

Server-side aggregates plus thin pages.

Each area gets one small read-only summary endpoint returning pre-aggregated
numbers, distributions, trends and a top-N list. Pages render those aggregates
with the existing shared visualization components. Long lists become
server-paginated and searchable. Full-detail endpoints remain available, and the
underlying tables are untouched.

This was chosen over a frontend-only cache (which still downloads the entire
dataset, so the over-fetch problem remains) and over a full rebuild (too large
and risky for a simplification pass).

## 5. Information architecture

Top level, unchanged: Home, Mailbox.

The rest of the app collapses into four areas:

### 5.1 Dashboard

One screen. Basic visualizations only:

- Hero strip: title, generated-at, region scope selector, live status dot,
  Export/print action.
- KPI strip (six tiles, sparkline where meaningful): assets in service, current
  value, mean condition, open work, overdue work, 12-month spend.
- Charts: condition distribution donut, 12-month spend trend, condition trend.
- Degradation attention (top 5) and recommendations (top 5), each linking to its
  record.

No large tables.

### 5.2 Assets

Tabs: Overview | Infrastructure | Register.

- Overview: mix by class, condition distribution, condition-adjusted value,
  top degradation.
- Infrastructure: sub-tabs Lines, Substations, Towers, Regions, each a paginated
  list with a detail drawer. Absorbs the RegionSummary, LineSummary and
  SubstationSummary pages as filters and columns rather than separate routes.
- Register: the paginated asset list; selecting a row opens the existing asset
  detail, including the Condition and Performance panel.

### 5.3 Work

Tabs: Tasks | Schedules | Checklists | Crews | Certifications. Each tab has
summary tiles at the top and a paginated, searchable list below, reusing the
existing detail and edit modals.

### 5.4 Admin

Visible to admin and executive roles only. Tabs: Reports | Value and Cost |
Organization | Settings | Tools.

Tools absorbs Gps, DataValidation, Operating Model / System Map, and bulk import.

### 5.5 Navigation and redirects

The sidebar is rebuilt around the four areas. Old routes are retained as
redirects to their new tab so deep links do not break (for example
`/overview` redirects to `/dashboard`, `/lines` to `/assets/infrastructure`).
Non-admin users simply do not see the Admin group.

## 6. Backend contract

All additions are read-only and additive.

### 6.1 Aggregation module

New `backend/summary.js` with pure helper functions shared by the endpoints so
aggregation logic is not duplicated. The existing `GET /executive/summary`
continues to work unchanged; the dashboard is the general-role counterpart.

### 6.2 Endpoints

All endpoints accept an optional `?region=<id>` and are auto-scoped to the
caller's command using the existing `commandScope` helpers.

- `GET /dashboard/summary` - `kpis[]`, `condition`, `trends` (spend and
  condition), `degradation_attention[]`, `recommendations[]`, `generated_at`,
  `scope`.
- `GET /assets/summary` - population by class, family and region; condition
  distribution; valuation totals; top degradation.
- `GET /work/summary` - task counts by status, type and priority; overdue;
  schedule frequency; crew availability; certification readiness.
- `GET /reports/summary` - cost composition (planned, unplanned, emergency,
  capital); monthly spend; spend by region, class and owner; valuation by class.

### 6.3 List pagination (backward compatible)

Existing list endpoints (`/assets`, `/tasks`, `/transmission_line`, `/substation`,
`/tower`, and so on) accept optional `page`, `page_size`, `q` and `sort`.

- When `page` is present, the response is `{ items, total, page, page_size }`.
- When `page` is absent, the response is the current array, byte-for-byte as
  today, so existing consumers are unaffected.

The default page size is 25, overridable per request up to a maximum of 200.

### 6.4 Caching

Summary endpoints use a small in-memory TTL cache (20 seconds) keyed by
user scope, so switching tabs does not recompute aggregates over the full
register.

### 6.5 Schema

No schema changes are required. Deprecated tables are removed from queries only.

## 7. What is shown versus hidden

Shown by default: aggregates, KPIs, distributions, trends, top-N attention
lists, and paginated rows.

Stored and reachable on demand, but not displayed by default: raw `route_json`
and waypoint lists, asset `metadata` JSON, full GPS trace points, audit logs,
full maintenance-event history, and every row of any large table.

## 8. Visual language

Reuse the existing design tokens and the `frontend/src/components/viz`
primitives: Gauge, Donut, StackedBar, Sparkline, TrendLine, ProgressRing,
SeverityBadge, SectionCard, Tabs, EmptyState, Skeleton. No new dependencies; all
charts stay hand-rolled SVG/CSS.

A single reusable list pattern (paginated rows, search box, filter row, detail
drawer) is shared by every list so behavior is consistent.

## 9. Rollout

Each phase is verified and committed separately with explicit paths.

1. Backend: `backend/summary.js`, the four endpoints, pagination parameters, TTL
   cache, and tests.
2. App shell: four-area navigation, redirects from old routes, Admin role gating.
3. Dashboard screen against `/dashboard/summary`.
4. Assets area (Overview, Infrastructure, Register).
5. Work area (Tasks, Schedules, Checklists, Crews, Certifications).
6. Admin area (Reports, Value and Cost, Organization, Settings, Tools).
7. Sweep Home/Overview and remaining pages to remove eager full-collection
   fetches.

## 10. Verification

Per phase: `node --test "backend/test/*.test.js"`, `node --check` on touched
backend files, `npm run build`, and a live curl of each new endpoint. Confirm
that un-paginated list calls still return the old array shape. Capture response
sizes before and after to demonstrate the over-fetch improvement. Confirm old
routes redirect correctly.

## 11. Risks and mitigations

- Deep links break: mitigated by redirects instead of route removal.
- Pagination breaks an existing consumer: mitigated by keeping the non-paginated
  response shape when `page` is absent.
- Aggregates drift from detail data: mitigated by a shared `summary.js` module
  used by both the dashboard and the existing executive summary.
- Scope creep into a full rewrite: bounded by reusing existing detail pages
  inside tabs rather than rewriting them.

## 12. Constraints

- This environment forbids destructive SQL. Deprecation is in code only.
- No new runtime npm dependencies.
- No code comments in implementation.
- Never `git add -A`; commit explicit paths only.
