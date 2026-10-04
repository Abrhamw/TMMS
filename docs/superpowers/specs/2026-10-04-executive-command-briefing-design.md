# Executive Command Briefing v2 - Design

Date: 2026-10-04
Status: Approved (design)

Supersedes the relevant clauses of `2026-10-03-executive-briefing-design.md`:
the executive endpoint is now additive, and the briefing may scroll.

## 1. Summary

The executive page is currently a single-screen briefing that reuses the same
operational summary as the dashboard: a KPI strip plus a grid of condition,
spend, work, readiness, cost-composition, and degradation visuals. It answers
"how busy are we?" rather than the questions a board actually asks.

This design turns the executive page into a command briefing that reads
differently from the dashboard and answers five portfolio questions:

1. Human capital and readiness - do we have the crews and valid certifications
   to deliver the programme?
2. Capital and cost of operation - what are we spending, on what, and what is
   the network worth?
3. Network condition and degradation - where is the network degrading and how
   does that compare with our intervention capacity?
4. Regional load and effectiveness - what does each region carry (substations,
   voltage levels, bays, line circuit-km) and how effectively does it operate?
5. Assets needing intervention - a single upgrade / replace / repair register.

The guiding sentence: the dashboard manages the register; the executive page
briefs the portfolio.

## 2. Goals

- Add an additive region-load and intervention-register payload to
  `/executive/summary`, cached through the existing shared summary path.
- Rebuild `ExecutiveSummary.jsx` as a sectioned briefing with a clear narrative
  order, visibly different from the dashboard's operational tables.
- Expose a per-region effectiveness index with transparent components so the
  number can be audited, not just trusted.
- Keep visuals high-contrast in both themes (light and dark) and legible on
  desktop, tablet, and phone.
- Preserve the executive restriction (ADMIN / EXECUTIVE only), region filter,
  and the existing detail drawers.

## 3. Non-goals

- No new database tables, migrations, or destructive SQL.
- No change to the executive role gate or to non-executive endpoints.
- No removal of the existing summary fields; all changes to the payload are
  additive.
- No reuse of the operational dashboard's table/drill-down layout.
- No change to other pages or to the dashboard contract.

## 4. Backend: additive `/executive/summary` fields

Both fields are computed inside `computeSummary` so they inherit region scoping
and the shared `scopedSummary` cache (`SUMMARY_TTL_MS`).

### 4.1 `region_load[]`

One entry per scoped region:

- `id`, `code`, `name`
- `substations`: `count`, `by_voltage` (`{ "<level>": count }`), `total_bays`,
  `avg_bays`, `by_status` (`{ "<status>": count }`)
- `lines`: `count`, `route_km`, `circuit_km`, `by_voltage`
  (`{ "<level>": { count, km } }`)
- `assets`: `count`, `condition` (`critical/poor/fair/good`)
- `effectiveness`: `{ index, availability, delivery, condition }`

`circuit_km = length_km * circuit_count` summed per region; `route_km` is the
plain sum of `length_km`. Voltage levels are normalised with
`parseVoltageLevels`; substation bay counts use `substationBayCounts()` from
`integrity.js`; `by_status` groups `operational_status`.

### 4.2 Effectiveness index (composite, 0-100)

Three components, each 0-100, combined with fixed weights and returned
separately for auditability:

- `availability` (weight 0.4): share of lines whose `operational_status` is
  `ENERGIZED` plus substations whose `operational_status` is `OPERATIONAL`.
- `delivery` (weight 0.3): task completion rate in the region
  (`COMPLETED / total`).
- `condition` (weight 0.3): mean asset `condition_rating` scaled from 1-10 to
  0-100.

`index = round(0.4*availability + 0.3*delivery + 0.3*condition)`. When a
component has no denominator it is omitted and the remaining weights are
renormalised, so a region with no tasks is not penalised.

### 4.3 `interventions[]`

A unified register of assets needing action, classed by `action`:

- `REPLACE` from the latest per-asset health snapshot (`recommendation =
  REPLACE` or combined rating <= 3).
- `UPGRADE` from degradation attention where the suggested rating moves the
  asset below the poor band, or from overload exposure.
- `REPAIR` from critical/poor condition assets not already captured above.

Each row: `asset_id`, `asset_code`, `asset_name`, `asset_type`, `region`,
`current_rating`, `suggested_rating`, `action`, `urgency` (`high/medium/low`),
`reason`. Capped (for example top 40) and sorted by urgency then severity.

## 5. Frontend: sectioned briefing layout

`ExecutiveSummary.jsx` becomes a normal scrolling page (not `.content-fill`
single-screen) so additional domains have room. Sections, top to bottom:

1. **Header strip** - scope, generated timestamp, region selector, refresh.
2. **Executive KPI strip** - assets in service, mean condition, capital value,
   12-month spend, crew readiness, certification readiness.
3. **Human capital and readiness** - active/available crews, certification
   donut (valid / expiring / expired), people by role, equipment gaps.
4. **Capital and cost of operation** - cost-composition stacked bar, 12-month
   spend trend, valuation by class.
5. **Network condition and degradation** - condition donut, infrastructure
   operational status, condition trend, top degradation movers.
6. **Regional load and effectiveness** - one card per region showing
   substation count, voltage levels, total/average bays, line count,
   route/circuit km, voltage mix, and the effectiveness index with its three
   components.
7. **Assets needing intervention** - filter tabs (All / Upgrade / Replace /
   Repair) over the register, each row drilling into the asset record where
   permitted.
8. **Recommendations** - existing structured recommendations with severity.

Existing detail `Sheet` drawers are retained for degradation and
recommendations. Region cards and intervention rows reuse the existing
aggregate/exception drill-down rule (no full register on the exec surface).

## 6. Visual and interaction rules

- New styles live under `.exec-briefing` and reuse the token system
  (`--surface-*`, `--text`, `--muted`, `--primary-text`, `--border`); no
  hardcoded white surfaces, so dark mode stays high-contrast.
- Effectiveness index rendered as a ring with the three components as labelled
  bars; action classes use semantic tones (replace = red, upgrade = amber,
  repair = blue) that pass contrast in both themes.
- Motion respects `prefers-reduced-motion` via the existing `.content` enter
  animation and shared duration tokens.
- Responsive: KPI strip 6 -> 3 -> 2 columns; region cards and intervention list
  collapse to a single column below 720px.

## 7. Data flow

The page keeps its single cached request to `GET /executive/summary`
(optionally `?region=`). No new frontend requests are introduced; the new
sections read the additive fields. Region changes refetch as today.

## 8. Verification

- `node --test "test/*.test.js"` (backend) passes, including new coverage for
  `region_load` and `interventions`.
- `npm run build` (frontend) succeeds.
- Headless Playwright: light and dark, `/executive`, desktop and phone;
  assert zero console errors and zero low-contrast text elements (the
  existing contrast checker), region cards and intervention rows render, and
  the region filter updates the payload.
