# Whole-System Visual Unification on the Hub Look

Date: 2026-09-08. Phase B of the whole-system polish: bring every authenticated screen of the
TMMS frontend onto one coherent, "Hub-derived" visual language. Pure frontend work: tokens in
`frontend/src/styles.css`, canonical patterns applied through `frontend/src/pages/*` JSX and the
shared kit in `frontend/src/components.jsx`. No backend, DB, or API changes; no new npm
dependencies; no chart library. `npm run build` must stay green after each task.

The Infrastructure hub (`pages/Infrastructure.jsx` + `RegionSummary`/`SubstationSummary`/
`LineSummary` + `InfraTree`/`InfraVisuals`) is the *source* of the look. Per user decisions this
phase (a) unifies the whole app on the green+indigo two-tone accent model, (b) performs a full
layout redesign of non-Hub screens toward the Hub's card/KPI/tile vocabulary, and (c) also
canonicalizes the Hub screens themselves onto the exact same rules.

## 1. Design decisions (user-confirmed)

1. Accent model = **green + indigo two-tone**: `--primary`/`--sidebar` green remains the brand,
   actions, active nav, primary buttons. Indigo `#4338ca` on tint `#eef2ff` is the
   interactive-emphasis accent (selection, text links, breadcrumb links, bars, count badges,
   focus highlights). Non-geo blue `#2563eb` text/links migrate to indigo. Map/geo colors
   (markers, polygons, popups, route lines) stay as-is — they are data colors, not chrome.
2. Non-Hub screens get a **full layout redesign** toward the Hub vocabulary: page-level KPI
   tiles where meaningful counts exist, content in `.card` panels with `.card-head` titles,
   tables wrapped in `.card + .tbl-wrap`, statuses via `Pill`, chips via `.infra-chip`, and the
   canonical heading/button/form/modal patterns below. Functional content and CRUD behavior are
   preserved — tables remain tables; the redesign is visual structure, not information removal.
3. Hub screens are **canonicalized too**: entity-name headers move to `.entity-title`, in-card
   titles to `.card-title`, and any CSS conflicts/dead rules in `styles.css` are resolved so one
   rule set governs everywhere.

## 2. Canonical visual system

### 2.1 Tokens (styles.css `:root`)

Existing tokens stay: `--bg #f1f5f9`, `--panel #fff`, `--border #e2e8f0`, `--text #0f172a`,
`--muted #64748b`, `--primary #14532d`, `--primary-dark #052e16`, `--sidebar #052e16`,
`--danger`, `--ok #16a34a`, `--warn #d97706`, `--radius 10px`, `--shadow`.

Add indigo accent tokens:

```
--accent: #4338ca;
--accent-soft: #eef2ff;
--accent-hover: #3730a3;
--accent-border: #c7d2fe;
--danger-text: #dc2626;   /* red text/glyph/overdue, distinct from danger fill */
--ok-text: #16a34a;
```

Swap existing indigo-on-tint literals (`#4338ca`, `#eef2ff`, `#c7d2fe`, `#3730a3`, `#eef2ff`)
for the variables. Green palette literals stay (already `--primary`-driven).

### 2.2 Canonical heading & title hierarchy

Four roles, one rule set each. Remove the current double definition of `.section-title`
(`styles.css:84-85` `h3.section-title` vs `:273` `.section-title`).

1. **Page title** — stays in the topbar `Page` `h2` (18px). Pages never render their own raw
   `<h1>`/`<h2>` inside content.
2. **`.section-title`** — content-section kicker above a card group. Canonical (applies to
   h2/h3/h4 equally):

```css
.section-title {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin: 22px 0 10px;
}
.section-title:first-child { margin-top: 0; }
```

3. **`.entity-title`** — the focused entity name at the top of a detail/summary panel
   (replaces Hub's `h2.section-title` usage):

```css
.entity-title { font-size: 20px; font-weight: 700; color: var(--text); margin: 0; }
```

4. **`.card-title` + `.card-head`** — a title line *inside* a `.card` panel, optionally with
   right-aligned actions. Replaces bare `<b>` panel headers and `<h4>` sub-heads:

```css
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.card-head h3, .card-head .card-title { font-size: 14px; font-weight: 600; color: var(--text); margin: 0; }
.card-head .muted { font-size: 12px; }
```

JSX pattern for a card panel:

```jsx
<div className="card card-pad">
  <div className="card-head">
    <h3 className="card-title">Asset mix</h3>
    <span className="muted">count</span>
  </div>
  {content}
</div>
```

Modal titles keep `.modal-header h3` (16px) unchanged.

### 2.3 Card / panel / stat vocabulary

- `.card` base, `.card-pad` padding, `.grid`, `.grid-2/3/4`, responsive collapses — unchanged.
- Clickable summary cards: `.hub-card` (pointer + `--accent-border` hover) — promoted to the
  canonical "drill card" used for card-grid list entries across the app.
- KPI/tile vocabulary, canonical forms:
  - `KpiTile {label,value,sub}` from `components/InfraVisuals.jsx` (`.card.card-pad.ktile`).
  - `StatCard` from `components.jsx` stays for dashboard stat grids.
  - Inline big number in a card/list entry: `.ktile-value` (24px/700) for summary numbers, or
    new `.big-num` (18px/700) for table/detail emphasis.
- Bars/donuts are only via `BarRow`/`Donut` from `InfraVisuals.jsx` (or their CSS classes
  `.bar-row/.bar-track/.bar-fill`, `.donut-wrap/.donut/.donut-hole`). Any bespoke bar markup
  (e.g. Value.jsx, Gps progress) is converted to these. `components.jsx` `Progress` is allowed
  where a compact single progress bar is clearer; do not mix both in one screen.
- Panels inside a card use `.card-head` titles (2.2.4). Content-level sections above a group of
  cards use `.section-title` (2.2.2).

### 2.4 Tables

Canonical: interactive tables always render as

```jsx
<div className="card">
  <div className="tbl-wrap"><table>…</table></div>
</div>
```

(no extra `.card-pad` around a full-width table; the `.card` acts as the container). Apply to
every page-level list table, dashboard table, and modal table that is scrollable/wide. Tables
that are primarily *print* content (report bodies inside the printable modal) keep their light
treatment but gain `.tbl-wrap` too. Keep existing `th`/`td`/row-hover rules. Action cells use
`.td-actions`:

```css
.td-actions { text-align: right; white-space: nowrap; }
```

### 2.5 Statuses, chips, ok/bad glyphs

- Status enums (ACTIVE, PASS, FAIL, IN_PROGRESS, EXPIRED, …) always via `Pill`
  (`components.jsx`) which reads `STATUS_COLORS`. Add missing keys to `STATUS_COLORS`
  (`api.js`) so no status falls back to the gray default silently — at minimum
  `CRITICAL` (severity/priority) and `HIGH`, `MEDIUM`, `LOW` if surfaced as pills.
- Severity/priority text that is not a pill maps: CRITICAL/HIGH → `--danger-text`, MEDIUM →
  `--warn`, LOW → `--ok-text` (via tokens, not literals).
- Small text chips/codes (substation_id, voltage, type, region code) → `.infra-chip` (existing
  rule, `styles.css:352`). This replaces ad-hoc tinted spans.
- ok/bad glyph and ✓/✗ cells use new utility classes, not inline hex:

```css
.ok { color: var(--ok-text); }
.bad { color: var(--danger-text); }
.warn { color: var(--warn); }
.overdue { color: var(--danger-text); font-weight: 700; }
.link { color: var(--accent); cursor: pointer; }
.link:hover { color: var(--accent-hover); text-decoration: underline; }
```

- Replace every non-geo inline `#2563eb`/blue text link with `className="link"`; remove inline
  `style={{color:'#2563eb'}}`.

### 2.6 Buttons and action labels

- Primary/secondary/danger/small classes unchanged (`.btn`, `.btn-primary`, `.btn-danger`,
  `.btn-ghost`, `.btn-sm`, `.btn-xs`).
- Action vocabulary unifies to: **"+ Add {Noun}"** for creation (primary), **"Import …"** for
  file import (secondary), **"Export …"** for export, **"Run …"** for generation jobs,
  **"Edit"** / **"View"** row actions, **"Delete"** (never bare "Del") for destruction. Modal
  titles pair: `Add {Noun}` / `Edit {Noun} — {name}`. "New Task" becomes "Add Task"; "New
  Template" becomes "Add Template"; "Add Unit" → "+ Add Unit" primary.
- Destructive actions use `ConfirmButton` (`components.jsx`) with `label="Delete"` (default
  confirm label is already 'Delete'). Screens that currently delete instantly on a plain
  `.btn-danger` without confirmation switch to `ConfirmButton`.

### 2.7 Page chrome

- Every page uses the shared `Page` component; loading/error/loaded branches pass the **same**
  `title` and `crumbs` so there is no title-flash. Extract `const TITLE`/`const CRUMBS` where a
  component currently branches with different strings.
- Canonical crumbs per route (root mirrors the sidebar group the page belongs to):
  - Home `TMMS / Home`; Overview `TMMS / Overview`; Map `TMMS / Map` (fix: it currently says
    `TMMS / Overview`); Infrastructure `TMMS / Infrastructure`; Assets `TMMS / Infrastructure`;
    Tasks `TMMS / Operations`; TaskDetail `TMMS / Operations / Tasks / {task_number}`; Crews,
    Schedules, Checklists `TMMS / Operations`; Gps/Certifications/Reports
    `TMMS / Validation & Compliance`; Settings `TMMS / System` (add missing); Value
    `TMMS / Management`; Organization `TMMS / Governance`.
- Empty states use `Empty`/`.empty` (or inline `.muted` with `padding`) consistently; no raw
  "Nothing yet." without a styled container where a card exists.

### 2.8 Manage panes (Infrastructure `?manage=`)

The four CRUD pages (`Regions`/`Substations`/`Lines`/`Towers`) are mounted by
`Infrastructure.jsx:80-89` *inside* the Infrastructure route below a stray back-bar
(`Infrastructure.jsx:83-85`), each rendering its own nested full `Page`. Fix: when manage mode
is active, the CRUD component must render only its content (a new `embedded` prop), the "Back
to Infrastructure summaries" control moves into the Infrastructure `Page` `actions`, and no
second topbar/crumbs row is drawn.

Canonical: each CRUD component accepts `{ embedded }`. When `embedded`, it skips the `<Page>`
wrapper and its own `.content` chrome and returns the `.content` children directly (title,
error, filters, table). Default (`embedded` falsy) keeps existing standalone behavior so
nothing else breaks.

### 2.9 Forms & filters

- `.form-grid`/`.field` modal forms unchanged.
- `.filters` bar unchanged as the canonical list filter row.
- Do not add bespoke gap/flex inline styles that duplicate `.flex`/`.spread`/`.filters`;
  convert where touched.

### 2.10 Component/primitives cleanup (DRY)

Extract/relocate only where duplication is real and low-risk:

- `KpiTile`, `BarRow`, `Donut` already live in `components/InfraVisuals.jsx`; keep them there and
  import into other screens (do not copy).
- Promote a `MoneyCard`/big-number block to one shared component (`components.jsx`) used by
  Value.jsx and Reports.jsx, or convert both to `StatCard` where the shape matches.
- Local `Chip` wrappers (Region/Substation/Line summaries, Organization, RegisterTree) collapse
  onto `.infra-chip` spans; only keep a shared helper if used 3+ screens.
- New utility classes (`.link`, `.ok`, `.bad`, `.warn`, `.overdue`, `.card-head`,
  `.td-actions`, `.box`) are defined once in `styles.css`.

## 3. Screen-by-screen targets (full redesign)

Rules from §2 apply everywhere. This section lists the screen-specific end-state. All files are
under `frontend/src/`.

### 3.1 Dashboard family

**Home.jsx** — Page chrome stable (2.7). Greeting header stays. KPI `StatCard` grids keep
`grid grid-4`; recolor via tokens (`--danger-text`/`--ok-text` for kpi color props, `--accent`
where currently `#2563eb`). Section blocks: each section header uses `.section-title`; each
`task_queue`/`violations`/`schedule_list`/`cert_list`/`table` renders in `.card` + `.tbl-wrap`;
row action links `.link` or `.btn.btn-sm`. Table cells (overdue date, geofence ✓/✗, status)
use `.overdue`/`.ok`/`.bad`/`Pill`. Kicker/quick actions consistent (2.6). Remove inline
muted-caption styles in favor of a `.hint`-style muted class where repeated.

**Overview.jsx** — stable chrome. Top StatCard grids (4×4) stay but recolor via tokens. Section
headings to `.section-title`. `By Status`/`Open Tasks by Type` panels: `.card.card-pad` with
`.card-head`; breakdown rows use `.flex`/`.spread` without redundant inline styles. Condition
panel: replace inline `.progress`+hex bars with `BarRow` (or `Progress`) — prefer `BarRow` for
visual consistency; Legend squares via `.ok/.warn/.bad`. `Regional Activity` and `Recent Tasks`
tables wrapped `.card > .tbl-wrap`; overdue cells `.overdue`; row click opens task via
navigation (keep `window.location.href` only if SPA routing is not yet wired — Phase C handles
SPA; keep existing behavior, but a `.link`-style affordance on the task code is acceptable).

### 3.2 Infrastructure family (hub canonicalization)

**Infrastructure.jsx** — manage-mode back control moves to Page `actions` (2.8). Keep the hub
layout; swap indigo literals for `--accent*` tokens in any inline styles. Ensure the manage
branch never double-stacks chrome.

**RegionSummary / SubstationSummary / LineSummary** — focused header: entity name to
`.entity-title`; chips unchanged (`.infra-chip`); in-card titles to `.card-head`/`.card-title`;
donut legend colors to `.ok/.warn/.bad`; Hub card-grid list entries keep `.hub-card` and use
`.ktile-value`/muted text as today. Remove redundant inline muted styles where a helper exists.

**InfraTree.jsx** — selection/search/badge styling switches indigo literals to `--accent*`
variables; no markup change.

### 3.3 CRUD list family (Regions, Substations, Lines, Towers)

Each file: `embedded` prop (2.8); stable chrome outside embedded mode; `#2563eb` text links to
`.link`; GPS ✓/✗ to `.ok/.bad`; instant `.btn-danger` "Del" to `ConfirmButton label="Delete"`;
page-level totals KPI strip (`.grid grid-4` of `KpiTile`) above the table where row payloads
carry counts (Regions: substations/lines/crews/open tasks; Substations: derived; Lines:
towers/length; Towers: gps-validated fraction) — compute client-side from loaded rows; keep it
cheap and non-fatal (guard against absent fields). Table wrapped `.card > .tbl-wrap`. Modal
sub-tables (towers/parts/assets/tasks) wrapped likewise. Internal headers to `.card-title`.
"Import (Excel/CSV)" / "Import route file" labels → "Import …" consistent; "Add …" primary
labels per 2.6.

### 3.4 Operations family

**Tasks.jsx** — stable chrome. KPI strip (existing `btn btn-sm` KPI pills at :151) → real
`KpiTile`/`StatCard` row or token-styled pills; priority cells: `.bad`/`.warn`/`.ok` mapping
per 2.5 (or `Pill` if a priority pill is clearer); overdue `.overdue`; "Add Task"; modal title
`Add Task`. Bulk bar/selection markup to `.flex`/`.filters` conventions. Table already wrapped.

**TaskDetail.jsx** — stable chrome. GPS verdicts and severity/kind chips to tokens/`.ok/.bad/
.warn`/`.link` per 2.5 (kind chip colors may stay distinct hues — convert to CSS classes like
`.kind-chip.kind-checklist` etc. defined once in styles.css). Repeating row boxes
`{border:1px solid var(--border);…}` to a `.box` helper class. Card panel headers to
`.card-head`. The non-geo `borderTop 3px solid #2563eb` document accent → `--accent`. Inline
error reds to `.bad`. Keep Phase A work-items UI intact.

### 3.5 Compliance & asset families

**Assets.jsx / Crews.jsx / Schedules.jsx / Checklists.jsx / Gps.jsx / Certifications.jsx** —
stable chrome + title/crumbs where missing (2.7). `.link` for text links; `.ok/.bad/.overdue`
cells; `.tbl-wrap` for every table incl. modal tables; `ConfirmButton label="Delete"` for all
destructive actions; "+ Add {Noun}" labels; detail-modal print placement normalized to the
modal `footer` pattern used by Towers/Reports (PrintButton + Close in footer), removing
header-only variants for consistency. Crew roster/member rows and TaskDetail row boxes to
`.box`/`.flex`. Gps coverage bars to `.bar-track/.bar-fill` or `Progress`. Certifications
"EXPIRING" → a `Pill` with an added `STATUS_COLORS` key `EXPIRING`.

### 3.6 Management family

**Value.jsx** — convert bespoke `Bar` (inline bar) to `BarRow`; `MoneyCard` to shared
`StatCard` variant or a shared `MoneyCard` component; tables to `.card > .tbl-wrap`; panel
headers to `.card-head`; bars colored `--accent`.

**Reports.jsx** — stable chrome; Generated Reports table wrapped; in-report numeric cells to a
`.big-num`/`.card-title` treatment; heading element consistency (`.card-title` for inside-card
heads, `.section-title` above). Financial stat blocks reuse the shared money/stat component
from Value cleanup.

**Settings.jsx** — add `crumbs="TMMS / System"`; fix broken classes `.card pad` → `.card-pad`
and `.table` → real table + `.tbl-wrap`; hand-rolled active/inactive pills → `Pill`/`.pill-pass`
`.pill-fail`; content action rows to `.flex`/`.actions`-style (add a standalone `.actions`
rule so content-level action rows lay out, since `.actions` is currently only styled under
`.topbar`).

**Organization.jsx** — `.infra-chip`/token chips replace bespoke tinted spans; "+ Sub" →
"+ Add {unit}"; "Del" → `ConfirmButton label="Delete"`; modal tables wrapped; depth indent
inline style to a `.org-depth` class (or keep inline, acceptable if uniform).

## 4. CSS clean-up obligations (styles.css)

1. Remove the duplicate `.section-title` (resolve to canonical 2.2.2) and fix `.spread`/
   `.flex` duplicate definitions (lines ~178 and ~274) into single canonical rules.
2. Add all new utility classes from §2 (`.entity-title`, `.card-title`, `.card-head`,
   `.td-actions`, `.ok`, `.bad`, `.warn`, `.overdue`, `.link`, `.box`, `.big-num`, standalone
   `.actions`, `.kind-chip` variants if used).
3. Replace indigo literals with `--accent*` vars; add vars to `:root`.
4. Keep print CSS working (`.no-print`, scoped report printing). Do not regress the map/
   picker CSS (those styles are shared).
5. Remove dead rules only when certain they are unused (grep before removing).

## 5. Non-goals / boundaries

- No backend, DB, route, or API changes. No new dependencies.
- No SPA routing/refetch/polling behavior change — that is Phase C (live/SPA dynamism). Where a
  screen uses `window.location.href`, keep behavior identical (visual-only change permitted).
- No information removal: full layout redesign must not hide data, drop columns, or change
  sort/default/CRUD semantics. Filters/actions keep their existing functions.
- Map/geo colors are exempt from indigo migration.
- Login, Landing, and error/print surfaces: only fix obvious color-drift (they already conform);
  do not restructure.

## 6. Verification

Per task and at the end:

- `cd frontend && npm run build` passes with no new warnings of consequence.
- Grep audit: no remaining non-geo inline `#2563eb` or bare indigo literals in pages (allow
  InfraVisuals geo constants and map components); no remaining `className="Del"`; no bare
  `.btn-danger` instant-delete rows that should be `ConfirmButton`.
- Spot visual check on the live stack (backend :3001, Vite :5173) after all tasks: each nav
  destination renders with canonical topbar/crumbs, no double topbars under
  `/infrastructure?manage=…`, statuses colored via Pill, tables scroll inside cards, Hub still
  identical apart from token/heading canonicalization.
- No console errors on the dashboards and CRUD screens during the spot check.
