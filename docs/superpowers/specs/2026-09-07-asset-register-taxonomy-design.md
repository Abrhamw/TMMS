# Asset Register Taxonomy & Hierarchy

Date: 2026-09-07. First workstream (A) of a requested enhancement set, in agreement with the
user. Related (future) sibling specs will cover: pricing/counting rollups (B), checklist
attribution + region/department/crew/member performance reports (C), task-from-follow-up with
best-fit checklist (D), and print-area hardening (E). This spec covers asset structure only.

## 1. Goal

Give the asset register a real physical structure and a controlled vocabulary so that an asset
sits in an unambiguous place in the network:

- Region → Substation, where indoor equipment is organized into the standard system families
  (control & protection, SAS/RTU, DC & auxiliary, MV switchgear) then bay then asset.
- Region → Transmission line, where the line carries conductor/OPGW span assets, joint boxes at
  roughly 4–5 km chainage, and towers with their part registers.
- A controlled, admin-editable catalog of families → asset types → subtypes with unit of measure
  and (later) default unit price. The catalog keys are the stable spine for the future pricing
  rollup (B) and the checklist asset-type matching (D).

## 2. Current state

- `asset` (`backend/routes/assets.js` schema, `TMMS_SPEC.md` §6.3) already has `asset_type`,
  `sub_type`, `parent_asset_id`, `substation_id`, `line_id`, `tower_id`, `location_type`, `bay`,
  `condition_rating`, `lifecycle_status`, `operational_status`, `criticality`, `metadata`.
- `asset_type` today is freeform. `guessAssetType(name)` (`assets.js:17`) heuristically maps KMZ/
  KML names to a small vocabulary (TRANSFORMER, CIRCUIT_BREAKER, DISCONNECTOR, CT, VT,
  PROTECTION_RELAY, BATTERY_BANK, SCADA_RTU, …). Nothing enforces a type and no family grouping
  exists.
- Line side: `tower` per line (`tower_number`, `km_marker`, `foundation_type`, …) and
  `tower_component` part rows (`component_type`, `name`, `material`, `quantity`, …) managed via
  `core.js` `/towers/:id/components`.
- Browse UI (`frontend/src/pages/Assets.jsx`) is a flat table plus a card view grouped only by
  `substation_id`; line/tower-only assets fall into an “uncategorized” bucket. Towers,
  substations and lines are managed on separate pages.
- Region scoping is centralized (`scopeRows`, `checkRegion`, `isGlobal` in `backend/auth.js`);
  all list/detail endpoints already respect it.

## 3. Decisions (confirmed with user)

1. Indoor equipment families are a **catalog + virtual groups**: every asset type belongs to a
   family; browse groups by family → bay → asset. `parent_asset_id` is used only for real
   physical composition (e.g., bushing under transformer). No synthetic container asset rows.
2. Line side is **span/JB assets + tower part register**: conductors/OPGW are span asset rows
   located by `km_from..km_to`; joint boxes are point assets at a km marker every ~4–5 km; towers
   keep `foundation_type` and `tower_component` for small fittings; individual insulators/dampers
   do NOT become asset rows.
3. The families/types/subtypes catalog is a **database table** (`asset_catalog`), admin-editable,
   seeded at boot, and a superset of every `asset_type` currently in use.
4. This round delivers **model + full tree register UI + backend tree endpoint**.
5. Joint-box placement is **chainage-interval auto-placement** (line setting, default 5 km) with
   a dry-run/confirm action plus manual entry.

## 4. Catalog data model

New table `asset_catalog`:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `family` | TEXT NOT NULL | e.g. `CONTROL_AND_PROTECTION` |
| `family_label` | TEXT NOT NULL | e.g. “Control & Protection” |
| `asset_type` | TEXT NOT NULL | e.g. `PROTECTION_RELAY` |
| `sub_type` | TEXT NULL | type refinement, empty string = none |
| `unit_of_measure` | TEXT NOT NULL | `EA`, `KM`, `PANEL`, `BANK` |
| `default_unit_price` | REAL NOT NULL DEFAULT 0 | filled by pricing workstream (B) |
| `location_kind` | TEXT NOT NULL | `SUBSTATION` / `LINE` / `TOWER` / `ANY` |
| `default_location_type` | TEXT NULL | `INDOOR` / `OUTDOOR` / … |
| `attribute_schema` | TEXT NULL | JSON of extra form fields for this type |
| `active` | INTEGER NOT NULL DEFAULT 1 | |
| UNIQUE | | `(family, asset_type, sub_type)` |

Seeded families (unit, location hint):

- `CONTROL_AND_PROTECTION` (EA/PANEL, INDOOR): `PROTECTION_RELAY`, `RELAY_PANEL`, `METER`,
  `SUBSTATION_CONTROLLER`.
- `SAS_RTU_AND_TELECOM` (EA, INDOOR): `SCADA_RTU`, `IED`, `COMMUNICATION_RADIO`,
  `NETWORK_SWITCH`, `OPTICAL_FIBER`.
- `DC_AND_AUXILIARY` (EA/BANK, INDOOR): `BATTERY_BANK`, `BATTERY_CHARGER`,
  `DC_DISTRIBUTION_PANEL`, `AUXILIARY_TRANSFORMER`, `UPS`.
- `MV_SWITCHGEAR` (EA, INDOOR): `SWITCHGEAR`, `GIS`, `MV_CIRCUIT_BREAKER`, `MV_DISCONNECTOR`.
- `HV_YARD_AND_TRANSFORMATION` (EA, OUTDOOR): `TRANSFORMER`, `AUTO_TRANSFORMER`,
  `HV_CIRCUIT_BREAKER`, `DISCONNECTOR`, `GROUND_SWITCH`, `CT`, `VT`, `LIGHTNING_ARRESTER`,
  `BUSBAR`, `REACTOR`, `CAPACITOR_BANK`, `EARTHING_MAT`.
- `CONDUCTOR_AND_OPGW` (KM, LINE): `CONDUCTOR_SPAN`, `OPGW_SPAN`.
- `JOINT_BOX` (EA, LINE): `JOINT_BOX`.
- `TOWER_PARTS` (EA, TOWER): `INSULATOR_STRING`, `DAMPER`, `SPACER`, `HARDWARE_FITTING`,
  `CONDUCTOR_CLAMP` — vocabulary for `tower_component.component_type`.

Legacy mapping: seed guarantees the catalog is a superset of (a) the `guessAssetType` vocabulary
and (b) the distinct `asset_type`/`sub_type` values actually present in the DB, so every existing
row stays typable. Backend create/update validates `asset_type` (and `sub_type` where the catalog
declares non-empty subtypes) against the catalog → `400` on unknown values. `GET /api/asset-catalog`
serves the catalog (region-independent read for any authenticated user); admin create/update/
deactivate endpoints are gated by an existing `asset:write`-style permission.

## 5. Location & positioning model

- `asset` gains `km_from REAL NULL`, `km_to REAL NULL` (chainage along `line_id`). An asset is
  anchored by exactly one of: `substation_id`, `tower_id`, `line_id` with a km range, or (for
  legacy rows) an explicit `latitude`/`longitude` with no structural anchor. Validation on
  create/update rejects conflicting/combined anchors (e.g., substation + line, or tower + km
  range).
- `CONDUCTOR_SPAN`/`OPGW_SPAN`: `line_id + km_from..km_to`. Consecutive tower gaps give natural
  spans, but arbitrary km ranges are allowed.
- `JOINT_BOX`: `line_id` with `km_from = km_to = chainage`.
- `transmission_line` gains `joint_box_interval_km REAL NOT NULL DEFAULT 5`.
- Tower parts remain `tower_component`, with `component_type` offered from the `TOWER_PARTS`
  catalog family.
- **JB auto-placement** `POST /api/lines/:id/generate-joint-boxes`:
  - Reads cumulative chainage (sorted tower `km_marker`, falling back to route points).
  - Proposes one `JOINT_BOX` asset per multiple of `joint_box_interval_km` from line start.
  - `dry_run=true` returns the proposal list without writing; `dry_run=false` writes it.
  - Idempotent: a position already holding a `JOINT_BOX` within ±0.25 km is skipped.
  - Naming `JB-<LINE>-<seq>`; `asset_id` records the km (e.g., `JB-C2-001-01` at `12.5 km`).
  - Audited (`audit`); requires line write permission + region scope.
  - Auto-suggested (dry-run modal) after tower-batch import on a line that has no JBs.

## 6. Backend register-tree endpoint

`GET /api/register/tree?region_id=&family=&q=` (scope-aware):

- Region root list: `[{ id, code, name, substations:[], lines:[], counts:{…} }]`. Without a
  region filter, every region node carries subtree counts computed server-side.
- Substation node children: families present (from `asset_catalog`) → bays (sorted, with the
  flat “no bay” bucket last) → assets; assets nested under their `parent_asset_id` first, then
  siblings.
- Line node children:
  - `conductors` group (CONDUCTOR_AND_OPGW spans, sorted by `km_from`);
  - `jointBoxes` group (JOINT_BOX, sorted by km);
  - `towers` sorted by `km_marker`, each with `part_count` and inline `tower_component` summary
    (full parts reuse the existing `/towers/:id/components` fetch on expand).
- Node counts: per family / type / bay / substation / line; equals the existing `/register`
  summary tallies (a verification invariant, §9).
- Flat `/assets`, `/register` summary, detail, edit/delete, and import endpoints unchanged.
- Scoping identical to existing list endpoints (region managers see only their region; global
  roles see all).

## 7. Register UI

- `Assets.jsx` gains a left **Register** pane as the default view:
  - scope selector (region, or global);
  - expandable tree: Region → Substation|Line → (family → bay → asset | conductor/OPGW spans,
    joint boxes, towers → parts);
  - count badges from §6 node counts;
  - click leaf → existing detail drawer; “New asset” pre-fills substation/bay or line/km from the
    node context (permissions-gated as today);
  - Line node action “Generate joint boxes” (dry-run then confirm), shown only with line write
    permission in the line’s region.
- Table and card views remain available as toggles (bulk ops / import flows).
- New catalog manager (a tab in Assets or a small admin page): manage families/types/subtypes/
  unit/active; create/update gated by the same asset write permission.
- New asset/edit forms switch `asset_type` (and `sub_type`) to catalog-driven dropdowns; extra
  type-specific fields appear from `attribute_schema`.
- No print work in this spec (workstream E).

## 8. Demo data

- Seed one C1 substation with indoor assets spread across CONTROL_AND_PROTECTION,
  SAS_RTU_AND_TELECOM, DC_AND_AUXILIARY, MV_SWITCHGEAR (+ a transformer in the HV yard).
- Seed one C1 line’s towers (already present) plus a set of `CONDUCTOR_SPAN`/`OPGW_SPAN` rows and
  generate its JBs so the register tree is demonstrable end-to-end.

## 9. Migration, validation & testing

- Boot migration (idempotent, in the existing `migrate*` style): add `asset.km_from`/`asset.km_to`,
  `transmission_line.joint_box_interval_km`, create + seed `asset_catalog`, backfill `asset_catalog`
  rows for any distinct in-use types missing from the seed list.
- `node -c` on all touched backend files; `npm run build` for the frontend.
- Targeted e2e on an isolated DB copy (same pattern as the earlier audit verification):
  1. region manager calling `GET /api/register/tree` sees only own region’s substations/lines;
  2. span and JB assets respect the one-anchor rule and region rules;
  3. `generate-joint-boxes` is idempotent, names `JB-<LINE>-<seq>`, skips positions with an
     existing JB within ±0.25 km;
  4. tree counts equal register-summary DB counts per scope;
  5. unknown `asset_type` on create/update → `400`.

## 10. Out of scope

- Pricing/counting rollups with prices (B); report attribution of checklist filler and
  region/department/crew/member performance (C); task-from-follow-up best-fit checklist (D);
  print-area hardening (E). Each gets its own spec after A lands.
