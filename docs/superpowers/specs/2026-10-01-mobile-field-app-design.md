# TMMS Mobile Field App — Design

Date: 2026-10-01
Status: Approved (design); awaiting implementation plan

## Problem

TMMS is delivered as a React 19 + Vite web client over an Express + `node:sqlite`
REST API. Field crews (roles `CREW_LEAD`, `CREW_MEMBER`, `FIELD_CREW`) work at
towers and substations where a browser on a laptop is impractical and mobile
signal is unreliable. They need a native phone application — not a responsive
web page and not a WebView wrapper — that lets them see assigned work, execute
checklists, capture findings, photos and GPS, trace the line route, and use the
task mailbox, including while offline.

The web app already exposes everything these tasks need over `/api`. The mobile
app is therefore a second, native consumer of the same API and database.

## Goals

- A native Android + iOS application for field crews.
- Same server, same data, same authentication as the web app.
- Usable offline: view assigned work, fill checklists, capture findings,
  photos and GPS with no signal; sync automatically when connectivity returns.
- Interactive map with the assigned line, towers, route overlay and live GPS
  tracing.
- Additive to the existing repo; the web app keeps working unchanged.

## Non-Goals

- Management/analytics/report/admin screens. Scope is field-crew work only.
- Full web feature parity.
- A WebView or PWA. The app is native.
- Two-way real-time push. Sync is pull + queued push.
- Public app-store publication during this work.

## Decisions

Recorded from the requirements dialogue:

| Topic | Decision |
|---|---|
| Platform | Native Android + iOS |
| Scope | Field-crew app (sign in, my work, task detail, checklist, findings, GPS/route, photos, mailbox) |
| Connectivity | Offline-capable: local cache + queued writes, auto-sync |
| Server address | User-entered server URL, validated, saved, reused |
| Framework | React Native / Expo (TypeScript) |
| Map | MapLibre RN (OSM tiles, no API key) with offline tile cache; requires a dev build (not Expo Go) |
| Idempotency | Add an optional `client_ref` to the append-only write endpoints so offline retries cannot duplicate |
| Sync model | Offline read cache + append-only outbox (not a reactive sync engine) |

## Architecture

A new `mobile/` Expo application in the TMMS repository, alongside `frontend/`
and `backend/`. It never imports backend code; it talks to the same REST API
over HTTPS with a Bearer JWT, and keeps its own SQLite store.

```
/server (existing Express + node:sqlite + REST API)
        ^  HTTPS / Bearer JWT
        |
/mobile  Expo (React Native, TypeScript)
  App Router (tabs + stacks)
  src/api   typed REST client
  src/db    expo-sqlite cache + outbox
  src/sync  flusher (NetInfo trigger, backoff, ordering)
  src/auth  SecureStore: server URL + JWT
  src/map   MapLibre + trace recorder
```

The mobile app has three cooperating layers with narrow interfaces:

1. **API client** — thin, typed wrappers over the REST endpoints. Knows nothing
   about SQLite or connectivity.
2. **Store (`src/db`)** — SQLite schema, queries and the `outbox` table. The
   single place the UI reads from.
3. **Sync engine (`src/sync`)** — reads the outbox and calls the API client.
   Knows nothing about UI.

The UI reads only from the store, so every screen renders from cache and works
offline by construction. The sync engine is the only component that performs
writes against the server.

## Repository Layout

```
mobile/
  app/                       # expo-router
    _layout.tsx
    (setup)/index.tsx        # server URL + sign in
    (tabs)/_layout.tsx
    (tabs)/work.tsx          # My Work
    (tabs)/map.tsx           # Lines / map
    (tabs)/mail.tsx          # Mailbox
    (tabs)/sync.tsx          # Sync status + settings
    task/[id].tsx            # Task detail
    task/[id]/checklist.tsx  # Checklist execution
    task/[id]/trace.tsx      # Route / GPS tracing
  src/api/client.ts          # fetch wrapper, Bearer, 401 handling
  src/api/endpoints.ts       # typed endpoint functions
  src/db/schema.ts           # CREATE TABLE statements + migrations
  src/db/queries.ts          # read/upsert helpers
  src/db/outbox.ts           # enqueue/list/done/fail
  src/sync/engine.ts         # flush loop, ordering, backoff
  src/auth/session.ts        # SecureStore read/write of url + token
  src/map/                   # MapLibre view + trace recorder
  src/components/            # SearchSelect, StatusChip, SectionCard
  app.json / eas.json / tsconfig.json / package.json
```

TypeScript, strict, no comments (matching the web frontend conventions).

## Screens

Bottom tab bar: **My Work · Map · Mail · Sync/Settings**. Stack pushes from a
task row into task detail, then checklist or trace.

1. **Setup / Sign in** — server URL field (validated against `GET /api/health`),
   username, password (`POST /api/auth/login`), JWT to SecureStore. On later
   launches the saved URL/token are used; an invalid token returns here.
2. **My Work** — the crew's assigned tasks (status, task number, target, due,
   crew) with type-to-filter and status/region cascades. Pull-to-refresh; renders
   from cache when offline; a pending-change badge when the outbox is non-empty.
3. **Task detail** — target (asset/tower/line), readiness, the equipment
   instruction list, checklist templates, findings, photos, comments and the
   task mail thread. Reuses the cross-links and comment model already stored
   server-side.
4. **Checklist execution** — per-item inputs (numeric reading, pass/fail, text,
   photo, captured GPS). **Save draft** → `POST /tasks/:id/checklist/draft`
   (per-person, resumable); **Submit** → `POST /tasks/:id/checklist`. Draft and
   submit are queued to the outbox so both survive offline.
5. **Findings** — create a finding with asset/tower/equipment/checklist-item
   cross-links and photos; comment on any entity with `@`-tagging, mirroring the
   web behaviour.
6. **Route tracing** — MapLibre map with the line geometry
   (`GET /api/lines/:id/route`), tower markers, crew path overlay and inspection
   progress; start/stop breadcrumb capture with distance; captured points queue
   to `POST /api/gps-validations/bulk`.
7. **Mailbox** — folder list, message list and reader; reply/forward, mark read,
   acknowledge; cached for offline reading and queued for offline sending.
8. **Sync / Settings** — server URL, pending/failed queue with per-item retry,
   "Sync now", sign out, app version.

## Offline and Sync Model

### Local schema

Cache tables mirror the server entities the field app reads: `task`,
`task_detail` (JSON payload), `checklist`, `finding`, `message`, `line`,
`attachment`. Each has a `server_id`, `updated_at`, and a `dirty` flag for
optimistic local edits.

The `outbox` table is the write queue:

| column | purpose |
|---|---|
| `id` | local autoincrement |
| `client_ref` | UUID sent to the server as the idempotency key |
| `type` | `checklist_draft`, `checklist_submit`, `finding`, `attachment`, `gps`, `comment`, `mail`, `task_state` |
| `entity` | task/user id the write belongs to |
| `payload` | JSON (file URI for attachments) |
| `created_at` | FIFO ordering, stable per entity |
| `attempts` | retry count |
| `status` | `pending`, `inflight`, `failed`, `done` |
| `last_error` | message for the Sync screen |

### Read path

Every screen reads from SQLite. A refresh (pull-to-refresh, app foreground, or
post-sync) calls the list endpoints and upserts. Cached rows are never deleted
on a failed refresh. `GET` responses are not shared/cached in memory as the web
client does; the SQLite store is the cache.

### Write path

1. Apply the change optimistically to the local table and mark it `dirty`.
2. Insert an `outbox` row with a fresh `client_ref`.
3. Return immediately; the UI reflects the local state.

The flusher drains the outbox **in `created_at` order, serialized per entity**
(so a checklist submit never overtakes its own draft):

- Runs on connectivity restore (`@react-native-community/netinfo`), on app
  foreground, and on a periodic timer while items are pending.
- On success (2xx) marks the item `done` and reconciles server ids into the
  local table.
- On a definitive 4xx marks `failed` and surfaces it (a submit rejected as
  already-submitted is dropped locally as a no-op).
- On a network/ambiguous failure, requeues with exponential backoff. The
  `client_ref` makes the eventual retry idempotent.

Attachments upload after smaller writes; a finding or checklist submission that
references a queued photo is sent once its upload succeeds.

### Conflict handling

Crew writes are append-only (readings, GPS, photos, findings, comments). The
checklist draft is already keyed per `(task_id, template_id, executed_by)` on the
server, so last-write-wins per person is correct. Task state transitions
(`POST /tasks/:id/state`) are validated server-side; a rejected transition is
reported and the local status is rolled back from the next refresh.

## Backend Changes (additive only)

One optional idempotency column, ignored by the web app:

- `backend/db.js` — via `migrate(...)`, add nullable `client_ref TEXT` to
  `task_finding`, `attachment`, `gps_validation`, `comment`, `message`; add a
  partial unique index per table on `client_ref` where not null.
- The corresponding write routes (`routes/attachments.js`,
  `routes/gps.js`, `routes/comments.js`, `routes/mailbox.js`,
  `routes/tasks.js`) read an optional `client_ref` from the body. If a row with
  that `client_ref` already exists, they return the existing row instead of
  inserting. Absent `client_ref` behaves exactly as today.

No other backend change is required. Checklist draft/submit already carry the
needed semantics (per-person draft, submit clears the draft).

## API Mapping

| Mobile action | Endpoint |
|---|---|
| Sign in / session | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/health` |
| My work | `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/readiness` |
| Checklist | `GET /api/tasks/:id/checklist`, `POST /api/tasks/:id/checklist/draft`, `POST /api/tasks/:id/checklist` |
| Findings | `POST /api/tasks/:id/findings` |
| Photos / attachments | `POST /api/tasks/:id/attachments`, `GET /api/tasks/:id/attachments`, `GET /api/tasks/:id/attachments/:attId/file` |
| GPS / route | `POST /api/gps-validations/bulk`, `GET /api/lines/:id/route`, `GET /api/lines/:id/inspection-progress`, `POST /api/tasks/:id/trace` |
| Comments | `GET /api/comments`, `POST /api/comments` |
| Mailbox | `GET /api/mailbox`, `GET /api/mailbox/folder`, `GET /api/mailbox/messages/:id`, `POST /api/mailbox/messages`, `POST /api/mailbox/messages/:id/send`, `PUT /api/mailbox/messages/:id/read`, `GET /api/mailbox/:taskId` |
| Reference data | `GET /api/regions`, `GET /api/substations`, `GET /api/lines`, `GET /api/towers`, `GET /api/crews` |

The client mirrors the web `api.js` conventions: `Authorization: Bearer <jwt>`,
JSON bodies, `data.error` surfaced as the message.

## Authentication and Security

- Server URL and JWT live in `expo-secure-store` (Android Keystore / iOS
  Keychain), not in plain async storage.
- Every request carries the Bearer token. A `401` clears the session and routes
  to Setup/Sign-in.
- HTTPS is the default. Cleartext HTTP is allowed only behind an explicit
  on-prem opt-in (Android `usesCleartextTraffic`), off by default.
- No secrets, API keys or credentials are hardcoded in the app. There are no
  LLM keys involved.

## Map and Route Tracing

- `@maplibre/maplibre-react-native` renders OSM raster tiles with no API key.
  Tiles for the assigned line's bounding box are cached for offline display.
- Overlays: the line route (`GET /api/lines/:id/route`), tower points, the crew
  path, and inspection-progress coloring — the same data the web line workspace
  uses.
- Live tracing records foreground GPS with the same movement/flush thresholds as
  the web recorder (min move and periodic flush) and queues points to the
  outbox. Background tracing is out of scope for the first release.
- MapLibre is a native module, so on-device development uses an Expo
  **development build** (`expo-dev-client`), not Expo Go.

## Build, Distribution and Verification

The development container has Node 22 and Python but **no JDK, Android SDK,
Flutter or Xcode**. Consequences, stated explicitly:

- **Here we can**: scaffold `mobile/`, implement all code, run `tsc --noEmit`
  and `expo-doctor`, `expo export` the JS bundle to prove it compiles, run the
  Metro dev server and expose it so a phone with a dev build can load it, and
  author `eas.json`.
- **Here we cannot**: produce a signed APK or IPA locally. Android builds need
  EAS Build (requires the team's Expo account) or a locally installed Android
  SDK (`apt`, Android-only). iOS builds require macOS/Xcode, which is
  unavailable, so iOS binaries must come from EAS Build.
- The user provides an Expo account for EAS, or Android-only APKs are built by
  installing the Android SDK in the container.

## Testing

- **Unit (Vitest, Node):** outbox ordering and per-entity serialization, retry
  and backoff, `client_ref` reuse across retries, API client error/`401`
  mapping, and local-store upsert/reconcile.
- **Integration (Node harness):** run the real sync engine against a temp
  SQLite DB and the live backend to prove FIFO flush, idempotent retry (no
  duplicate rows on a forced resend), and server-id reconciliation.
- **Backend:** extend the existing regression suite to assert that a repeated
  write with the same `client_ref` returns the existing row.
- **Manual device checklist:** camera capture, foreground GPS, offline
  toggle, map tile cache, draft save/resume across an app restart.

## Phases

1. **Foundation** — Expo app scaffold, setup/sign-in, SecureStore session, API
   client, tabs shell, typecheck/export green.
2. **Read cache** — SQLite schema, My Work list + Task detail from cache,
   reference-data sync.
3. **Offline writes** — outbox, sync engine, checklist draft/submit, findings,
   comments; backend `client_ref` idempotency (this phase's plan covers both
   repos).
4. **Field capture** — camera/photos, GPS capture, attachments queue.
5. **Map and tracing** — MapLibre view, line/tower overlays, live breadcrumb,
   offline tiles, dev build.
6. **Mailbox** — folders, reader, reply/forward, offline cache and queued send.
7. **Hardening** — backoff/conflict surfacing, connectivity edge cases, device
   test pass, EAS build configuration.
