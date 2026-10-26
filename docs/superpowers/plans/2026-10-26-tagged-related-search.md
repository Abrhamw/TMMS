# Tagged Related Search Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. TDD: write the failing test first, watch it fail, then write minimal production code. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`, `mobile/eslint.config.js`. No JS/TS comments; SQL comments `--` only.

**Goal:** After a login-only keyword search, expand one hop of related records, tag them (Transformer, Line, Task, …), dedupe with `via`, and let the user pick from a localized count summary.

**Spec:** `docs/superpowers/specs/2026-10-26-tagged-related-search-design.md`

**Architecture:** `backend/searchExpand.js` (pure-ish: tag/slug/neighbors/dedupe/caps) is called from `GET /api/search/public` after keyword `searchGroup`. `GET /api/search` is unchanged. Header `GlobalSearch` merges both payloads in `frontend/src/mergeSearchResults.js` and builds the i18n summary. Ctrl-K stays `/search/public` + `href` only.

**Tech Stack:** Node 22 `node --test`; Express; React 19 / Vite 7 / vitest. Verify with `cd /workspace/backend && npm test` and `cd /workspace/frontend && npm run build && npm test`.

## Global Constraints

- Login required. Descriptions on every catalog/related row. `can_open` / deny banner unchanged except related tasks: `can(req, 'task:read') && taskVisible(req.user, task)`.
- No `summary` string from the server. Client builds it. Missing `summary` key = empty.
- Caps: 8 keyword hits expanded per entity type; 25 related per parent per named neighbor kind; keep 40 per tag group after sort; show 12.
- Sort then cap: keyword (`rank` desc, then id desc; missing `rank` = 0) then related (id desc). Catalog keyword hits carry `rank` from `searchGroup`.
- `list('task')` once per request. No per-row SQL.
- Stage explicit paths. Commit style `type(scope): summary` + `Co-authored-by: monkeycode-ai <monkeycode-ai@chaitin.com>`.

## File Structure

- `backend/searchExpand.js` (new)
- `backend/test/searchExpand.test.js` (new)
- `backend/routes/searchPublic.js` (wire expand)
- `backend/test/searchPublic.test.js` (HTTP cases)
- `frontend/src/mergeSearchResults.js` (new)
- `frontend/src/mergeSearchResults.test.js` (new)
- `frontend/src/components/GlobalSearch.jsx`
- `frontend/src/styles.css`
- `frontend/src/i18n/{en,es,zh,am}.js`
- `frontend/src/ui/Command.jsx` (comment-free note not needed; leave `/search/public` + href filter)

`GET /api/search` and landing stay unchanged.

---

## Phase 1 — `searchExpand` units

### Task 1.1: Tag and slug

- [ ] RED: `backend/test/searchExpand.test.js` — `tagFor({ type: 'asset', asset_type: 'CIRCUIT_BREAKER' })` → `{ tag: 'Circuit breaker', slug: 'circuit_breaker' }`; empty type → Asset/asset; `CAPACITOR_BANK` → Capacitor bank / capacitor_bank; region → Region/region.
- [ ] Run `node --test test/searchExpand.test.js` and confirm fail (module missing).
- [ ] GREEN: implement `tagFor` / `tagSlug` in `backend/searchExpand.js`.
- [ ] Re-run until pass.

### Task 1.2: Dedupe and keyword-wins

- [ ] RED: insert keyword hit then related of same `type`+`id` → kept row is `match: 'keyword'`, no `via`. Insert related then another parent → one row, `via` has both titles first-seen order.
- [ ] GREEN: `createIndex()` / `addKeyword` / `addRelated` helpers.
- [ ] Two parents with the same title collapse to one `via` entry.

### Task 1.3: Caps and sort

- [ ] RED: 50 related rows same tag, ids 1..50 → after `finalizeGroups`, `total === 40`, `items.length === 12`, items are the 12 highest ids (related sort is id desc). A parent with 30 towers contributes 25.
- [ ] RED: three keyword hits (rank 1 / id 2, rank 2 / id 1, rank 3 / id 3) plus a related row → order is rank 1, rank 2, rank 3, then related. Keyword sort is **rank desc, then id desc**, not id desc alone.
- [ ] GREEN: `PER_KIND = 25`, `GROUP_KEEP = 40`, `GROUP_SHOW = 12`. Finalize: keyword (`rank` desc, id desc) then related (id desc), slice 40, items slice 12.

### Task 1.4: Neighbor walks (in-memory maps)

- [ ] RED with fixture maps (no DB): substation hit expands yard transformer, endpoint line, that line’s tower, tower-mounted asset (`tower_id`), task with `substation_id`, LINE-scope schedule with `line_id`, TOWER-scope schedule (tower **and** line related from a schedule keyword hit).
- [ ] RED: substation hit also includes a **task on a related line** and a **schedule on a related line**, both with `via = [line title]`.
- [ ] RED: asset with both `substation_id = S` and `line_id = L` (L attached to S) is one row, `via = [substation title, line title]`.
- [ ] RED: line keyword hit includes `asset.tower_id` on that line and `task.tower_id` on that line; does **not** include a transformer that only has `substation_id` of an endpoint.
- [ ] RED: group-scope schedule (`ASSET_GROUP`) with stored `line_id = L` relates to line L.
- [ ] RED: group-scope schedule with **both** `line_id` and `substation_id` stored, as a **schedule keyword hit**, produces two related rows (line and substation), `via = schedule title`, order tower → asset → line → substation → region (skip nulls).
- [ ] RED: region keyword hit expands substations and lines in that region **and** a `scope_type = REGION` schedule with matching `region_id`. Does not pull yard transformers of those substations.
- [ ] RED: asset keyword hit → parent substation (or line), tasks targeting it, schedules targeting it, `via = asset title`.
- [ ] RED: tower keyword hit → parent line, tower-mounted assets, tasks/schedules targeting the tower (`via = tower title`), and a task on the tower’s **line** with `via = line title`.
- [ ] GREEN: `expand({ hits, maps, canOpen })` walking types in order region → substation → line → tower → asset → schedule. Named kinds per spec §6.1. `via` rules per spec (line title for line-hopped rows; line title for line-targeted tasks from a tower hit).
- [ ] `canOpen(entityType, row)` injected so tests can stub taskVisible.

### Task 1.5: Counts and payload (no summary)

- [ ] RED: `counts` keys are slugs; group `type` is slug, `entity` is entity type, `label` is display tag; no `summary` key.
- [ ] GREEN: `countsFromGroups` + group order: region, substation, line, tower, remaining asset slugs alpha, task, schedule, crew, person.

Run: `cd /workspace/backend && node --test test/searchExpand.test.js`

---

## Phase 2 — Wire `/search/public`

### Task 2.1: HTTP tests first

Extend `backend/test/searchPublic.test.js` (existing fixtures: Sululta region/sub/line/tower/transformer/schedule/tasks). Add only what a test needs.

- [ ] RED: non-blank no-hit preserves `query`, `counts: {}`, `total: 0`, `groups: []`, no `summary`.
- [ ] RED: substation query `sululta` includes related line, tower, transformer (`g.entity === 'asset'` / `g.type === 'transformer'`), schedule; items have `description`, `can_open`, `match`.
- [ ] RED: payload never includes `SECRET-SERIAL`, `HiddenCo`, `condition_rating`.
- [ ] RED: crew member related schedule `can_open: false`, no `href`.
- [ ] RED: existing `g.type === 'asset'` lookups updated to `g.entity === 'asset'` or slug `transformer` (this will fail until route emits `entity`).
- [ ] RED: related task **outside** the region user’s command scope. Fixture: insert task `TK-OTHER-REL` with `region_id = otherRegion` **and** `substation_id` of a Sululta substation (or a line in Sululta) so catalog search `sululta` relates it, while `regionToken` (Sululta director) is not `taskVisible` on it. Assert the item is present, `can_open: false`, no `href`. Then `GET /api/tasks/{id}` with `regionToken` returns 404. Do not use `TK-SEARCH-2` unless it also has a Sululta FK; the existing other-region task has no Sululta target.
- [ ] Existing AND / token / six-type tests still pass once `entity` is added (update six-type test: keyword **entity** types remain the six; related may add `task`).

Run the file, confirm new asserts fail.

### Task 2.2: Implement route

- [ ] GREEN: `searchPublic.js` after building keyword groups, pass the **sliced** 8 hits per entity type into `expand` with maps from the already-loaded `list()` plus `list('task')`.
- [ ] `canOpen`: `OPEN_PERM` for infra/schedule; tasks: `can(req, 'task:read') && taskVisible(req.user, task)`.
- [ ] Related task item: title/number/status only. Related schedule: name/code/frequency only.
- [ ] Response: `{ query, counts, total, groups }` — never `summary`.
- [ ] Keyword hits inserted into the dedupe index **before** walking neighbors.

Run: `cd /workspace/backend && node --test test/searchPublic.test.js test/searchExpand.test.js`

### Task 2.3: Full backend suite

- [ ] `cd /workspace/backend && npm test` — all green.

---

## Phase 3 — Client merge + i18n

### Task 3.1: Merge helper tests

- [ ] RED: `frontend/src/mergeSearchResults.test.js`
  - related catalog task + scoped keyword task → one row, `match: 'keyword'`, no `via`; **keeps catalog `tag` and `description`**; takes scoped `title` / `href` / `document_type`.
  - person-only scoped groups, empty catalog → counts/summary inputs non-empty.
  - scoped keyword asset not in catalog top 8 → appended as keyword.
  - catalog keyword rows in rank order (id 2 rank 9, id 1 rank 3) + one unrelated scoped person → catalog order survives (id 2 then id 1), scoped row after them.
  - `buildSearchSummary(query, counts, t)` with unknown slug `capacitor_bank` → “capacitor bank” / “capacitor banks”; `total === 0` → `''`.
- [ ] Run `cd /workspace/frontend && npx vitest run src/mergeSearchResults.test.js` — fail.

### Task 3.2: Implement merge + summary

- [ ] GREEN: `mergeSearchResults(catalog, scoped)` per spec §4.1. Key by `item.type`+`id`. Walk **all** scoped groups. On upgrade: keep catalog `tag` / `description` / `type` / `rank`; take scoped `title` / `subtitle` / `href` / `can_open` / `document_type`. Sort keyword by `rank` desc then `id` desc (missing `rank` = 0), then related by id desc. Cap 40 after that sort, show 12. `buildSearchSummary` maps slug → flat key (`region` → `searchTagRegion`, `circuit_breaker` → `searchTagCircuitBreaker`); unknown slug = display tag lowercased + `s`.
- [ ] Export `tagSlugFromItem` consistent with backend (asset_type title-case). For scoped items without `tag`, derive from `item.type` / `asset_type` if present, else entity type. Preserve `document_type` so `GlobalSearch.choose` still opens ASSET_DETAIL / LINE_DETAIL / CREW_DETAIL.

### Task 3.3: i18n keys

- [ ] Add to en/es/zh/am (existing i18n test enforces superset + non-empty):
  - `searchPickOne`, `searchVia`
  - `searchTag.region` / `regions`, `substation` / `substations`, `line` / `lines`, `tower` / `towers`, `task` / `tasks`, `schedule` / `schedules`, `crew` / `crews`, `person` / `people`, `asset` / `assets`
  - `searchTag.transformer` / `transformers`, `circuit_breaker` / `circuit_breakers`, `reactor` / `reactors`, `auto_transformer` / `auto_transformers`
`t()` in `frontend/src/i18n.js` is a flat lookup (`currentT[key]`). Use flat keys `searchTagRegion`, `searchTagRegions`, … Map slug → key in `buildSearchSummary` (`region` → `searchTagRegion`, `circuit_breaker` → `searchTagCircuitBreaker`). Do not change the i18n loader. Spec’s `searchTag.<slug>` is the logical name only.

Run: `cd /workspace/frontend && npx vitest run src/i18n.test.js src/mergeSearchResults.test.js`

---

## Phase 4 — GlobalSearch UI

### Task 4.1: Wire merge

- [ ] `GlobalSearch.jsx` uses `mergeSearchResults` on the two responses. Summary from `buildSearchSummary(query, counts, t)` only when `total > 0`.
- [ ] Each row: tag chip (`item.tag`), title, description; related: `{t('searchVia')} {via.join(', ')}`.
- [ ] `choose` still respects `can_open === false` → deny banner. `document_type` still opens the document modal before `href`.
- [ ] Treat missing server `summary` as empty (do not render it). Never interpolate a missing field as `"undefined"`.

### Task 4.2: CSS

- [ ] `.gs-tag` chip, `.gs-item-via` muted. Dark-mode variants next to existing `.gs-denied` rules.

### Task 4.3: Ctrl-K

- [ ] Leave `Command.jsx` on `/search/public` filtering `href`. Commit message notes: Ctrl-K does not show person/crew/task keyword hits.

---

## Phase 5 — Verify and commit

- [ ] `cd /workspace/backend && npm test`
- [ ] `cd /workspace/frontend && npm run build && npm test`
- [ ] Restart backend `PORT=3001` if it was running. Unauthenticated `GET /api/search/public?q=sululta` → 401. Authenticated admin `GET /api/search/public?q=sululta` → 200, body has `counts` and `groups`, no `summary` key.
- [ ] Commit explicit paths only, then push the current branch (`260928-feat-mailbox-reports-schedules`). Do not rename it.

Suggested commit:

```
feat(search): expand related tagged results for header search
```
