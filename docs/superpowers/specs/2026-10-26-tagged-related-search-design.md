# Tagged Related Search Design

Date: 2026-10-26.

## 1. Problem

Header search already AND-matches keywords and groups rows by entity type. A dispatcher who types a substation name still only sees records whose own fields contain those tokens. They do not see the transformers, lines, towers, tasks, and schedules that belong to that place, so they cannot pick the right record from one tagged list.

Login-only catalog search (`GET /api/search/public`) and the deny banner stay as they are. This pass adds related expansion and a pick-from-tagged UI.

## 2. Goals

1. One query in the header search box.
2. After keyword hits, walk one hop of related records from every hit at once.
3. Deduplicate: each record appears once; related rows list every parent in `via`.
4. Show a localized count summary plus fine-tag groups. The user picks one row.
5. Keep login required, descriptions on every catalog/related row, and `can_open` / deny-banner rules.

## 3. Non-goals

- SQLite FTS, fuzzy match, or changing AND tokenization.
- Two-step “pick the substation first, then expand”.
- Landing-page search (landing stays persona-only).
- Saved searches, history, or typeahead beyond live grouped results.
- Expanding people or crews as related records.
- Fan-out from a related record (no second hop). Evaluating grouped-scope schedule filters (`scope_filter`) to explode a plan onto every matching member.

## 4. Approach

Expand on the existing `GET /api/search/public` response (login required). Shared helper `backend/searchExpand.js` builds related rows, tags, and dedupe. It does **not** build a display summary string. `GET /api/search` stays keyword-only and permission-scoped.

Header `GlobalSearch` calls both endpoints and merges (see §4.1). The **client** builds the summary line from the merged groups using i18n.

Ctrl-K keeps calling **only** `/search/public` and lists rows that have `href`. It therefore shows related openable catalog records (and related tasks/schedules the role may open) but **not** person/crew/task keyword hits from `/search`. That split is intentional: the header box is the full pick list; Ctrl-K stays a fast jump to openable catalog/related records.

### 4.1 Client merge

Inputs: `catalog` from `/search/public`, `scoped` from `/search`.

1. Index catalog items by `item.type` + `id` (entity type, not group slug).
2. From `scoped.groups`, keep only groups whose entity is `person`, `crew`, or `task`. Ignore scoped `asset` / `line` / `substation` / `tower` / `region` / `schedule` groups (catalog already owns those).
3. For each kept scoped item:
   - If no catalog row with that `type`+`id`: append as `match: "keyword"`, no `via`.
   - If a catalog row exists with `match: "related"`: **upgrade** it to the scoped keyword item (`match: "keyword"`, drop `via`, keep scoped title/subtitle/href). Keyword always wins.
   - If a catalog row exists with `match: "keyword"`: keep the catalog row.
4. Re-group by display tag, re-sort each group (keyword first by rank/id, then related by id desc), re-slice `items` to 12, recompute each group’s `total` as the unsliced merged size (still subject to the collection caps in §7).
5. Build `counts` from merged unsliced group sizes. Build `summary` in the client from `counts` + `query` (see §8.1). `total` is the sum of those group totals.

A person/crew/task-only query therefore still gets a non-empty summary, even though `/search/public` returned empty groups.

## 5. Keyword hits

Unchanged AND engine (`tokenize` / `matches` / `rank` / `searchGroup`).

`/search/public` keyword types remain: region, substation, line, tower, asset, schedule. Display slice: 8 items per **entity** type.

`/search` keyword types remain: task, asset, crew, person, substation, line, tower, region, schedule — each still gated by the matching `:read` perm and command scope.

Non-blank query with no keyword hits on `/search/public`:

```
{ query: "<raw>", counts: {}, total: 0, groups: [] }
```

`query` is preserved. Related expansion does not run. If `/search` also has no hits, the panel shows “No matches.” If `/search` has person/crew/task hits, the client merge produces groups and a summary from those.

Blank query (`q` empty/whitespace): `{ query: "", counts: {}, total: 0, groups: [] }`.

## 6. Related expansion

Input: keyword hits **after** the per-type display slice of 8 (not the unsliced universe). Output: related items with `match: "related"` and `via` set to unique immediate-parent titles in first-seen order.

Walk keyword hits in this type order: region, substation, line, tower, asset, schedule. Within a type: existing rank desc, then id desc.

### 6.1 Neighbor table

| Keyword hit | Related records (immediate parents in `via`) |
| --- | --- |
| Region | Substations with `region_id`; lines with `region_id`. `via` = region title. |
| Substation | (a) Assets with `substation_id`. (b) Lines with `from_substation_id` or `to_substation_id`. (c) Towers on those lines (`tower.line_id`). (d) Assets on those lines: `asset.line_id` **or** `asset.tower_id` in that line’s towers. (e) Tasks and schedules that target the substation, those lines, or towers on those lines (see §6.2 / §6.3). For (a)(b)(e-substation), `via` = substation title. For (c)(d) and line/tower-targeted tasks/schedules, `via` = **line title** (the hop that included them). |
| Line | Towers with `line_id`. Assets with `line_id` **or** `tower_id` in that line’s towers. From/to substations. Tasks and schedules that target the line **or** a tower on the line. `via` = line title (substations: line title). |
| Tower | Parent line; assets with `tower_id`; tasks and schedules that target that tower **or** its line. `via` = tower title. |
| Asset | Parent substation (`substation_id`) or parent line (`line_id`, else line of `tower_id`); tasks and schedules that target that asset. `via` = asset title. |
| Schedule | Its **direct stored target only** (see §6.3). Do not fan out from that target. `via` = schedule title. |
| Task | Not expanded on `/search/public`. Keyword-hit tasks arrive from `/search` via client merge and do not fan out. |

Do not walk from a related record except where the substation row above already includes “those lines’ towers and assets” (approved one hop further for a substation hit). A **line keyword hit** does not pull transformers out of its endpoint substations.

### 6.2 Task targeting

A task relates to:

- Substation S: `task.substation_id = S`
- Line L: `task.line_id = L` **or** `task.tower_id` in towers of L
- Tower T: `task.tower_id = T` **or** (`task.line_id` = T’s line when the walk is from a tower hit)
- Asset A: `task.asset_id = A`

Related task fields are only: `id`, `type: "task"`, `tag: "Task"`, `title` (title or task_number), `subtitle` (task_number · status), `description` (same as subtitle or “Task · {status}”), `can_open`, `href?`, `match`, `via?`. Never assignees, comments, people, GPS, or other task columns.

`can_open` is `can(req, 'task:read')`. CREW_MEMBER has `task:read`, so related tasks are openable for crew. `href` is `/tasks/{id}` when `can_open`.

Related tasks are catalog-wide (no `commandScope` / `taskVisible`). That is an accepted product decision: the description is title + number + status only. Tests must assert no assignee/comment/person fields leak.

### 6.3 Schedule targeting

Use **stored FK columns and `scope_type` only**. Do not evaluate `scope_filter` membership.

| `scope_type` | Relates to |
| --- | --- |
| SUBSTATION | `substation_id` |
| LINE, LINE_TOWERS | `line_id` |
| TOWER | `tower_id` **and** derived `line_id` (tower plans always store both) |
| ASSET | `asset_id` |
| REGION | `region_id` (the region row only, not every substation in it) |
| ASSET_CLASS, LINE_GROUP, SUBSTATION_GROUP, ASSET_GROUP | No per-member expansion. Relate only if a stored FK on the row equals the hit (`region_id`, `line_id`, `substation_id`, `asset_id`, `tower_id`). A typical group-scope row with only `region_id` / `asset_type` therefore relates to that region, not to each member. |

Yes: a schedule can target a tower (`scope_type = TOWER`).

Related schedule fields: `id`, `type: "schedule"`, `tag: "Schedule"`, `title` (schedule_name), `subtitle` (schedule_code · frequency), `description` (“Maintenance schedule · {frequency} · {code}”), `can_open`, `href?`, `match`, `via?`. No crew names, instructions, or filter payloads.

`can_open` is `can(req, 'schedule:read')`. CREW_MEMBER lacks `schedule:read`, so related schedules are description-only (`can_open: false`, no `href`). That is an accepted product/security decision, matching today’s catalog keyword schedules. Tests must assert no command-sensitive fields leak.

## 7. Dedupe, tags, caps

Dedupe key: entity `type` + `id`. First visit keeps the row. Later visits, if the kept row is still `related`, append the new parent title to `via` (unique by title string, first-seen order). Two different parents with the same title collapse to one `via` entry; that is accepted.

If a record is both a keyword hit and related (same endpoint or after client merge), it stays `match: "keyword"` with no `via`. Server-side: insert all keyword hits into the dedupe map **before** walking neighbors. Client-side: §4.1 upgrade rule.

Display tag (`tag`):

| Entity `type` | Tag |
| --- | --- |
| region | Region |
| substation | Substation |
| line | Line |
| tower | Tower |
| task | Task |
| schedule | Schedule |
| crew | Crew |
| person | Person |
| asset | Title-case of `asset_type` with underscores to spaces: `TRANSFORMER` → Transformer, `CIRCUIT_BREAKER` → Circuit breaker. Empty or unknown `asset_type` → Asset |

`tag_slug`: lowercase, spaces to underscores (`circuit_breaker`, `auto_transformer`, `asset`).

### 7.1 Group identity (breaking for tests, not for `/search`)

`GET /api/search` is unchanged: `groups[].type` remains the entity type.

`GET /api/search/public` groups:

- `type`: `tag_slug` (so transformers are not mixed with reactors)
- `entity`: entity type (`asset`, `line`, …) — **new field**, used for merge and `OPEN_PERM`
- `label`: display tag
- `total`: collected size after caps
- `items`: sliced to 12

Item `type` stays the entity type (`asset`, `line`, …).

Consumers to update (complete audit): `frontend/src/components/GlobalSearch.jsx` (merge currently filters `g.type` against catalog entity names — must use `g.entity` or `item.type`); `frontend/src/ui/Command.jsx` (flat items, uses `href` only — no group type); `backend/test/searchPublic.test.js` (looks up `g.type === 'asset'` → `g.entity === 'asset'` or `g.type === 'transformer'`). No other callers of `/search/public`.

### 7.2 Caps

Related expansion is capped. Counts and totals are **collected sizes after these caps**, not the uncapped database count.

| Cap | Value |
| --- | --- |
| Keyword hits expanded per entity type | 8 (the display slice) |
| Related rows collected per parent per neighbor kind | 25 (e.g. max 25 towers from one line) |
| Collected rows kept per tag group | 40 |
| `items` shown per tag group | 12 |

Neighbor kinds are the buckets in §6.1 (substations, lines, towers, assets, tasks, schedules). Collection uses in-memory `list()` already loaded for keyword search; do not add per-row SQL. Stop appending to a kind once that parent’s 25 is reached (stable order: id desc).

## 8. Response shape

`GET /api/search/public` does **not** return `summary`.

```
{
  query: "sululta",
  counts: { substation: 1, line: 2, transformer: 4, task: 3, schedule: 1 },
  total: 11,
  groups: [
    {
      type: "substation",
      entity: "substation",
      label: "Substation",
      total: 1,
      items: [
        {
          id, type: "substation", tag: "Substation",
          title, subtitle, description,
          can_open, href?,
          match: "keyword"
        }
      ]
    }
  ]
}
```

`counts` keys are `tag_slug`s. Zero counts are omitted. `counts` order (and `groups[]` order) is: region, substation, line, tower, then remaining asset slugs alphabetically, then task, schedule, crew, person.

`total` is the sum of group `total`s (capped collected sizes).

Item fields:

- `description` always present on catalog and related infra/task/schedule rows.
- `can_open` from `OPEN_PERM` (region/substation/line/tower/asset/schedule) or `task:read`. False → omit `href`.
- `match` is `"keyword"` or `"related"`.
- `via` only on related rows: array of parent titles.

No serial numbers, manufacturer, model, condition, GPS, people, assignees, comments, or schedule instructions on catalog/related rows.

### 8.1 Client summary (i18n)

`GlobalSearch` builds the summary from merged `counts` + `query`:

`{query}: {n} {label}, … — {pickOne}`

Required i18n keys (all four locales):

- `searchPickOne` — “pick one”
- `searchVia` — “via”
- Singular/plural for fixed tags: `searchTag.region` / `searchTag.regions`, `searchTag.substation` / `searchTag.substations`, `searchTag.line` / `searchTag.lines`, `searchTag.tower` / `searchTag.towers`, `searchTag.task` / `searchTag.tasks`, `searchTag.schedule` / `searchTag.schedules`, `searchTag.crew` / `searchTag.crews`, `searchTag.person` / `searchTag.people`, `searchTag.asset` / `searchTag.assets`
- Common equipment: `searchTag.transformer` / `searchTag.transformers`, `searchTag.circuit_breaker` / `searchTag.circuit_breakers`, `searchTag.reactor` / `searchTag.reactors`, `searchTag.auto_transformer` / `searchTag.auto_transformers`

Unknown asset slugs: use the display tag lowercased for singular and that string + `s` for plural (`circuit breaker` → `circuit breakers`). Count order matches §8.

Do not render a summary when merged `total === 0`.

## 9. UI

`GlobalSearch` panel, after a non-empty **merged** result:

1. Localized summary line at the top.
2. Groups labeled with `label` and `total`.
3. Each row: tag chip, title, description. Related rows add muted `{searchVia} {via joined by ", "}`.
4. Click `can_open: true` → navigate or open document as today. Click `can_open: false` → existing deny banner, no navigation.
5. Empty and error states unchanged.

Landing page stays persona-only. Executives keep the header search box.

## 10. Permissions

`/search/public` stays behind `requireAuth` (401 without a token). Related **infra** expansion is catalog-wide (same as today’s catalog keyword hits): no `commandScope`. Related **tasks** are catalog-wide with description limited to title + number + status (§6.2). Related **schedules** are catalog-wide with description limited to name + code + frequency; `can_open` still requires `schedule:read` (§6.3).

Extra groups merged from `/search` (person, crew, keyword tasks) stay command-scoped as today. After upgrade, a task that was related-catalog + keyword-scoped becomes the scoped keyword row (may then have a scoped href).

## 11. Tests

Backend (`backend/test/searchExpand.test.js` + `searchPublic.test.js`):

- Token still required (401).
- AND match unchanged; missing extra token still yields public total 0.
- Non-blank no-hit preserves `query` and returns empty `counts` / `groups` / `total: 0` (no `summary` key).
- Catalog keyword entity types remain the six; related may add `task` and extra infra tags.
- Items always have `description` and `can_open`; payload never includes `SECRET-SERIAL`, `HiddenCo`, `condition_rating`, assignees, or comments.
- Substation keyword hit expands to its lines, those lines’ towers/assets (including `tower_id` mounts), transformers in the yard, and tasks/schedules targeting the substation, those lines, or towers on those lines.
- Line keyword hit includes tower-mounted assets (`asset.tower_id`) and tasks with `tower_id` on that line; does not include transformers that only sit in an endpoint substation.
- TOWER-scope schedule relates to that tower (and its line).
- A line related to two keyword hits appears once with both parent titles in `via`, order = first-seen under §6 walk order.
- A record that is both a keyword hit and related stays `match: "keyword"` with no `via`.
- Crew member: related schedule `can_open: false`, no `href`; description has no instructions/crew fields.
- Group `items.length` ≤ 12; collected `total` ≤ 40 per group; a parent contributes ≤ 25 of each neighbor kind.
- `counts` keys are slugs; `groups[].entity` is the entity type; `groups[].type` is the tag slug.

Frontend:

- i18n key-superset includes `searchPickOne`, `searchVia`, and `searchTag.*` used by the summary.
- Merge upgrade: related task from catalog + keyword task from `/search` → one row, `match: "keyword"`, no `via`.
- Person/crew/task-only query still renders a summary from merged groups.

No new vitest for layout in this pass beyond i18n keys; merge coverage can live as a small pure helper tested with vitest if extracted, otherwise backend HTTP + a documented client helper `mergeSearchResults(catalog, scoped)` in `frontend/src/mergeSearchResults.js` with a unit test.

## 12. Files

- `backend/searchExpand.js` — tag, neighbors, dedupe, caps, counts (new). No summary string.
- `backend/routes/searchPublic.js` — call expand after keyword groups.
- `backend/test/searchExpand.test.js` — neighbor/dedupe/cap/via-order units (new).
- `backend/test/searchPublic.test.js` — HTTP cases above.
- `frontend/src/mergeSearchResults.js` — merge, keyword-upgrade, client counts (new).
- `frontend/src/mergeSearchResults.test.js` — upgrade + person-only summary inputs (new).
- `frontend/src/components/GlobalSearch.jsx` — merge helper, i18n summary, chip, via.
- `frontend/src/styles.css` — chip and via.
- `frontend/src/i18n/{en,es,zh,am}.js` — `searchPickOne`, `searchVia`, `searchTag.*`.
- `frontend/src/ui/Command.jsx` — still `/search/public` + `href` only; document why.

`GET /api/search` and landing are unchanged.
