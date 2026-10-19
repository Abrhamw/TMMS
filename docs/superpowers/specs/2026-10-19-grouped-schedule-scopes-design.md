# Grouped Schedule Scopes Design

Date: 2026-10-19.

## 1. Problem

Schedules can target one line, one substation, or one asset, or fan out over all
assets in a region (`REGION`) or one asset type everywhere (`ASSET_CLASS`). There
is no way to schedule work across a *set of entities* with one task per entity:

- all lines, or lines narrowed by region and voltage level;
- all substations, or substations narrowed by region and voltage level;
- all transformers, circuit breakers, or other equipment types, narrowed the
  same way;
- an explicit hand-picked set of lines, substations, or assets.

Planners currently work around this by creating one schedule per entity, which
does not follow the register as lines and equipment are added or retired, and
multiplies the maintenance burden.

## 2. Goals

1. Add grouped scopes that generate exactly one task per matching line,
   substation, or asset.
2. Support two selection modes: all entities matching region/voltage criteria,
   or an explicit set of picked entities.
3. Re-evaluate criteria on every occurrence so newly registered entities are
   picked up and retired entities drop out.
4. Keep the existing scopes, generation pipeline, batch cap, occurrence
   bookkeeping, backlog guard, and authority model unchanged.
5. Make the scope visible and predictable in the form before saving, with a live
   match count.

## 3. Non-goals

- Tower grouping beyond the existing `LINE_TOWERS` and `TOWER` scopes.
- Condition, criticality, or age filters; the filter set is region + voltage +
  explicit picks.
- Creating one schedule row per entity.
- Changing how existing scopes expand or are stored.

## 4. Scope model

Three scope types are added:

| Scope type | Entity | Task anchor | Required |
| --- | --- | --- | --- |
| `LINE_GROUP` | `transmission_line` | `task.line_id` | none |
| `SUBSTATION_GROUP` | `substation` | `task.substation_id` | none |
| `ASSET_GROUP` | `asset` | `task.asset_id` | `asset_type` |

Existing scopes (`ASSET`, `ASSET_CLASS`, `SUBSTATION`, `LINE`, `LINE_TOWERS`,
`TOWER`, `REGION`) keep their current semantics.

### 4.1 Stored fields

`maintenance_schedule` gains one column:

```sql
scope_filter TEXT
```

It stores JSON and is null for every existing row and for non-group scopes:

```json
{
  "mode": "FILTER",
  "voltages": [230, 132],
  "ids": []
}
```

- `mode`: `FILTER` (default) or `SPECIFIC`.
- `voltages`: positive kV numbers. An empty array means any voltage.
- `ids`: numeric row ids of the selected entities. Required and non-empty in
  `SPECIFIC` mode; ignored in `FILTER` mode.

`region_id` is reused as an optional filter for `FILTER` mode. `asset_type` is
required for `ASSET_GROUP` in both modes. In `SPECIFIC` mode the picked entities
are authoritative; region and voltage are not applied.

### 4.2 Dynamic criteria

Filters are re-evaluated on every generation run. A line commissioned later with
a matching region and voltage is included in the next occurrence; a line that
leaves the matching set is no longer generated. `SPECIFIC` picks are stable ids:
if an entity is deleted, it simply stops matching.

## 5. Voltage matching

Voltage is stored differently per entity:

- Lines: `transmission_line.voltage_kv` (number).
- Substations: `substation.voltage_levels` (JSON array of strings such as
  `["230kV","15kV"]`).
- Assets: no voltage column. Derive from the parent:
  - `asset.line_id` -> line `voltage_kv`;
  - else `asset.substation_id` -> substation levels;
  - else `asset.tower_id` -> tower's line `voltage_kv`.

An entity matches if **any** of its voltage levels is in the selected set. A line
with `voltage_kv = 230` matches `230`. A substation whose levels include
`230kV` matches `230`. An asset matches when its parent does.

Substation levels are parsed by stripping a trailing `kV` (case-insensitive),
trimming, and converting to a number. Entries that cannot be parsed are ignored.

## 6. Expansion and counting

Expansion and counting share one predicate per scope so the count, due state,
and generation never disagree.

### 6.1 `FILTER` mode

`LINE_GROUP`:

```sql
SELECT * FROM transmission_line
 WHERE (:region_id IS NULL OR region_id = :region_id)
   AND (:voltage_count = 0 OR voltage_kv IN (:voltages))
```

`SUBSTATION_GROUP`:

```sql
SELECT * FROM substation
 WHERE (:region_id IS NULL OR region_id = :region_id)
   AND (:voltage_count = 0 OR EXISTS (
         SELECT 1 FROM json_each(substation.voltage_levels)
          WHERE CAST(REPLACE(TRIM(json_each.value), 'kV', '') AS REAL) IN (:voltages)))
```

`ASSET_GROUP`:

```sql
SELECT * FROM asset
 WHERE asset_type = :asset_type
   AND lifecycle_status IN ('IN_SERVICE','UNDER_MAINTENANCE')
   AND (:region_id IS NULL OR <asset region via parent> = :region_id)
   AND (:voltage_count = 0 OR <asset voltage via parent> IN (:voltages))
```

`<asset region via parent>` and `<asset voltage via parent>` are the derivations
described in section 5. They are implemented as correlated subqueries in the same
predicate used for counting and expansion.

### 6.2 `SPECIFIC` mode

Select the entity table by `id IN (:ids)`. For `ASSET_GROUP`, every picked asset
must have the stored `asset_type` and be live; otherwise the request is rejected.

### 6.3 Ordering and samples

Lines order by name, substations by name, assets by name. The detail view keeps
the existing cap of 200 materialised targets; lists keep using counts.

## 7. Task generation and coverage

One task is generated per entity. Task fields:

| Target | `line_id` | `substation_id` | `asset_id` | `tower_id` | title |
| --- | --- | --- | --- | --- | --- |
| Line | `line.id` | null | null | null | `schedule — line.name` |
| Substation | null | `substation.id` | null | null | `schedule — substation.name` |
| Asset | asset's line | asset's substation | `asset.id` | null | `schedule — asset.name` |
| Tower | as today | as today | null | `tower.id` | as today |

For line and substation targets, `task.region_id` comes from the entity's own
`region_id`. Asset targets keep the current parent-derived region.

Target keys become `l:<id>`, `s:<id>`, `a:<id>`, `t:<id>`. Coverage compares the
matching task anchor column, so a second run in the same occurrence does not
duplicate an entity. Batch size, occurrence stamping, the backlog guard,
`NO_TARGETS`, and `SWEEP_IN_PROGRESS` are unchanged.

## 8. API

### 8.1 Validation

`normalizeScheduleScope` is extended:

- Parse and validate `scope_filter` (accepting a JSON string or object).
- `mode` must be `FILTER` or `SPECIFIC`.
- `voltages` must be an array of positive numbers; `ids` an array of positive
  integers.
- `SPECIFIC` requires at least one id; `FILTER` discards ids.
- `ASSET_GROUP` requires `asset_type`.
- Every `SPECIFIC` id must exist in the right table; assets must match the
  stored type and be live.
- A region-bound caller may only pick entities in their own region; ids outside
  it return 400. Callers with cross-region authority may mix regions.
- Non-group scopes clear `scope_filter`; `asset_type` is kept only for
  `ASSET_CLASS` and `ASSET_GROUP`.

`POST /schedules` and `PUT /schedules/:id` use the same normalisation. A `PUT`
re-normalises when the request touches `scope_type`, `scope_filter`, `region_id`,
or `asset_type`.

### 8.2 Preview

New `GET /schedules/scope-preview` accepts the same scope fields and returns:

```json
{ "count": 82, "sample": ["Line A", "Line B"], "scope_summary": "Lines · 230 kV" }
```

It is read-only and requires `schedule:read`. Region-bound callers are pinned to
their own region; callers with cross-region authority may preview any region.

### 8.3 Detail and list

`scheduleDetail` returns `scope_filter` and a human-readable `scope_summary`
(e.g. `Lines · 230 kV · Region A`, `Substations · 12 specific`,
`Assets · TRANSFORMER · 230 kV`).

## 9. UI

The schedule form keeps the existing scope selector and adds three entries:
Line group, Substation group, Asset group.

For grouped scopes:

- Mode toggle: All matching criteria / Specific entities.
- Region select with "All regions".
- Voltage multi-select chips derived from the lines and substations already
  loaded by the page; hidden in Specific mode.
- Asset type select for Asset group (required).
- Specific mode: a searchable multi-select of entities, filtered by region and,
  for assets, by asset type.
- Live preview under the picker using `scope-preview`: the match count plus a
  short name sample.
- Batch size remains available as today.

The schedule list and detail show `scope_summary` in place of raw scope fields.

New i18n keys cover the three scope labels, both modes, the preview text, the
region/voltage labels, and the summary fragments.

## 10. Error handling

- Invalid filter JSON, mode, voltage, id, or asset type returns 400 with a
  specific message.
- Empty `SPECIFIC` selection returns 400.
- An empty `FILTER` match is allowed to save; a run reports `NO_TARGETS`.
- One failing target insert does not abort the sweep (existing behaviour).
- Non-global region-bound users are pinned to their region, matching the current
  create behaviour.

## 11. Migration

`db.js` adds `scope_filter` to `maintenance_schedule` idempotently
(`ALTER TABLE ... ADD COLUMN` guarded by a column check). No backfill is needed:
existing scopes ignore the column.

## 12. Testing

Backend:

- Filter expansion for lines and substations by region and voltage, including
  the any-level substation match and asset parent-voltage derivation.
- One task per line/substation/asset with the correct anchor column and region.
- Dynamic behaviour: an entity added between runs is generated; one removed is
  not.
- Specific-mode selection and asset-type validation.
- No duplication within an occurrence; batch cap and backlog guard still work.
- Empty match reports `NO_TARGETS`.
- Validation failures return 400; preview count matches generation count.

Frontend: mode switching, required asset type, specific picker validation,
preview rendering, existing tests and build.

## 13. Known limitations

- Voltage is derived from parents for assets; equipment whose operating voltage
  differs from its substation's listed levels cannot be filtered directly.
- No condition/criticality/age filters in this iteration.
- Grouped scopes generate one task per entity and therefore do not attach
  per-asset cost/condition records the way asset-level scopes do.
