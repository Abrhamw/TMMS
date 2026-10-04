# Frontend Structural Redesign - Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Rebuild the TMMS application shell and navigation, introduce a real type/color/spacing system, a consistent hover/motion language, and a shared frontend data layer with prefetch and skeleton-first rendering - without changing the backend contract, routes, guards, or i18n.

**Architecture:** The shell in `App.jsx` owns the frame (rail/bottom bar/drawer, header slot, content container) and each page owns only its content. Design tokens live in `styles.css` `:root` (and the dark mapping), exposed as CSS variables so legacy rules adopt them in place. A small query cache grows out of the existing `api.js` GET cache.

**Tech Stack:** React 19, Vite 7, React Router 6, Tailwind CSS 4 (utilities used by migrated surfaces), `motion`, `lucide-react`, the vendored `src/ui/` kit. Verify via `npm run build` and headless Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-frontend-structural-redesign-design.md`

## Global Constraints

- No backend or API contract change; use existing endpoints only.
- Preserve all routes, role guards, and i18n behavior. `Page`'s `title`/`crumbs`/`actions`/`fill` API stays compatible.
- No code comments. Stage explicit paths only; never `git add -A`.
- Tailwind preflight must NOT be imported; `styles.css` base must not lose behavior.
- Motion respects `prefers-reduced-motion`; keyboard focus must stay visible.
- `npm run build` green after every phase; Playwright matrix (admin/executive/crew x desktop/tablet/mobile x light/dark) with zero console errors and no overflow.

## File Structure

- `frontend/src/styles.css` - token definitions (type/color/spacing/motion), shell layout, rail/bottom bar/drawer, header, hover states, dark mapping.
- `frontend/src/App.jsx` - shell frame: rail/drawer/tab bar, header slot, content container, command palette trigger.
- `frontend/src/components/PageHeader.jsx` - new shell-owned header (title, breadcrumbs, actions).
- `frontend/src/components.jsx` - `Page` adapted to render into the shell header slot.
- `frontend/src/api.js` - query cache (stale-while-revalidate, dedupe, abort) and write invalidation.
- `frontend/src/prefetch.js` - warm-first-paint helpers and nav hover prefetch (new).
- `frontend/src/ui/Skeleton.jsx` - reused for skeleton-first rendering.
- Page files under `frontend/src/pages/` - adopt header slot, tokens, and skeletons incrementally.

## Phase R0 - Shell and tokens

### Task R0.1: Type, color, spacing tokens

- [x] Step 1: In `styles.css` `:root`, replace the type scale with xs 12 / sm 13 / base 15 / lg 18 / xl 22 / 2xl 30 / display 38; set `body` font-size to the base.
- [x] Step 2: Add brand and neutral ramps with named steps (`--brand-*`, `--gray-*`) and semantic aliases (surface/base/raised/overlay, border, text, muted, hover, active, focus), re-pointing existing names (`--bg`, `--panel`, `--text`, `--muted`, `--border`, `--primary`, `--accent`, `--surface-1..3`, `--elev-*`) at the ramps.
- [x] Step 3: Formalize the 4px spacing scale; keep existing `--space-*` names.
- [x] Step 4: Update the `.dark` mapping to the dark side of the same ramps.
- [x] Step 5: `npm run build`; spot-check pages in light and dark for contrast regressions.

### Task R0.2: Hover and motion tokens

- [x] Step 1: Add `--dur-fast` 120ms, `--dur` 180ms, `--dur-slow` 240ms, `--ease-standard`.
- [x] Step 2: Apply to `.btn`, `.nav-link`, `.card`, `table tr`, links, and inputs: hover background/tint, `:active` press, `:focus-visible` ring.
- [x] Step 3: Add a reusable card-lift hover (translate + elevation) used by interactive cards.
- [x] Step 4: Wrap all new transitions in `@media (prefers-reduced-motion: reduce)` opt-out.

### Task R0.3: Navigation rail, bottom bar, drawer

- [x] Step 1: Add collapsed/expanded state to the rail in `App.jsx`, persisted per device (`localStorage`), 64px collapsed with icon-only items and tooltips.
- [x] Step 2: Add the shell-owned rail toggle button and keep grouped nav, role-driven items, and active pill/accent-bar styling.
- [x] Step 3: Below 768px, render a bottom tab bar (first four role destinations plus More) and a slide-in drawer exposing the full grouped nav; close on navigate and Escape.
- [x] Step 4: Ensure keyboard traversal and `:focus-visible` on all nav controls.
- [x] Step 5: `npm run build`; Playwright admin/executive/crew at 1440x900, 1024x768, 390x844.

### Task R0.4: Shell header slot and content container

- [x] Step 1: Create `components/PageHeader.jsx` (title, crumbs, actions) rendered by the shell.
- [x] Step 2: Adapt `components.jsx` `Page` to pass its `title`/`crumbs`/`actions` to a shell header context instead of rendering its own `.topbar`; keep `fill` behavior for full-bleed pages.
- [x] Step 3: Add the content max-width container (`--content-max` ~1280px) with full-bleed opt-out for map/mailbox.
- [x] Step 4: Verify every page still shows the correct title/actions for its role.

### Task R0.5: Verify and commit R0

- [x] Step 1: `npm run build` succeeds.
- [x] Step 2: Playwright matrix: zero console errors, no overflow, active nav and header correct in light and dark.
- [x] Step 3: Commit explicit paths and push.

## Phase R1 - Data layer and perceived speed

### Task R1.1: Query cache with stale-while-revalidate

- [x] Step 1: In `api.js`, generalize the GET cache into a store keyed by method+URL+locale/region scope holding `{data, ts, promise}`.
- [x] Step 2: Serve cached data immediately and revalidate in the background; dedupe simultaneous requests for the same key.
- [x] Step 3: Dedupe concurrent reads per key so a late response becomes the shared cache entry rather than duplicate work; keep write methods invalidating affected keys.
- [x] Step 4: Preserve the existing call signatures so pages need no changes.

### Task R1.2: Warm and prefetch

- [x] Step 1: Add `prefetch.js` with helpers to warm `/dashboard/summary` and `/executive/summary` (when permitted) on idle after shell mount.
- [x] Step 2: Prefetch a nav target's data on link hover/focus.
- [x] Step 3: Ensure warming is role-scoped and silent on failure.

### Task R1.3: Skeleton-first rendering

- [x] Step 1: Replace first-load `Loading...` in the primary data regions with the kit `Skeleton` layout so first paint is immediate.
- [x] Step 2: Keep error states intact and avoid skeleton flash when cached data is already present.

### Task R1.4: Verify and commit R1

- [x] Step 1: Confirm a second navigation to a warmed route renders cached content before the network resolves.
- [x] Step 2: Confirm writes still invalidate and reload.
- [x] Step 3: `npm run build`; commit explicit paths and push.

## Phase R2 - Page anatomy

### Task R2.1: Adopt the shell header and tokens

- [x] Step 1: Migrate hubs and registers to the header slot, spacing, and layered surfaces area by area, keeping routes and guards unchanged.
- [x] Step 2: Rebalance table/body density for the larger base type.

### Task R2.2: Verify and commit R2

- [x] Step 1: Playwright role x viewport pass; zero errors, no overflow.
- [x] Step 2: `npm run build`; commit explicit paths and push.

## Phase R3 - Motion polish

### Task R3.1: Apply the hover/motion language

- [x] Step 1: Apply card lift, row tint, dialog/sheet motion, and stagger consistently across migrated surfaces, all reduced-motion gated.
- [x] Step 2: Finish dark mapping of any remaining legacy surfaces.

### Task R3.2: Final verification

- [x] Step 1: Playwright matrix across all roles/viewports/themes; reduced-motion and keyboard checks.
- [x] Step 2: `npm run build`; update this plan and the spec status; commit explicit paths and push.
