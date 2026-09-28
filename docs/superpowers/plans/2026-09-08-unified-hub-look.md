# Whole-System Visual Unification on the Hub Look — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every authenticated TMMS screen onto one Hub-derived visual language (green+indigo two-tone, canonical headings, card/KPI vocabulary, wrapped tables, token-driven statuses) with zero backend change.

**Architecture:** Pure frontend. Task 1 establishes the canonical CSS token/utility layer in `styles.css`. Tasks 2-9 apply it family-by-family to JSX screens (plus `api.js` STATUS_COLORS and small `components.jsx` additions). Task 10 audits and live-smokes. Every task ends with a green `npm run build`.

**Tech Stack:** React 18, plain CSS (no preprocessor), no new deps, no chart lib.

## Global Constraints

- Authoritative design rules: `docs/superpowers/specs/2026-09-08-unified-hub-look-design.md` (the spec). Task implementers MUST read the spec sections cited in their task.
- No backend, DB, route, or API changes. No new npm dependencies. No chart library.
- No behavior change: do not alter data, columns, sort/defaults, CRUD semantics, filters, or navigation. Where a screen navigates via `window.location.href`, keep it.
- Map/geo colors are exempt from the indigo migration (markers, polygons, popups, route lines, `.map-picker*`).
- Login, Landing: touch only if a color drift is obvious; do not restructure.
- Print CSS (`@media print`, `.no-print`, `.print-report-scope`) must keep working.
- Repo rules: `git add <files>` only, never `-A`; no `Co-authored-by:` trailers (commit hook appends); conventional commits; run `npm run build` in `/workspace/frontend` after code edits in every task; never run destructive commands; never touch `/workspace/backend/tmms.db`.
- Visual changes are reviewed by code reading (spec conformance) — reviewers do not run builds; implementer reports carry the `npm run build` evidence.

---

### Task 1: Canonical token & utility CSS layer

**Files:**
- Modify: `frontend/src/styles.css` only.

**Interfaces:**
- Produces: the full canonical class set every later task consumes — `--accent*` tokens; `.entity-title`, `.card-title`, `.card-head`, `.section-title` (single canonical); `.td-actions`; `.ok`, `.bad`, `.warn`, `.overdue`, `.link`; `.box`; `.big-num`; standalone `.actions`; `.kpi-strip`; `.kind-chip` + `.kind-checklist`/`.kind-finding`/`.kind-gps`/`.kind-remediate`.
- Consumes: nothing (foundation). Later tasks reference these class names verbatim.

- [ ] **Step 1: Add accent tokens to `:root`**

In `frontend/src/styles.css:1-16` `:root`, after the existing `--warn`/`--radius` lines, add:

```css
  --accent: #4338ca;
  --accent-soft: #eef2ff;
  --accent-hover: #3730a3;
  --accent-border: #c7d2fe;
  --danger-text: #dc2626;
  --ok-text: #16a34a;
```

- [ ] **Step 2: Resolve the duplicate `.section-title` / `.spread` / `.flex` definitions**

The file currently defines `.section-title` twice (`:84-85` `h3.section-title`, and `:273` a generic `.section-title`) and `.spread`/`.flex` twice (`:178` and `:274-275`). Canonicalize:

(a) Replace the block at `frontend/src/styles.css:84-85`:

```css
h3.section-title { font-size: 15px; margin: 24px 0 12px; color: var(--text); }
h3.section-title:first-child { margin-top: 0; }
```

with nothing (the canonical `.section-title` in (c) governs).

(b) Keep `:178-181` `.flex`/`.spread`/`.space-b`/`.grow` as the single source and DELETE the later duplicate declarations at `:274-275` (`.section-title`, `.spread`, `.flex`), leaving the other `:273-276` rules (`.home-hello`, `.btn-xs`) intact.

(c) Append the canonical section-title + heading/utility layer at the END of `frontend/src/styles.css` (before the media print blocks is fine, but appending at end keeps review easy):

```css
/* ---- Canonical type, emphasis & panel helpers (Phase B) ---- */
.section-title {
  font-size: 13px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--muted); margin: 22px 0 10px;
}
.section-title:first-child { margin-top: 0; }
.entity-title { font-size: 20px; font-weight: 700; color: var(--text); margin: 0; }
.card-title { font-size: 14px; font-weight: 600; color: var(--text); margin: 0; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.card-head h3, .card-head .card-title { font-size: 14px; font-weight: 600; color: var(--text); margin: 0; }
.card-head .muted { font-size: 12px; }
.td-actions { text-align: right; white-space: nowrap; }
.ok { color: var(--ok-text); }
.bad { color: var(--danger-text); }
.warn { color: var(--warn); }
.overdue { color: var(--danger-text); font-weight: 700; }
.link { color: var(--accent); cursor: pointer; text-decoration: none; }
.link:hover { color: var(--accent-hover); text-decoration: underline; }
.box { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.big-num { font-size: 18px; font-weight: 700; line-height: 1.2; }
.big-num-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.actions { display: flex; align-items: center; gap: 8px; }
.kpi-strip { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.kind-chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.kind-checklist { background: #e0f2fe; color: #0369a1; }
.kind-finding { background: #ffedd5; color: #b45309; }
.kind-gps { background: #f3e8ff; color: #7c3aed; }
.kind-remediate { background: #e2e8f0; color: #475569; }
.ktile-bad .ktile-value { color: var(--danger-text); }
.ktile-warn .ktile-value { color: var(--warn); }
.ktile-ok .ktile-value { color: var(--ok-text); }
```

- [ ] **Step 3: Migrate indigo literals to variables**

Replace indigo literal occurrences in `frontend/src/styles.css` (hub section `:331-362`, `.org-crews`-adjacent rows, `.demo-chip:hover` etc. where `#4338ca`/`#eef2ff`/`#c7d2fe`/`#3730a3` appear in non-map rules) with the `--accent*` variables from Step 1. Specifically: `.hub-node:hover`, `.hub-node.sel`, `.hub-badge`, `.crumb-link`, `.bar-track`, `.bar-fill`, `.hub-card:hover` border, and any `.ktile`/`.bar-fill` colors.

- [ ] **Step 4: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Run: `grep -n "h3.section-title\|^\.section-title\|^\.flex\|^\.spread" /workspace/frontend/src/styles.css`
Expected: no duplicate top-level declarations remain; canonical `.section-title`, `.flex`, `.spread` appear once.

Commit:
```bash
git add frontend/src/styles.css
git commit -m "style: canonical token and utility CSS layer for hub look"
```

---

### Task 2: api.js STATUS_COLORS + shared component additions

**Files:**
- Modify: `frontend/src/api.js`, `frontend/src/components.jsx`, `frontend/src/components/InfraVisuals.jsx`.

**Interfaces:**
- Produces: `STATUS_COLORS` gains `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `EXPIRING`; `components.jsx` exports a shared `MoneyCard({label, value, sub, color})`; `components/InfraVisuals.jsx` `KpiTile` gains an optional `tone` prop (`'bad' | 'warn' | 'ok'`).
- Consumes: existing `StatCard` styling; existing `KpiTile` markup.
- Do NOT add a generic `Box` component — spec 2.10 uses utility classes only.

- [ ] **Step 1: Extend STATUS_COLORS**

In `frontend/src/api.js:112-141`, add keys so no surfaced enum falls to the gray fallback:

```js
  CRITICAL: '#dc2626',
  HIGH: '#ea580c',
  MEDIUM: '#d97706',
  LOW: '#16a34a',
  EXPIRING: '#d97706',
```

(`EXPIRING` reuses amber; `CRITICAL/HIGH/MEDIUM/LOW` match severity ramp.) Add inside the existing object before its closing brace.

- [ ] **Step 2: Add shared MoneyCard**

In `frontend/src/components.jsx`, after `StatCard` (line 28), add:

```jsx
export function MoneyCard({ label, value, sub, color }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Add KpiTile tone prop**

In `frontend/src/components/InfraVisuals.jsx:1-9`, change the signature so a tone class is applied when present (values default to neutral when no tone is passed):

```jsx
export function KpiTile({ label, value, sub, tone }) {
  return (
    <div className={`card card-pad ktile${tone ? ` ktile-${tone}` : ''}`}>
      <div className="ktile-label">{label}</div>
      <div className="ktile-value">{value ?? '—'}</div>
      {sub ? <div className="ktile-sub">{sub}</div> : null}
    </div>
  );
}
```

- [ ] **Step 4: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Commit:
```bash
git add frontend/src/api.js frontend/src/components.jsx frontend/src/components/InfraVisuals.jsx
git commit -m "feat(ui): add missing status colors, shared money card, kpi tile tones"
```

---

### Task 3: Manage-pane embedded refactor

**Files:**
- Modify: `frontend/src/pages/Infrastructure.jsx`, `frontend/src/pages/Regions.jsx`, `frontend/src/pages/Substations.jsx`, `frontend/src/pages/Lines.jsx`, `frontend/src/pages/Towers.jsx`.

**Interfaces:**
- Produces: each CRUD component accepts optional `{ embedded }`; when truthy it returns content children WITHOUT the `<Page>` wrapper (and without its own title/crumbs topbar). `Infrastructure` manage-mode renders `<Regions embedded />` etc., and shows a "← Back to Infrastructure summaries" action in its Page `actions`.
- Consumes: `Page` from `components.jsx`.

- [ ] **Step 1: Refactor one CRUD page (Regions) as the pattern**

In `frontend/src/pages/Regions.jsx`, change the component signature to `export default function Regions({ embedded })`. At the loading guard (currently `:63`) render `<Loading />` bare when embedded. Replace the main `return (` at `:65-66`:

```jsx
if (!rows) return embedded ? <Loading /> : <Page title="Regions"><Loading /></Page>;

const body = (
  <>
    {error && <ErrorNote error={error} />}
    <div className="card">… existing card/table …</div>
    {detail && ( …existing modal… )}
    {form && ( …existing modal… )}
  </>
);
if (embedded) return body;
return (
  <Page title="Regions" crumbs="TMMS / Infrastructure" actions={…}>
    {body}
  </Page>
);
```

Preserve every modal, handler, and the table markup exactly; only the wrapper changes. Keep `Page` title/crumbs in the non-embedded branch identical to today.

- [ ] **Step 2: Apply the same pattern to Substations, Lines, Towers**

Repeat Step 1 for `frontend/src/pages/Substations.jsx`, `frontend/src/pages/Lines.jsx`, `frontend/src/pages/Towers.jsx`. Titles: "Substations", "Transmission Lines", "Towers". Keep crumbs `TMMS / Infrastructure`. Loading guards similarly.

- [ ] **Step 3: Rewire Infrastructure manage mode**

In `frontend/src/pages/Infrastructure.jsx`, replace the `MANAGE` const (`:19`) and the manage branch (`:80-89`) so manage renders embedded and the back control lives in Page actions:

```jsx
const MANAGE = { regions: <Regions embedded />, substations: <Substations embedded />, lines: <Lines embedded />, towers: <Towers embedded /> };
```

and inside the main Page `actions` (currently `:102-106`) prepend, when `manage` is set:

```jsx
{manage && <button className="btn btn-sm" onClick={goAll}>← Back to Infrastructure summaries</button>}
```

Delete the old `:80-89` manage branch entirely so the single Page always renders; in the body render `{manage ? MANAGE[manage] : (…existing hub…)}`.

- [ ] **Step 4: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Static check: no `<Page>` remains inside Regions/Substations/Lines/Towers when `embedded` is passed; Infrastructure no longer has a nested topbar path.

Commit:
```bash
git add frontend/src/pages/Infrastructure.jsx frontend/src/pages/Regions.jsx frontend/src/pages/Substations.jsx frontend/src/pages/Lines.jsx frontend/src/pages/Towers.jsx
git commit -m "refactor(ui): embed CRUD manage panes without nested topbar"
```

---

### Task 4: Dashboard family redesign (Home, Overview, MapPage)

**Files:**
- Modify: `frontend/src/pages/Home.jsx`, `frontend/src/pages/Overview.jsx`, `frontend/src/pages/MapPage.jsx`.

**Interfaces:**
- Consumes: Task 1 CSS (`.section-title`, `.card-head`, `.card-title`, `.ok/.bad/.overdue/.link`, `.tbl-wrap`), `Pill`, `StatCard`, `BarRow` from `components/InfraVisuals.jsx`.
- Produces: canonical dashboard markup that Tasks 5-9 mirror.

- [ ] **Step 1: Stabilize chrome in Home, Overview, MapPage**

`Home.jsx`: extract at top `const TITLE = 'My Workspace';` and `const CRUMBS = 'TMMS / Home';`; use them in the loading/error branches (`:17-18`) and the loaded `Page` (`:22`) identically.
`Overview.jsx`: same with `TITLE='Operations Dashboard'`, `CRUMBS='TMMS / Overview'`, replacing `title="Dashboard"` at `:13-14` and `:19`.
`MapPage.jsx`: at `:264` change `crumbs="TMMS / Overview"` → `crumbs="TMMS / Map"`; map layers stay (crumbs text only).

- [ ] **Step 2: Overview content to canonical panels**

In `Overview.jsx`:
- Section headings `:34,46,56,74` keep `className="section-title"` (now canonical kicker).
- `By Status` / `Open Tasks by Type` panels `:36-44`: header `<div className="spread mb"><b>…</b></div>` → `<div className="card-head"><h3 className="card-title">By Status</h3></div>` (drop the inner `<b>`), body uses `<TaskBreakdown/>`.
- `TaskBreakdown` (`:95-106`): replace `style={{ display: 'grid', gap: 8 }}` with `className="flex"` columns or `<div style={{display:'grid',gap:8}}>` → keep as-is only if simpler; prefer `<div className="grid">`? Use a plain wrapper `<div style={{ display: 'grid', gap: 8 }}>` is acceptable (no behavior change) — but remove redundant inline `justifyContent:'space-between'` on elements that already have `.flex space-b` (`:99,112`).
- Condition panel `:47-54`: replace `.progress`+hex block with `<BarRow label="Good 8–10" value={condition.good} max={counts.assets} color="#16a34a"/>` style rows OR keep `Cond` but recolor via tokens. Prefer converting to `BarRow` (import from `components/InfraVisuals`) with legend colors passed as the four band colors; add a legend line using `.ok/.warn/.bad` squares.
- StatCard `color` props `:28,31`: use `'#dc2626'`→`'var(--danger-text)'` is invalid as a JS color; instead pass literal `'#dc2626'`/`'#d97706'`/`'#16a34a'` — these match `--danger-text`/`--warn`/`--ok-text`; acceptable (CSS var in inline style is not applied by React for colors passed to `style`). Alternatively import token map from api. Keep hex values that EQUAL the tokens.
- Overdue cells `:65,67`: `<b style={{ color: '#dc2626' }}>` → `<b className="overdue">`.
- Tables `:58,76`: wrap with `.card` + `.tbl-wrap` per spec 2.4 (the `.card.card-pad` divs become `.card` with inner `.tbl-wrap`), i.e.:

```jsx
<div className="card">
  <div className="tbl-wrap"><table>…</table></div>
</div>
```

- Remove duplicate `.card-pad` around tables (keep panels that mix text+table inside card-pad when truly needed).

- [ ] **Step 3: Home content to canonical panels**

`Home.jsx`:
- Section header `:67` `<h3 className="section-title">` unchanged (canonical kicker); the wrapper `<div className="spread">` with title + quick actions stays but quick-action `<button className="btn btn-sm">` keep.
- All section tables (`:95,119,140,159,191`) wrapped per spec 2.4: `.card` (drop `.card-pad`) → `.tbl-wrap` → `table`.
- Cell colors: overdue dates `:104,230` → `<b className="overdue">`; geofence ✓/✗ `:128` → `<span className="ok">✓</span>` / `<span className="bad">✗ out</span>`; KPI StatCard color props `:35-38`: replace `#dc2626`→`#dc2626`, `#16a34a`→`#16a34a`, `#b91c1c`→`#dc2626`? — map to canonical: `#b91c1c`→`#dc2626` for critical-red and `#2563eb`→`#4338ca` (accent). Keep numbers the same semantics.
- Repeated muted captions (`:76`, `:214`) `style={{ fontSize: 12/11, marginBottom: 8 }}` → `<div className="muted" style={{ fontSize: 12 }}>` acceptable; do not introduce new helper.
- `link_cards` `:180` and row-click tables keep behavior.

- [ ] **Step 4: MapPage popup link colors (non-geo only)**

In `frontend/src/pages/MapPage.jsx`, the popup HTML anchors `:116,133,153,188` use `style="color:#2563eb"` inside template strings → change to `style="color:#4338ca"` (accent). Do NOT touch geo colors: layer legend `:16`, region polygons `:93-95`, `L.circleMarker` `:236`, and map marker colors remain `#2563eb` (geo-exempt per Global Constraints). These four are navigation links, not map render colors.

- [ ] **Step 5: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Grep audit:
- `grep -n "#2563eb" frontend/src/pages/Home.jsx frontend/src/pages/Overview.jsx` — expected no match.
- `grep -n "#2563eb" frontend/src/pages/MapPage.jsx` — expected matches ONLY at the geo-exempt `:16,93,94,95,236` lines (popup links `:116,133,153,188` gone).

Commit:
```bash
git add frontend/src/pages/Home.jsx frontend/src/pages/Overview.jsx frontend/src/pages/MapPage.jsx
git commit -m "style(ui): redesign dashboard family onto hub look"
```

---

### Task 5: CRUD list family (Regions, Substations, Lines, Towers)

**Files:**
- Modify: `frontend/src/pages/Regions.jsx`, `frontend/src/pages/Substations.jsx`, `frontend/src/pages/Lines.jsx`, `frontend/src/pages/Towers.jsx`.
- Do NOT repeat Task 3's `embedded`/Page refactor (already done) — only the visual rules below.

**Interfaces:**
- Consumes: Task 1 CSS (`.link`, `.ok/.bad`, `.card-title`, `.td-actions`, `.tbl-wrap`, `.box`), `ConfirmButton`, `KpiTile` (`components/InfraVisuals.jsx`), `Pill`.

- [ ] **Step 1: Links & status glyphs**

Replace non-geo `#2563eb` text links with `.link`:
- `Regions.jsx:76` region code → map link: `<a className="link" …>`.
- `Substations.jsx:145` connected-line name link → `.link`.
- Keep map marker/polygon colors as geo (do not change).

GPS ✓/✗ cells → `.ok`/`.bad` spans:
- `Substations.jsx:99`, `Lines.jsx:148`, `Towers.jsx:192,231`. Use `<span className="ok">✓</span>` / `<span className="bad">✗</span>`; where a mixed glyph+text exists keep text.

- [ ] **Step 2: Destructive actions to ConfirmButton**

Replace instant `.btn-danger` "Del" row buttons with `ConfirmButton label="Delete"` (default confirmLabel 'Delete'):
- `Regions.jsx:87`, `Substations.jsx:103`, `Lines.jsx:152`, `Towers.jsx:195,236,345`.
- Pattern: `{/* view + edit remain plain buttons */} <ConfirmButton label="Delete" title="Delete {name}?" onConfirm={() => remove(r)} />`.
- Keep any force-delete flow inside the handler unchanged.

- [ ] **Step 3: Tables wrapped + action cells + headers**

- Ensure every page/modal table is `.card > .tbl-wrap > table` (spec 2.4). Especially modal sub-tables: `Towers.jsx:328-372`, `Lines.jsx:206-215`, `Substations.jsx` modal asset table (~152), `Regions` detail modal.
- Action cells → `className="td-actions"`.
- Modal in-content sub-heads (`<h4 …>`) and bare `<b>` headers inside cards → `.card-head` + `.card-title` (spec 2.2.4). Applies to Lines modal heads (`:189`, `:226,257` h4s), Towers modal (`:356`), etc.

- [ ] **Step 4: Add page KPI strips (client-side, non-fatal)**

Add under the Page content top (above the filters/card), a `.grid-4` row of `KpiTile`s computed from already-loaded `rows` (guard `Array.isArray`, default 0; import `KpiTile` from `../components/InfraVisuals`). Use only the fields confirmed present on list rows:
- `Regions`: total regions (`rows.length`); Σ `substation_count`; Σ `line_count`; Σ `open_task_count` (four tiles; drop `crew_count` to keep the 4-up grid even).
- `Substations`: total (`rows.length`); count with `gps_validated` truthy; count with `operational_status === 'OPERATIONAL'`.
- `Lines`: total (`rows.length`); count with `operational_status === 'ENERGIZED'`; Σ `tower_count`.
- `Towers`: total (`rows.length`); count with `gps_validated` truthy; count with `Number.isFinite(Number(r.corrosion_rating))`.
Tiles render only after `rows` is non-null; numeric cells guard with `Number(...) || 0`.

- [ ] **Step 5: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Grep: no `#2563eb` remaining in the four files (allow geo colors `#14532d`/`#7c3aed` in marker props only); no `btn-danger` "Del" text; no `.card pad`.

Commit:
```bash
git add frontend/src/pages/Regions.jsx frontend/src/pages/Substations.jsx frontend/src/pages/Lines.jsx frontend/src/pages/Towers.jsx
git commit -m "style(ui): redesign CRUD infrastructure screens onto hub look"
```

---

### Task 6: Operations family (Tasks, TaskDetail)

**Files:**
- Modify: `frontend/src/pages/Tasks.jsx`, `frontend/src/pages/TaskDetail.jsx`.

**Interfaces:**
- Consumes: Task 1 CSS (`.kind-chip*`, `.link`, `.ok/.bad/.overdue`, `.card-title`, `.card-head`, `.box`, `.td-actions`), `Pill`, `ConfirmButton`. Keep Phase A work-items and carry-over UI intact.

- [ ] **Step 1: Tasks.jsx chrome + labels + KPI strip**

- Stabilize title: `TITLE='Maintenance Tasks'`, `CRUMBS='TMMS / Operations'` used in all branches (`:133`, `:136`).
- "+ New Task" (`:138`) → "+ Add Task"; modal title (`:252`) `New Maintenance Task` → `Add Task`.
- KPI pills (`:151` area): import `KpiTile` (`import { KpiTile } from '../components/InfraVisuals';`) and replace the pill strip block (`:142-156`, the `{kpi && (<div className="flex mt mb" style={{ gap: 10, flexWrap: 'wrap' }}>…}` + five `<span className="pill">` maps) with a `.kpi-strip` of five `KpiTile`s, preserving the exact values/labels and using the `tone` prop for the two overdue tiles:

```jsx
{kpi && (
  <div className="kpi-strip mt mb">
    <KpiTile label="Overdue" value={kpi.overdue} tone={kpi.overdue > 0 ? 'bad' : undefined} />
    <KpiTile label="Critical overdue" value={kpi.critical_overdue} tone={kpi.critical_overdue > 0 ? 'bad' : undefined} />
    <KpiTile label="Completion rate" value={`${kpi.completion_rate}%`} />
    <KpiTile label="Completed this week" value={kpi.completed_this_week} />
    <KpiTile label="Avg cycle" value={kpi.avg_cycle_hours == null ? '—' : `${kpi.avg_cycle_hours}h`} />
  </div>
)}
```

- task_number link `:232` → `.link`. Overdue cell `:240` → `.overdue`; bulk-error `:214` → `.bad`.
- Priority cell `:236`: `color: STATUS_COLORS[t.priority] || '#64748b'` stays (now resolves via Task 2 keys).
- Action cell `:242` → `.td-actions`.

- [ ] **Step 2: TaskDetail.jsx tokens, chips, boxes, headers**

- Stable chrome: `TITLE` from `task?.task_number || 'Task Detail'`, `CRUMBS` full path — use same fallback string in loading/error branches (`:160-161` vs `:180`) so no flash.
- Work-item/finding/severity/kind chips → canonical `.kind-chip` classes where they are the four Phase A kinds (checklist/finding/gps/remediate); other severity text chips (findings severity at `:273,297`) map CRITICAL/HIGH/MEDIUM/LOW to `.bad/.warn/.ok`-text classes or keep distinct `.kind-chip`-style hues ONLY if you define them in `styles.css` under `.severity-chip` in this task — prefer reusing `.ok/.bad/.warn` text coloring on the label. Keep the exact severity words unchanged.
- Repeating row boxes `style={{border:'1px solid var(--border)',borderRadius:8,padding:'8px 10px'}}` (`:233,294,375,455`) → `className="box"`.
- Panel headers `.spread > <b>` (`:287,306,425,453`) → `.card-head` + `.card-title` (spec 2.2.4).
- Non-geo `borderTop: '3px solid #2563eb'` document card (`:414`) → `borderTop: '3px solid var(--accent)'`.
- GPS verdict texts `:237` with `#166534/#991b1b/#92400e` → `.ok`/`.bad`/`.warn` classes on the values.
- Inline `#dc2626` error reds → `.bad` text.
- Do NOT change Phase A carry-over preview card, template picker, or Work items block structure/classes beyond replacing the specific inline hexes listed.

- [ ] **Step 3: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Grep: no `#2563eb` in either file; `.kind-chip` classes used for the four work-item kinds; no leftover `.spread mb` bare-`<b>` panel headers on the listed lines.

Commit:
```bash
git add frontend/src/pages/Tasks.jsx frontend/src/pages/TaskDetail.jsx
git commit -m "style(ui): redesign operations screens onto hub look"
```

---

### Task 7: Compliance & asset families (Assets, Crews, Schedules, Checklists, Gps, Certifications)

**Files:**
- Modify: `frontend/src/pages/Assets.jsx`, `frontend/src/pages/Crews.jsx`, `frontend/src/pages/Schedules.jsx`, `frontend/src/pages/Checklists.jsx`, `frontend/src/pages/Gps.jsx`, `frontend/src/pages/Certifications.jsx`.

**Interfaces:**
- Consumes: Task 1 CSS (`.link`, `.ok/.bad/.overdue`, `.card-title`, `.card-head`, `.td-actions`, `.tbl-wrap`, `.box`), `Pill`, `ConfirmButton`, `Progress`/bar classes, `MoneyCard` not needed here.

- [ ] **Step 1: Per-file chrome/label/print fixes**

Apply spec §3.5 to each file:
- **Assets.jsx** — title stable (`Assets`, `TMMS / Infrastructure` already stable at `:109/112`). Open-task link `:273` → `.link`. GPS ✓/✗ `:165`, card borderLeft status colors `:194,206` → `.ok/.bad` for text and `4px solid var(--ok-text)`/`var(--danger-text)` for borderLeft (or a status class). "Del" `ConfirmButton` (`:169,211`) label → `"Delete"`. Maintenance-history and open-task tables in modal → `.card > .tbl-wrap`; modal `<h4>` heads (`:270,278,311,315`, `:461`) → `.card-title` in `.card-head`. Keep geo marker colors.
- **Crews.jsx** — stable chrome: title `Field Crews` / `TMMS / Operations` used in loading branch (`:127`). Recent-task link `:259` → `.link`; eligibility ✓/✗ `:179` → `.ok/.bad`; roster (`:140`) & certs (`:191`) tables wrapped; modal tables wrapped; member rows `:299-300` inline flex → `className="flex"` where identical; number `:300` muted → `.muted`. "Del"/"✕" member removal → `ConfirmButton label="Delete"`. PrintButton moves to modal `footer` if currently header-only.
- **Schedules.jsx** — overdue `:90` → `.overdue`; targets table `:118` wrapped; `<h4>` (`:116`) → `.card-title`; labels keep "+ Add Schedule". Print placement footer.
- **Checklists.jsx** — stable chrome (`Checklists`→`Inspection & Maintenance Checklists`); execution link `:119` → `.link`; "CRIT" `:160` → `.bad`; "+ New Template" → "+ Add Template"; modal `New Checklist Template` → `Add Template`; procedure table `:150` wrapped; `<h4 className="mt">` (`:149`) → `.card-title` in `.card-head`; delete confirm labels → `Delete` (`:101,163`).
- **Gps.jsx** — geofence ✓/✗ `:151` → `.ok/.bad`; task link `:153` → `.link`; coverage bars `:122,133` → `Progress` component or `.bar-track/.bar-fill`; Geofences table `:199-213` wrapped; heading element consistency (h4.section-title `:116,127` → h3 or `.card-title` per context); modal `.actions mt` → `.actions` (now standalone) plus spacing class.
- **Certifications.jsx** — days-left `:109` → `.overdue`/`.warn`; `certPill` "EXPIRING" `:15` → `Pill value={c.status}` or map via `STATUS_COLORS.EXPIRING`; table fine; `ConfirmButton label="Del"` → `"Delete"`.

- [ ] **Step 2: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Grep: no `#2563eb` in the six files (geo exempt); no `label="Del"`; no `btn-danger`>Del plain text.

Commit:
```bash
git add frontend/src/pages/Assets.jsx frontend/src/pages/Crews.jsx frontend/src/pages/Schedules.jsx frontend/src/pages/Checklists.jsx frontend/src/pages/Gps.jsx frontend/src/pages/Certifications.jsx
git commit -m "style(ui): redesign compliance and asset screens onto hub look"
```

---

### Task 8: Management family (Value, Reports, Settings, Organization)

**Files:**
- Modify: `frontend/src/pages/Value.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/Organization.jsx`.

**Interfaces:**
- Consumes: Task 1 CSS, Task 2 `MoneyCard`, `BarRow` from `components/InfraVisuals.jsx`, `ConfirmButton`, `Pill`, `StatCard`.

- [ ] **Step 1: Value.jsx**

- Bespoke `Bar` (`:6-19`) → use `BarRow` (import from `../components/InfraVisuals`) with `color="#4338ca"` default; delete local Bar.
- `MoneyCard` (`:25`) → import shared `MoneyCard` from `../components`; delete local.
- Tables `:105-112,188-205,242-272` → `.card > .tbl-wrap`.
- Bare-`<b>` panel headers (`:104`, `:241`) → `.card-head` + `.card-title`.

- [ ] **Step 2: Reports.jsx**

- Stable chrome (`Reports`→`Operational & Compliance Reports`).
- Generated Reports table `:110` wrapped.
- Big-number cells (`:221-229,363-366,386-388`) `style={{fontSize:22,fontWeight:700}}` → `.big-num` with `.big-num-label`; where the cell is a card stat block, use `MoneyCard`.
- `<h4 className="mt">` subsection heads → `.card-title`/`.section-title` per context; card stat-block headers `<b>` (`:220,224,228`) → `.card-title` in `.card-head`.
- Financial stat cards that duplicate Value's MoneyCard → shared `MoneyCard`.
- Keep print modal structure and `.no-print` intact.

- [ ] **Step 3: Settings.jsx**

- Add `crumbs="TMMS / System"` to the Page (`:181`).
- Fix broken classes: `.card pad` (`:192,231,256,323`) → `.card card-pad`; `.table` (`:233,258,325`) → proper `<div className="tbl-wrap"><table>…` markup if the element is a real table, or remove the class if it is a wrapper div.
- Hand-rolled active/inactive pills (`:267,336`) → `Pill value="ACTIVE"`/`Pill value="INACTIVE"` (STATUS_COLORS covers both) or `.pill-pass`/`.pill-fail`.
- Content action rows `<div className="actions mt/mb">` (`:223,253,319`) — now styled by standalone `.actions`; verify they have `display:flex; gap:8px` — if they contain buttons that should be right-aligned, wrap with `justifyContent:'flex-end'` via a `.spread` or add inline style; prefer `.flex` + marginLeft auto.
- Row action cells → `.td-actions`.

- [ ] **Step 4: Organization.jsx**

- Bespoke chips (`:73,74,90`) → `.infra-chip` (unit type, region, crew chips) or token classes; keep color-coding by adding CSS `.org-chip` variants in styles.css ONLY if needed for unit-type colors (prefer existing `unit-*` badge classes for the color dot + `.infra-chip` for text).
- "+ Sub" (`:82`) → "+ Add {unit type}" dynamic or "+ Add Unit"; "+ Add Unit" (`:128`) consistent.
- `ConfirmButton label="Del"` (`:83`) → `"Delete"`.
- Modal tables `:182,194` wrapped; modal `<h4>` heads `:181,193,203` → `.card-title` in `.card-head`.
- Depth indentation `style={{marginLeft: depth*22}}` (`:66`) → keep inline (uniform, acceptable) — do NOT convert unless a `.org-depth` class is trivially added.

- [ ] **Step 5: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Grep: `Settings.jsx` no `.card pad` / `className="table"`; Value/Reports no local `Bar`/`MoneyCard` redefinition; no `#2563eb`.

Commit:
```bash
git add frontend/src/pages/Value.jsx frontend/src/pages/Reports.jsx frontend/src/pages/Settings.jsx frontend/src/pages/Organization.jsx frontend/src/pages/../components.jsx frontend/src/styles.css
git commit -m "style(ui): redesign management screens onto hub look"
```

(Stage only files actually changed; do not stage styles.css/components.jsx if untouched by this task.)

---

### Task 9: Hub canonicalization (Infrastructure, summaries, InfraTree)

**Files:**
- Modify: `frontend/src/pages/Infrastructure.jsx`, `frontend/src/pages/RegionSummary.jsx`, `frontend/src/pages/SubstationSummary.jsx`, `frontend/src/pages/LineSummary.jsx`, `frontend/src/components/InfraTree.jsx`.

**Interfaces:**
- Consumes: Task 1 CSS tokens and `.entity-title`/`.card-title`/`.card-head`/`.ok/.warn/.bad`.
- Produces: canonical Hub (visual only; interactions/tree/manage unchanged beyond Task 3).

- [ ] **Step 1: Headings & titles**

- Focused entity headers in `RegionSummary.jsx:31`, `SubstationSummary.jsx:25`, `LineSummary.jsx:27`: `<h2 className="section-title">` → `<h2 className="entity-title">`.
- In-card panel titles (`RegionSummary.jsx:47,55`, `SubstationSummary.jsx:43,50`, `LineSummary.jsx:48,55`): wrap as `<div className="card-head"><h3 className="card-title">Asset mix</h3></div>` (drop bare `h3.section-title` inside cards).
- Legend colors (`RegionSummary.jsx:14-16`) → `.ok/.warn/.bad` square spans.

- [ ] **Step 2: Tokens & inline cleanup**

- `InfraTree.jsx` selection/search/badge colors → `--accent*` vars already applied at CSS layer (Task 1 Step 3); remove any inline indigo literals in the component.
- `Infrastructure.jsx`: inline styles using `display:'flex',gap:6` breadcrumb wrappers (`:121`) → keep (no matching helper); confirm no indigo literals remain.
- Summary components: replace redundant inline muted caption styles with the shared patterns only where trivially equivalent (`.muted` with `fontSize:12` stays as-is when not repeated).

- [ ] **Step 3: Verify + commit**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Static: entity names use `.entity-title`; no `h2.section-title`/bare `h3.section-title`-in-card remain in the summary files; tree colors come from CSS vars.

Commit:
```bash
git add frontend/src/pages/Infrastructure.jsx frontend/src/pages/RegionSummary.jsx frontend/src/pages/SubstationSummary.jsx frontend/src/pages/LineSummary.jsx frontend/src/components/InfraTree.jsx
git commit -m "style(ui): canonicalize hub screens onto shared rules"
```

---

### Task 10: Audit + live smoke

**Files:** none (verification only; commit only if a defect is found).

- [ ] **Step 1: Grep audits**

Run (expect clean results per each):
```bash
cd /workspace/frontend/src
grep -rn "#2563eb" pages components.jsx components | grep -v -E "marker|polygon|popup|color: '#2563eb'\)( geo)" || echo "no non-geo blue"
grep -rn "label=\"Del\"\|>Del<" pages || echo "no bare Del"
grep -rn "btn-danger[^>]*>Del" pages || echo "no instant-delete Del"
grep -rn "className=\"card pad\"\|className=\"table\"" pages || echo "no broken settings classes"
grep -rn "h2 className=\"section-title\"" pages || echo "no stray entity h2.section-title"
```

Report each result; fix-and-commit any real defect found (message `fix(ui): …`), staging only the changed files.

- [ ] **Step 2: Build gate + live smoke**

Run: `cd /workspace/frontend && npm run build`
Expected: exit 0.

Live smoke on the running stack (backend :3001, Vite :5173): using curl to the backend for auth + a browser-less check is limited — instead confirm the Vite dev server still compiles by checking its background terminal output for errors, and hit `http://localhost:5173/` for a 200. If servers are down, do NOT start persistent servers in this task; report status instead.

- [ ] **Step 3: Report**

Write the audit results and smoke outcome to `/workspace/.superpowers/sdd/task-10-report.md`. Return status + summary. No commit unless a defect was fixed.
