# TMMS Mobile Field App Implementation Plan

> **For agentic workers:** This plan is executed phase by phase. Each top-level
> Phase is an independent workstream that ends with a commit. Tasks use checkbox
> (`- [ ]`) tracking. Steps that say "verify" must be run, not assumed.

**Goal:** Deliver a native React Native (Expo) Android + iOS field-crew
application that consumes the existing TMMS REST API, works offline via a local
SQLite cache and an append-only outbox, and supports checklist execution,
findings, photos, GPS/route tracing and the task mailbox.

**Architecture:** A new `mobile/` Expo TypeScript app. The UI reads only from
`expo-sqlite`; a sync engine drains an `outbox` table to the existing Express
API, using a new optional `client_ref` idempotency column so retries are safe.
MapLibre RN renders OSM tiles with offline caching. The web app and its data are
untouched except for the additive `client_ref`.

**Tech Stack:** Expo (React Native) + TypeScript (strict), expo-router,
expo-sqlite, expo-secure-store, expo-location, expo-camera, expo-file-system,
@react-native-community/netinfo, @maplibre/maplibre-react-native, Vitest (Node)
for unit tests. Backend: Node >= 22.5.0, Express 5, `node:sqlite` (CommonJS).

## Global Constraints

- Backend is CommonJS; the mobile app is ESM TypeScript. Do not mix.
- Mobile source is strict TypeScript with **no comments** (matches the web
  frontend convention).
- The app must never import backend code. It talks only to the HTTP API.
- Never commit `backend/tmms.db`, `backend/tmms.db-wal`, `backend/tmms.db-shm`,
  `backend/uploads/`, or `frontend/dist/`. Do not use `git add -A`.
- `backend/tmms.db` is tracked and modified in the working tree; before any
  commit, stage explicit paths only (never the DB).
- Backend DB access goes through `db.prepare(...)` from `backend/db.js` and the
  `migrate(...)` helper for additive columns. Use `withTx` for multi-statement
  writes; `withTx` is not reentrant.
- The `client_ref` change must be backward compatible: requests without it
  behave exactly as today.
- No mobile device or Android/iOS SDK exists in this container. Verification
  here is `tsc --noEmit`, `expo-doctor`, `expo export`, Vitest, and a Node
  integration harness. Device-only checks (camera, GPS, map) are listed as a
  manual checklist and are not automatable here.
- The server URL is user-entered at runtime; do not hardcode any host, key or
  credential in the app.
- Do not run `pkill`/`killall`. Stop background servers by their terminal id.

---

## Phase 1: Foundation

**Deliverable:** `mobile/` Expo app that launches, validates a server URL,
signs in, stores the JWT securely, and renders the four-tab shell with the
signed-in user. Compiles and exports cleanly.

**Files:**
- Create: `mobile/` (via `create-expo-app`, TypeScript template)
- Create: `mobile/src/api/client.ts`, `mobile/src/api/endpoints.ts`
- Create: `mobile/src/auth/session.ts`
- Create: `mobile/app/_layout.tsx`, `mobile/app/(setup)/index.tsx`
- Create: `mobile/app/(tabs)/_layout.tsx`, `work.tsx`, `map.tsx`, `mail.tsx`, `sync.tsx`
- Create: `mobile/src/components/`
- Test: `mobile/src/**/*.test.ts` (Vitest)

### Task 1.1: Scaffold the Expo app

- [ ] Run `npx create-expo-app@latest mobile --template blank-typescript`
  (workdir `/workspace`), then add `expo-router` and set `main` as documented
  by Expo Router. Install: `expo-sqlite expo-secure-store expo-location
  expo-camera expo-file-system @react-native-community/netinfo`.
- [ ] Set strict mode in `mobile/tsconfig.json` and add a `typecheck` script
  (`tsc --noEmit`).
- [ ] Verify: `cd mobile && npx tsc --noEmit` exits 0.
- [ ] Verify: `npx expo-doctor` reports no blocking issues.
- [ ] Commit `mobile/` scaffold (explicit paths, not `-A`).

### Task 1.2: API client and session storage

- [ ] Write the failing test: a Vitest unit test for `api/client.ts` that
  asserts (a) the Authorization header is `Bearer <token>` when a token is
  present, (b) `data.error` from a non-2xx JSON body becomes the thrown
  message, (c) a `401` invokes the configured session-expired handler.
- [ ] Run it, expect failure.
- [ ] Implement `mobile/src/api/client.ts` mirroring `frontend/src/api.js`
  (`get/post/put/patch/del`, JSON, `apiError`, `onUnauthorized`). Implement
  `mobile/src/auth/session.ts` using `expo-secure-store` for `serverUrl` and
  `token` (plus a non-secret cached user object in async storage).
- [ ] Run the test, expect pass.
- [ ] Implement `mobile/src/api/endpoints.ts` with typed functions for the
  endpoints in the spec's API Mapping table (auth + health only in this phase).
- [ ] Verify: `cd mobile && npx tsc --noEmit` exits 0.
- [ ] Commit.

### Task 1.3: Setup / sign-in screen

- [ ] Build `app/(setup)/index.tsx`: server URL field validated by
  `GET <url>/api/health`, then username/password via `POST /api/auth/login`.
  Persist `serverUrl` + `token`; on success route to `(tabs)/work`.
- [ ] Build `app/_layout.tsx` that loads the stored session on launch and
  routes to `(setup)` or `(tabs)`. Wire the client's `onUnauthorized` to clear
  the session and route to `(setup)`.
- [ ] Verify: `npx tsc --noEmit` and `npx expo export --platform android`
  both succeed (proves the bundle builds).
- [ ] Manual: run `npx expo start`, open on a dev build, sign in against the
  live backend.
- [ ] Commit.

### Task 1.4: Tab shell

- [ ] Create the `(tabs)` layout with `My Work · Map · Mail · Sync/Settings`
  and placeholder screens; the Sync/Settings screen shows the configured server
  URL and a working Sign out.
- [ ] Verify: typecheck + export succeed; sign out returns to Setup.
- [ ] Commit.

---

## Phase 2: Read Cache

**Deliverable:** My Work and Task detail render entirely from the local SQLite
cache; reference data syncs; the app is usable read-only with no signal.

**Files:**
- Create: `mobile/src/db/schema.ts`, `mobile/src/db/queries.ts`
- Create: `mobile/src/sync/pull.ts`
- Modify: `mobile/app/(tabs)/work.tsx`, add `mobile/app/task/[id].tsx`
- Test: `mobile/src/db/**/*.test.ts`

### Task 2.1: Local schema

- [ ] Write the failing test: opening a fresh in-memory SQLite, running
  `migrate()`, then asserting all cache tables and the `outbox` table exist with
  the expected columns.
- [ ] Implement `mobile/src/db/schema.ts` (`task`, `task_detail`, `checklist`,
  `finding`, `message`, `line`, `attachment`, `outbox`, `sync_meta`) and a
  versioned `migrate()`.
- [ ] Run the test, expect pass. Commit.

### Task 2.2: Upsert queries

- [ ] Test: upserting a task twice updates in place (single row) and never
  overwrites a row marked `dirty`.
- [ ] Implement `queries.ts` (`upsertTask`, `upsertTaskDetail`, `listTasks`,
  `getTask`, etc.). Run the test. Commit.

### Task 2.3: Pull sync

- [ ] Test: given a stub API client, `pull()` upserts returned tasks and
  records the sync timestamp without deleting cached rows on a thrown error.
- [ ] Implement `src/sync/pull.ts` calling `GET /api/tasks`, task detail and
  reference endpoints; call it on foreground and pull-to-refresh.
- [ ] Implement `app/(tabs)/work.tsx` (list from cache, filters, pull-to-
  refresh, pending badge stub) and `app/task/[id].tsx` (target, readiness,
  equipment instruction, checklist list, findings, comments).
- [ ] Verify: build `frontend` API against live backend via the harness; a
  Node Vitest integration test seeds the real API shape into a temp DB and
  asserts the list renders non-empty.
- [ ] Commit.

---

## Phase 3: Offline Writes

**Deliverable:** The outbox queues checklist draft/submit, findings and
comments; the sync engine flushes them FIFO per entity with backoff; the
backend dedupes `client_ref`.

**Files:**
- Modify: `backend/db.js` (add `client_ref` + partial unique indexes)
- Modify: `backend/routes/tasks.js`, `attachments.js`, `comments.js`
- Create: `mobile/src/db/outbox.ts`, `mobile/src/sync/engine.ts`
- Modify: `mobile/app/task/[id].tsx`, add `mobile/app/task/[id]/checklist.tsx`
- Tests: `backend` regression additions; `mobile` Vitest; Node harness

### Task 3.1: Backend `client_ref` idempotency (backend repo)

- [x] Write the failing test in the existing regression style: POST a finding
  with `client_ref=X` twice; assert one row and the same id both times.
- [x] Implement in `backend/db.js` via `migrate(...)`: add
  `client_ref TEXT` to `task_finding`, `attachment`, `gps_validation`,
  `comment`, `message`; create a partial unique index per table on
  `client_ref WHERE client_ref IS NOT NULL`.
- [x] In each write route, when `client_ref` is present look up the existing
  row first and return it; otherwise insert as today.
- [x] Run the regression suite (all existing checks green) plus the new test.
- [x] Verify: `node --check` on touched files; run the backend suite.
- [x] Commit (backend paths only).

### Task 3.2: Outbox

- [x] Test: `enqueue` then `list` is ordered by `created_at`; `done`/`fail`
  update status and attempts; items are grouped by entity.
- [x] Implement `src/db/outbox.ts`. Run the test. Commit.

### Task 3.3: Sync engine

- [x] Test: with a stub client, the engine flushes per entity in order, stops
  the entity's queue on failure, backs off, and never sends an item twice after
  a simulated duplicate response.
- [x] Implement `src/sync/engine.ts` (NetInfo trigger, foreground, timer;
  exponential backoff; status/`last_error` exposure).
- [x] Implement `app/task/[id]/checklist.tsx` (per-item inputs, Save draft,
  resume prefill, Submit) enqueuing to the outbox, and finding/comment
  creation with cross-links.
- [x] Integration harness: run the engine against a temp SQLite and the live
  backend; force a resend and assert no duplicate rows server-side.
- [x] Commit.

---

## Phase 4: Field Capture

**Deliverable:** Camera photos and GPS points are captured offline, queued and
uploaded; attachments attach to tasks/findings.

**Files:**
- Create: `mobile/src/capture/` (camera + location)
- Modify: `mobile/src/db/outbox.ts`, `src/sync/engine.ts`
- Test: `mobile/src/capture/**/*.test.ts`

- [x] Task 4.1: Image picker/capture UI writing to app storage; `attachment`
  outbox items upload via multipart then resolve to `attachment_id`.
- [x] Task 4.2: GPS point capture with the web recorder thresholds (min move,
  periodic flush); queue to `POST /api/gps-validations/bulk`.
- [x] Test: attachment outbox item is only marked done after its upload 2xx; a
  queued finding referencing the photo is sent after the upload.
- [ ] Manual device checklist: camera permission, offline capture, upload on
  reconnect.
- [x] Commit.

---

## Phase 5: Map and Tracing

**Deliverable:** MapLibre map with the assigned line, towers, crew path and
inspection progress; live breadcrumb tracing; offline tiles.

**Files:**
- Create: `mobile/src/map/` (MapView, overlays, tile cache)
- Modify: `mobile/app/(tabs)/map.tsx`, add `mobile/app/task/[id]/trace.tsx`
- Create: `mobile/app.json` dev-client config, `mobile/eas.json`

- [x] Task 5.1: Add `@maplibre/maplibre-react-native`, configure the dev
  build (`expo-dev-client`), render OSM raster tiles.
- [x] Task 5.2: Overlays from `GET /api/lines/:id/route`, tower points and
  `inspection-progress`; color segments like the web workspace.
- [x] Task 5.3: Live tracing screen — start/stop, distance, breadcrumb; queue
  points to the outbox.
- [ ] Task 5.4: Offline tile cache for the assigned line bbox.
- [ ] Verify: typecheck/export; `eas.json` profiles (`development`,
  `preview`, `production`) valid.
- [ ] Manual device checklist: tiles render, offline tiles present, GPS trace
  records and syncs.
- [x] Commit.

---

## Phase 6: Mailbox

**Deliverable:** Folder list, message list, reader, reply/forward, read and
acknowledge, cached offline with queued sends.

**Files:**
- Modify: `mobile/app/(tabs)/mail.tsx`
- Create: `mobile/app/mail/[id].tsx`
- Modify: `mobile/src/sync/pull.ts`

- [x] Task 6.1: `GET /api/mailbox`, `/folder`, `/messages/:id` into cache;
  three-pane-appropriate mobile list + reader.
- [x] Task 6.2: Compose/reply/forward/send via the outbox (`message`
  `client_ref`); mark read and acknowledge.
- [x] Test: an offline-composed message is queued and sent exactly once.
- [ ] Manual: read a message offline after a prior sync; send on reconnect.
- [x] Commit.

---

## Phase 7: Hardening

**Deliverable:** Robust backoff and conflict surfacing, connectivity edge
cases resolved, device test pass, EAS build configured.

- [ ] Task 7.1: Sync screen shows pending/failed counts, per-item retry and
  "Sync now"; failed items are inspectable.
- [ ] Task 7.2: Handle connectivity flapping, app kill mid-flush, and a
  submit rejected as already-submitted (drop locally, refresh status).
- [ ] Task 7.3: Full device test pass against the manual checklist.
- [ ] Task 7.4: Finalize EAS build profiles and document the build commands
  (`eas build -p android --profile preview`, iOS via EAS on macOS only).
- [ ] Verify: all Vitest green; `tsc --noEmit`; `expo export` for both
  platforms; backend regression suite green.
- [ ] Commit.

---

## Out of Scope

- Management, analytics, reporting, admin and scheduling screens.
- Background location tracing.
- WebView/PWA delivery.
- App-store submission.
