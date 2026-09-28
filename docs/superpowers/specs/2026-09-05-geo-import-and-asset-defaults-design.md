# Geo Route/Asset Import & Asset Default Assignment

Date: 2026-09-05. Source inspiration: legacy EEP "cms" Flask system
(`.monkeycode-tmp-files/8f58bc61-cms-1.py`) — its `parse_geometry_file` /
`parse_kmz_file` / `wkt_to_geojson` / `parse_kml_to_geojson` helpers and auto line-length
computation, and its per-asset `default_crew_id`/`default_user_id` propagation. Sibling spec:
`2026-09-05-task-ops-and-analytics-design.md`.

## 1. Goal

- ⑥ Import transmission-line routes from GeoJSON/KML/WKT/CSV (text) and KMZ (zip), with auto
  `length_km` from the route geometry; import substation/transmission assets from KMZ/KML
  placemarks.
- ⑦ Per-asset **default crew** that pre-fills task creation and drives schedule generation.

## 2. Current state & constraints

- Backend is Express + Node built-in `node:sqlite`, JSON-only request bodies (no multipart
  middleware), and only `express` as a dependency.
- Master-data writes (region/substation/line/tower/asset/checklist/user) are ADMIN-only per the
  RBAC plan — imports are therefore ADMIN-gated.
- Existing assets to reuse: `POST /towers/import` (CSV string body) in `backend/routes/core.js`,
  `POST /lines/:id/towers-from-route` (route GeoJSON → towers), haversine logic inside
  `backend/routes/core.js`, `boundary_json`/`route_json` storage conventions, uploads handled
  as base64/text inside JSON.
- `asset` table currently has no default-assignment columns.

## 3. Design

### 3.1 Schema & migration

- `migrate('asset', 'default_crew_id', 'ALTER TABLE asset ADD COLUMN default_crew_id INTEGER')`
  in `backend/db.js` (no FK enforcement needed — matches existing loose references; lookups
  resolve names at read time).
- If `transmission_line` lacks a `length_km` column (implementer to confirm against current
  schema) add `migrate('transmission_line','length_km', 'ALTER TABLE transmission_line ADD COLUMN length_km REAL')`.
- Asset list/detail serializers include `default_crew_id` and resolved `default_crew: {id,name}`.

### 3.2 Line route import — ⑥

`POST /lines/import-route`, ADMIN only.

Request (JSON):
```
{ mode: 'create' | 'update',
  line_id?,                 // update mode
  name?, region_id?, voltage_level?, from_substation_id?, to_substation_id?,  // create mode
  format: 'geojson'|'kml'|'kmz'|'wkt'|'csv',
  content: string }          // text for geojson/kml/wkt/csv; base64 for kmz
```

Parsing:
- geojson: JSON `FeatureCollection`/`Feature`/raw `LineString` → coordinate array; validate with
  `validate_geojson` equivalent (≥2 `[lng,lat]`, each in range).
- wkt: `LINESTRING(lng lat, ...)` → coordinate array (port of `wkt_to_geojson`).
- csv: lines of `lng,lat` (or `lat,lng` detected by range heuristic) — same semantics as the
  existing tower CSV importer.
- kml: lightweight text scan for `<coordinates>` blocks (regex extraction of coordinate triples,
  first block wins) — no XML dependency.
- kmz: base64 → buffer → unzip first `.kml` via new dependency **`adm-zip`** (pure JS, small),
  then kml path.

Post-parse: coordinates must have ≥2 points; compute `length_km` by chained haversine over
segments; store `route_json` GeoJSON. `create` inserts a new `transmission_line` (requires
name + region_id, region must exist); `update` replaces `route_json` and `length_km` on the
existing line. On either path optionally run the existing `towers-from-route` logic is NOT
automatic — towers stay a separate explicit step. Audit `IMPORT_ROUTE` with `{mode, format,
points, length_km}`.

### 3.3 Asset import from KMZ/KML — ⑥

`POST /assets/import-geo`, ADMIN only.

Request:
```
{ format: 'kmz'|'kml', content: string,          // kmz = base64, kml = text
  default_region_id?: number,
  substation_id?: number, transmission_line_id?: number }   // applied to imported assets
```

Parsing (port of `parse_kmz_file` / placemark handling):
- Each Placemark yields `{name, asset_type?, category?, voltage_level?, installation_date?,
  last_inspection?, status?, coordinates}`.
- LineString placemarks → `geometry_data` GeoJSON + centroid `latitude/longitude`;
  Point placemarks → direct `latitude/longitude`.
- **Dry-run first**: `POST /assets/import-geo/preview` returns parsed candidates with their
  coordinates and the field mapping so the ADMIN can verify before inserting. A preview is
  mandatory UX; the real call requires `preview_token` = id/hash of a previously returned
  preview (kept in-memory, short TTL) OR simply re-parses and echoes counts for confirmation.
- Insert: rows inherit the caller-supplied `default_region_id` (or region derived from an
  optional `substation_id`/`transmission_line_id`), skip records with no usable coordinate or
  no region and report them as `skipped`. Audit `IMPORT_ASSETS` with counts.

Implementation note: if multipart remains unavailable this ships as base64-in-JSON; the KMZ
files in scope are small (< 5 MB `express.json` limit).

### 3.4 Asset default crew — ⑦

- Asset add/edit (ADMIN, existing `POST /assets`, `PUT /assets/:id`) accepts
  `default_crew_id`; the Assets form gains a "Default crew" select listing crews of the asset's
  region.
- `GET /assets` and `/assets/:id` resolve and return `default_crew`.
- Task creation (Tasks page modal): when the operator picks an asset and has not yet chosen a
  crew, auto-fill `crew_id` from `asset.default_crew_id`.
- Schedule run (`POST /schedules/run`): for each generated task, crew precedence becomes
  `asset.default_crew_id` → `schedule.responsible_crew_id` → task left unassigned, matching the
  reference's "asset defaults override schedule defaults" rule.

## 4. Files touched

- `backend/db.js` — migration for `asset.default_crew_id`.
- `backend/routes/core.js` — `POST /lines/import-route`, geometry/KMZ parsing helpers,
  haversine length.
- `backend/routes/assets.js` — `POST /assets/import-geo`, `POST /assets/import-geo/preview`,
  asset serializer `default_crew`, accept `default_crew_id` on create/update.
- `backend/routes/schedules.js` — run-time crew precedence.
- `backend/package.json` — add `adm-zip`.
- Frontend: `Assets.jsx` (default-crew select + import modal w/ preview), `Lines.jsx` (route
  import modal), `Tasks.jsx` (crew auto-fill).

## 5. Error handling & verification

- Bad geometry / wrong format / empty placemark sets return 400 with a specific message; no
  partial inserts when a validation failure occurs before insert (parse fully, then insert).
- Verify with ADMIN: create a line via GeoJSON and via KML (length_km matches reference
  haversine), update an existing line's route, KMZ asset preview shows candidates and the
  confirm inserts only valid records, skipping ones without coordinates; set a default crew on
  an asset, confirm the Tasks modal pre-fills it and a schedule run prefers it over the
  schedule's crew. `node -c` on touched files, `npm run build` clean, `npm install adm-zip`
  completes, non-ADMIN import attempt → 403.

## 6. Out of scope

Automatic tower generation from imported routes (explicit `towers-from-route` remains the
tool), per-user defaults (`default_user_id`), API token endpoints, and the reference's broken
`boundary_coordinates` region-editing behavior.
