# Line Map Workspace Design (Sub-project B2)

Date: 2026-09-10. Sub-project B2 of the six-part operations enhancement workstream
(crew status lifecycle; auto-counting substation bays + tower/asset standards; follow-up
auto-checklist; recurring schedule engine; line-inspection route tracing). Sub-projects A (crew
status lifecycle) and B1 (data integrity & counting standards) are complete. Requested workstream B
was split, in agreement with the user, into B1 and B2 (registration & geo UX). This spec covers B2:
easy tower registration and map-based line/tower visualization for counting. B1 explicitly deferred
these ("Registration UX and map-based line/tower selection are deferred to sub-project B2",
`2026-09-10-infrastructure-counting-standards-design.md:54,226`).

## 1. Problem

Registering towers along a line is slow and disconnected from the line's geometry:

- Towers are registered one at a time through a form (`frontend/src/pages/Towers.jsx:263-311`) or in
  bulk via a CSV whose `latitude`/`longitude` must be supplied by hand or copied from another tool.
  There is no way to place towers on the line's actual route.
- The route already exists as `transmission_line.route_json` — a JSON array of `[lat, lng]` pairs —
  and `POST /lines/:id/towers-from-route` (`backend/routes/core.js:607-667`) converts every route
  point into a tower, but it is all-or-nothing, gives no preview, no spacing control, and cannot be
  adjusted before saving.
- There is no map surface for a *selected line*: the global Map page (`MapPage.jsx`) shows layers,
  and the line detail modal embeds a small read-only `ViewMap`, but neither lets a user inspect
  tower/asset counts and register or adjust towers in place.
- `GET /register/tree` and `GET /api/infrastructure` already expose rich per-line tower data
  (coordinates, chainage, part counts), so the data to drive such a workspace exists; only the UX is
  missing.

As a result, registering a line's towers is tedious and error-prone, and there is no single
map-centric place to see and verify what is registered on a line.

## 2. Goals

1. A **Line Map Workspace** embedded in the Infrastructure hub where selecting a line shows its
   route and towers on an interactive map with counts.
2. **Easy tower registration**: auto-space towers along the route (by count or by spacing in km),
   click to add, drag to adjust, all staged as a preview and saved in one batch.
3. The line's **route is the master geometry**: it can be edited in the workspace, and towers are
   placed on it with their `km_marker` projected from route position.
4. A **tower panel** showing details, parts (components), and assets, including registering an
   asset pre-filled with that line/tower context.
5. **GPS capture** to drop a tower at the current device position.
6. **Bulk selection** of towers on the map with bulk delete, type/material/foundation change, parts
   reset to standard, and CSV export.

## 3. Non-goals

- No schema changes. The `tower` and `transmission_line` tables already carry every required column.
- No new map dependency: reuse the existing Leaflet stack (`ViewMap`, `MapPicker`, `LineRouteMap`).
- No change to asset geo-import (`KMZ`/`KML`), task/checklist logic, reports, valuation, or the B1
  integrity/standards behavior.
- No mobile-specific redesign; the workspace only needs to remain usable on smaller screens.
- No marker clustering in this sub-project (a line's tower count is expected to stay modest).
- Follow-up auto-checklist (C), recurring schedule engine (D), and line-inspection route tracing (E)
  remain out of scope.

## 4. Data Model & Geometry

### 4.1 No schema changes

- `tower` (`backend/db.js:91-106`) already has `tower_id`, `line_id`, `tower_number`, `km_marker`,
  `latitude`, `longitude`, `tower_type`, `tower_material`, `foundation_type`, `height_m`,
  `corrosion_rating`, `gps_validated`. Tower order is always `ORDER BY km_marker, id`.
- `transmission_line.route_json` (`backend/db.js:74`) is the authoritative route: a JSON array of
  `[lat, lng]` pairs. `length_km` and `gps_validated` are derived from it.

### 4.2 Route is master

`POST /lines/:id/route` writes `route_json` (and recomputes `length_km` / `gps_validated`), then
**re-projects every existing tower's `km_marker`** to its distance along the new route. Tower
positions are left unchanged. The tower batch endpoint does **not** call `rebuildLineRoute`
(`core.js:12-25`), so saving towers never overwrites the route. The existing per-tower CRUD/import
routes keep their current route-rebuild behavior for backward compatibility; the workspace simply
does not depend on it.

### 4.3 Geometry helpers

`backend/lineGeometry.js` (pure, no DB):

- `haversine(lat1, lng1, lat2, lng2)` — metres, matching the existing implementation.
- `distanceAlongRoute(route)` — cumulative arc length; returns total km plus a lookup of segment
  distances.
- `projectPointToRoute(route, lat, lng)` — nearest point on the polyline and the arc distance (km)
  to it; returns `{ km, snappedLat, snappedLng }`.
- `spaceAlongRoute(route, { count } | { spacingKm })` — returns `[{ lat, lng, km }]`:
  - `count` N: N points at even arc-length fractions including both route ends.
  - `spacingKm` S: points at 0, S, 2S… plus one point at the far end.

## 5. Modules

### 5.1 `backend/lineWorkspace.js`

- `setLineRoute(lineId, routeJson)` — validate (array of `[lat,lng]`, length ≥ 2), update the line,
  re-project all towers on the line, return `{ line, towers }`.
- `nextTowerSeq(lineId)` — derive the id prefix from the line (`line_id` with a leading `TL-`
  removed, e.g. `TL-C1-001` → `C1-001`) and return the next free integer suffix
  (`max existing suffix + 1`, scanning `tower_id` values matching `^<prefix>-\d+$`, else `1`).
- `batchTowers(lineId, { creates, updates, deletes })` — one transaction:
  - assign `tower_id = <prefix>-<zero-padded seq>` and `tower_number = <zero-padded seq>` for each
    create (sequence advances across the batch, skipping used ids);
  - recompute `km_marker` for every created/updated tower via `projectPointToRoute`;
  - insert `TWR-<tower_id>` mirror assets and sync `tower_count`;
  - respect the existing open-task guard on deletes; on any failure roll back and report.
- `bulkTowers(lineId, { delete: [ids], patch: [{ id, ...fields }] })` — one transaction for the map
  box-selection actions; patch accepts `tower_type`, `tower_material`, `foundation_type`.
- `bulkResetComponents(lineId, ids)` — transactional per-tower delete + `seedStandardComponents`
  (from B1's `backend/towerStandards.js`).

### 5.2 Frontend

- `frontend/src/pages/LineMapWorkspace.jsx` — the page orchestrator (accepts `embedded`).
- `frontend/src/components/LineWorkspaceMap.jsx` — interactive Leaflet map: route polyline, tower
  markers with state colors (existing / new / edited / deleted), drag handling, click-to-add, route
  draw mode, box-select. Built on Leaflet directly (like `LineRouteMap`/`MapPicker`), reusing
  `ViewMap`'s tile/pattern conventions; `ViewMap` itself stays read-only.
- Reuse existing modals/components for the tower panel (details form, component CRUD, asset form),
  `getDevicePosition()` from `MapPicker.jsx:7-33`, and `can`/`getStoredUser` from `frontend/src/auth`.

## 6. API Endpoints

All endpoints are region-scoped like existing infrastructure endpoints (`isGlobal` / `checkRegion`).
Endpoints that compute only (6.1) need read access; the rest require the exact write permission
shown.

### 6.1 `POST /api/lines/:id/route/space`

Preview-only spacing computation; nothing is written. Body is either `{ count }` or
`{ spacingKm }`. Returns `{ points: [{ lat, lng, km }] }`. Used by the auto-space popover. Requires
read access and region scope.

### 6.2 `POST /api/lines/:id/route`

Sets the line route. Requires `line:write`. Body `{ route_json: [[lat,lng], …] }` with length ≥ 2.
Re-projects existing towers' `km_marker`, updates `length_km`/`gps_validated`, audits, and returns
`{ line, towers }`. Returns 400 for malformed or too-short routes.

### 6.3 `POST /api/lines/:id/towers/batch`

Requires `tower:write`. Body:

```json
{
  "creates": [{ "lat": 0, "lng": 0, "tower_type": "SUSPENSION", "tower_material": "LATTICE_STEEL",
                "foundation_type": "PAD", "height_m": 30, "corrosion_rating": 8 }],
  "updates": [{ "id": 0, "lat": 0, "lng": 0, "tower_type": "SUSPENSION" }],
  "deletes": [0]
}
```

One transaction. Assigns ids/numbers, recomputes `km_marker`, inserts mirror assets, syncs
`tower_count`, guards deletes with open tasks. Returns
`{ created: [...], updated: [...], deleted: [ids], line: { tower_count } }`. On any failure nothing
is written and an error describing the cause is returned.

### 6.4 `POST /api/lines/:id/towers/bulk`

Requires `tower:write`. Body `{ "delete": [ids], "patch": [{ "id": 0, "tower_type": "…" }] }`. One
transaction for box-selection actions. Deletes honor the open-task guard. Returns
`{ deleted: [ids], patched: [ids] }`.

### 6.5 `POST /api/lines/:id/towers/bulk-reset-components`

Requires `tower:write`. Body `{ "ids": [ids] }`. Transactional delete + standard reseed per tower.
Returns `{ towers_reset, components_written }`.

## 7. UI

Layout A: line rail | map | tower panel, as a new `map` manage view in
`frontend/src/pages/Infrastructure.jsx` (alongside regions/substations/lines/towers/validate),
registered in `MANAGE` and the `manage` allow-list with a "Map workspace" action button.

1. **Left rail** — the hub's line selector plus a compact, scrollable tower list for the selected
   line, synced both ways with map selection.
2. **Center map** — route polyline and tower markers colored by state (existing / new / edited /
   deleted); a distance/scale readout; toolbar with **Auto-space**, **Draw route**, **Locate me**,
   **Bulk select**, and the pending-changes tray (New / Edited / Deleted counts, **Discard**,
   **Save**).
3. **Right panel** — selected tower with tabs:
   - **Details** — tower fields, editable when `tower:write`.
   - **Parts** — the existing component list/add/edit/remove, gated on `tower:write`.
   - **Assets** — assets at the tower/line plus **Register asset**, which opens the existing asset
     form modal pre-filled with `line_id`/`tower_id` (requires `asset:write`).
4. **Auto-space** — choose count or spacing; server returns preview points; they render as new
   pending markers. Disabled with a hint when the line has no route (fewer than 2 points).
5. **Draw route** — toggles route editing on the same map (drag/add/remove waypoints). Save calls
   `POST /lines/:id/route`; existing towers keep their positions and get re-projected km.
6. **Locate me** — uses `getDevicePosition()`; adds a pending tower at the device position or moves
   the selected pending tower; reports inline if the device position is unavailable.
7. **Bulk select** — box-select and shift-click select towers; the bulk bar offers Delete, Change
   type, Change material/foundation, Reset parts to standard, and Export CSV (client-side).

Read-only users (no write permissions) can open the workspace and inspect the map, counts, and
panel, but see no edit, staging, or bulk controls.

## 8. Permissions

- Viewing: existing read permissions and region scope.
- Auto-space preview (6.1): read access, region-scoped.
- Route save (6.2): `line:write`.
- Tower batch (6.3), bulk (6.4), bulk reset parts (6.5), Details/Parts editing: `tower:write`.
- Register asset from the panel: `asset:write`.

These remain ADMIN-only under the current role matrix (`backend/auth.js:94-115`); the UI gates match
the server exactly so no user sees an action they are forbidden to perform.

## 9. Verification

Repo convention: no test framework.

- `node --check` on every touched backend file; `npm run build` in `frontend/`.
- Scratch backend on an isolated DB copy (ports 3011–3013, always stopped by PID afterwards) plus
  curl checks:
  1. `POST /route/space` returns the expected number/spacing of points for both modes;
  2. `POST /towers/batch` creates towers with continued sequence ids, correct projected
     `km_marker`, and mirror assets, and updates `tower_count`;
  3. a failing batch (e.g. an update to a non-existent tower) rolls back with no partial writes;
  4. batch/bulk delete of a tower with an open task is rejected and rolled back;
  5. `POST /route` re-projects existing towers' `km_marker` and leaves their positions unchanged;
  6. `bulk` patch and `bulk-reset-components` produce the expected towers/parts in one transaction;
  7. region scoping and permission checks are enforced on every new endpoint.
- Manual end-to-end pass on a copied demo DB: select a line, auto-space, drag, save, inspect counts.

## 10. Out of Scope

- Schema changes, new map libraries, marker clustering, mobile-specific redesign.
- Asset KMZ/KML geo-import changes.
- Task/checklist, report, valuation, and B1 integrity/standards behavior.
- Follow-up auto-checklist (C), recurring schedule engine (D), line-inspection route tracing (E).
