# Tagged Related Search Design

Date: 2026-10-26.

## 1. Problem

Header search already AND-matches keywords and groups rows by entity type. A dispatcher who types a substation name still only sees records whose own fields contain those tokens. They do not see the transformers, lines, towers, tasks, and schedules that belong to that place, so they cannot pick the right record from one tagged list.

Login-only catalog search (`GET /api/search/public`) and the deny banner stay as they are. This pass adds related expansion and a pick-from-tagged UI.

## 2. Goals

1. One query in the header search box.
2. After keyword hits, walk one hop of related records from every hit at once.
3. Deduplicate: each record appears once; related rows list every parent in `via`.
4. Return a count summary plus fine-tag groups. The user picks one row.
5. Keep login required, descriptions on every catalog/related row, and `can_open` / deny-banner rules.

## 3. Non-goals

- SQLite FTS, fuzzy match, or changing AND tokenization.
- Two-step “pick the substation first, then expand”.
- Landing-page search (landing stays persona-only).
- Saved searches, history, or typeahead beyond live grouped results.
- Expanding people or crews as related records.
- Fan-out from a related record (no second hop).

## 4. Approach

Expand on the existing `GET /api/search/public` response (login required). Shared helper `backend/searchExpand.js` builds related rows, tags, dedupe, and the summary line. `GET /api/search` stays keyword-only and permission-scoped so existing scoped-task tests stay stable.

Header `GlobalSearch` keeps calling both endpoints and merging:

- Primary list: tagged catalog + related from `/search/public`.
- Extra groups from `/search`: `person`, `crew`, and keyword-hit `task` rows not already present (dedupe by `type` + `id`).

Ctrl-K uses `/search/public` and only lists rows that have `href` (openable). Locked description-only rows stay in the header panel, not the palette.

## 5. Keyword hits

Unchanged AND engine (`tokenize` / `matches` / `rank` / `searchGroup`).

`/search/public` keyword types remain: region, substation, line, tower, asset, schedule. Limit 8 items per type.

`/search` keyword types remain: task, asset, crew, person, substation, line, tower, region, schedule — each still gated by the matching `:read` perm and command scope.

A query with no keyword hits returns the current empty payload. Related expansion does not run, so the panel shows “No matches.” and never invents neighbors.

## 6. Related expansion

Input: the keyword-hit items (full unsliced hit set per type, not only the 8 shown). Output: related items with `match: "related"` and `via` set to unique parent titles in visit order.

One hop from each keyword hit:

| Keyword hit | Related records |
| --- | --- |
| Region | Substations in that region; lines in that region |
| Substation | Assets with `substation_id`; lines whose `from_substation_id` or `to_substation_id` is the substation; those lines’ towers and assets; tasks and schedules that target the substation or those lines |
| Line | Towers and assets on the line; from/to substations; tasks and schedules on that line |
| Tower | Parent line; assets with `tower_id`; tasks and schedules on that tower or its line |
| Asset | Parent substation or line; tasks and schedules on that asset |
| Schedule | Its target only (substation, line, or asset on the schedule). Do not fan out from that target |
| Task | Not expanded on `/search/public` (tasks are not a catalog keyword type). Keyword-hit tasks from `/search` appear as extra tagged rows without further fan-out |

Task and schedule targeting uses the existing columns: `substation_id`, `line_id`, `tower_id`, `asset_id`, and for schedules also `scope_type` plus grouped-scope filters already stored on the row. A schedule with `scope_type = LINE` and `line_id = L` is related to line L. A task with `asset_id = A` is related to asset A.

Do not walk from a related record. A line pulled in because it starts at the matched substation does include that line’s towers and assets (that is the approved “one hop further” for a substation hit). A line that is itself a keyword hit does not pull transformers out of its endpoint substations.

## 7. Dedupe, tags, caps

Dedupe key: `type` + `id` (entity type, not display tag). First visit keeps the row. Later visits only append the new parent title to `via` (unique, visit order). Keyword hits have no `via`. If a record is both a keyword hit and related, it stays `match: "keyword"` and has no `via`.

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
| asset | Title-case of `asset_type` with underscores to spaces: `TRANSFORMER` → Transformer, `CIRCUIT_BREAKER` → Circuit breaker, `AUTO_TRANSFORMER` → Auto transformer. Empty or unknown `asset_type` → Asset |

Groups are keyed by `tag`. Each group’s `type` field is the tag slug (lowercase, underscores): `transformer`, `circuit_breaker`, `substation`. Existing tests that look for `g.type === 'asset'` must switch to the fine tag (`transformer`, …). The item’s `type` field stays the entity type (`asset`, `line`, …) so navigation and `OPEN_PERM` still work.

Each tag group’s `items` array is sliced to 12: keyword hits first (existing rank, then id desc), then related (id desc). `total` on the group and `counts` on the payload use the unsliced size.

## 8. Response shape

`GET /api/search/public`:

```
{
  query: "sululta",
  summary: "sululta: 1 substation, 2 lines, 4 transformers, 3 tasks, 1 schedule — pick one",
  counts: { substation: 1, line: 2, transformer: 4, task: 3, schedule: 1 },
  total: 11,
  groups: [
    {
      type: "substation",
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

`summary` is `{query}: {n} {label}, … — pick one`. `query` is the raw trimmed string. Zero counts are omitted. Labels are the tag in lowercase; plural is `label + 's'` except `person` → `people`. Count order: region, substation, line, tower, then remaining asset tags alphabetically, then task, schedule, crew, person.

`total` is the sum of unsliced group totals (same meaning as today).

Item fields:

- `description` always present on catalog and related infra/task/schedule rows.
- `can_open` from the existing `OPEN_PERM` map; tasks use `task:read`. False → omit `href`.
- `match` is `"keyword"` or `"related"`.
- `via` only on related rows: array of parent titles.

Blank query: `{ query: "", summary: "", counts: {}, total: 0, groups: [] }`.

No serial numbers, manufacturer, model, condition, GPS, or people on catalog/related infra rows. Related tasks expose title, task number, status in subtitle/description only.

## 9. UI

`GlobalSearch` panel, after a non-empty result:

1. Summary line at the top (the `summary` string).
2. Groups labeled with `label` and `total`.
3. Each row: tag chip, title, description. Related rows add muted `via {names joined by ", "}`.
4. Click `can_open: true` → navigate or open document as today. Click `can_open: false` → existing deny banner, no navigation.
5. Empty and error states unchanged.

Landing page stays persona-only. Executives keep the header search box.

## 10. Permissions

`/search/public` stays behind `requireAuth` (401 without a token). Related expansion is catalog-wide (same as today’s catalog keyword hits): it does not apply `commandScope`. Every related row is returned with a description. `can_open` is `can(req, OPEN_PERM[entityType])`; for tasks the perm is `task:read`. False → no `href`.

CREW_MEMBER has FIELD_READS plus `task:read`, but not `schedule:read`. Related schedules stay visible as description-only. Extra groups merged from `/search` (person, crew, scoped keyword tasks) stay command-scoped as today.

## 11. Tests

Backend (`backend/test/searchPublic.test.js` plus unit tests on `searchExpand.js`):

- Token still required (401).
- AND match unchanged; missing token still yields total 0.
- Catalog keyword types remain the six; related may add `task` and extra infra tags.
- Items always have `description` and `can_open`; payload never includes `SECRET-SERIAL`.
- Substation keyword hit expands to its lines, those lines’ towers/assets, transformers in the yard, and tasks/schedules targeting the substation or those lines.
- A line related to two keyword hits appears once with both parent titles in `via`.
- A record that is both a keyword hit and related stays `match: "keyword"` with no `via`.
- Crew member: related schedule `can_open: false`, no `href`.
- Summary counts match unsliced group totals; `items.length` ≤ 12 per group.
- Blank query: empty summary and counts.

Frontend: existing i18n key-superset test covers new strings (`searchPickOne` is inside the server-built summary, so only `searchVia` needs a dictionary key if the UI prefixes via). No new vitest for the panel in this pass.

## 12. Files

- `backend/searchExpand.js` — tag, neighbors, dedupe, summary (new).
- `backend/routes/searchPublic.js` — call expand after keyword groups.
- `backend/test/searchExpand.test.js` — neighbor/dedupe/summary units (new).
- `backend/test/searchPublic.test.js` — HTTP cases above.
- `frontend/src/components/GlobalSearch.jsx` — summary, chip, via.
- `frontend/src/styles.css` — chip and via.
- `frontend/src/i18n/{en,es,zh,am}.js` — `searchVia` (“via”).
- `frontend/src/ui/Command.jsx` — unchanged filter (openable `href` only).

`GET /api/search` and landing are unchanged.
