# Frontend Modernization - Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Modernize the TMMS frontend with a Tailwind v4 + vendored shadcn-style kit + `motion` + `lucide-react` foundation, then apply it to the executive and worker surfaces first, with progressive drill-down drawers, dark mode, and upgraded visualization.

**Architecture:** Add Tailwind v4 (theme + utilities layers only, no preflight) beside the existing `styles.css`, a `src/ui/` kit, a theme provider, and a drawer system. New surfaces are reimplemented with the kit; unmigrated pages keep working unchanged until the rollout phase.

**Tech Stack:** React 19, Vite 7, Tailwind CSS 4 (`@tailwindcss/vite`), `motion`, `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`. Verify via `npm run build` and headless Playwright screenshots.

**Spec:** `docs/superpowers/specs/2026-10-04-frontend-modernization-design.md`

## Global Constraints

- No backend or API change; use existing endpoints only.
- Tailwind preflight must NOT be imported; existing `styles.css` base must not change behavior.
- No new page may break unmigrated pages; app must build green after every phase.
- Motion respects `prefers-reduced-motion`.
- Vendored UI kit in `src/ui/`; do not run the shadcn CLI.
- No code comments. Stage explicit paths only.
- Verify `npm run build` after every phase and capture headless screenshots for migrated surfaces.

## File Structure

- `frontend/package.json` - new dependencies.
- `frontend/vite.config.js` - Tailwind plugin and `@` alias.
- `frontend/index.html` - Inter font link and theme bootstrap script.
- `frontend/src/tailwind.css` - Tailwind theme + utilities layers and design tokens.
- `frontend/src/main.jsx` - import Tailwind layer and theme provider.
- `frontend/src/theme.jsx` - theme context (light/dark), persistence.
- `frontend/src/ui/*` - vendored UI kit (Button, Card, Badge, Sheet, Dialog, Tooltip, Tabs, Skeleton, Command).
- `frontend/src/components/Drawer.jsx` or `src/ui/Sheet.jsx` - drill-down drawer.
- `frontend/src/App.jsx` - shell modernization, theme toggle, command palette.
- `frontend/src/pages/ExecutiveSummary.jsx` - interactive briefing.
- `frontend/src/pages/Home.jsx` (worker branch) and `frontend/src/components/TaskRunner.jsx` - worker field experience.
- `frontend/src/components/viz/index.jsx` - interactive/visualization upgrade.

## Phase P0 - Foundation

### Task P0.1: Install the stack

- [x] Step 1: Install `tailwindcss @tailwindcss/vite motion lucide-react clsx tailwind-merge class-variance-authority` as project dependencies.
- [x] Step 2: Add `@tailwindcss/vite` to `vite.config.js` plugins.
- [x] Step 3: Add a `@` -> `./src` resolve alias in `vite.config.js`.

### Task P0.2: Tailwind theme (no preflight)

- [x] Step 1: Create `src/tailwind.css` importing `tailwindcss/theme.css` and `tailwindcss/utilities.css` only.
- [x] Step 2: Define `@theme` tokens bound to the TMMS brand (green, teal, indigo, severity, chart, dark palette).
- [x] Step 3: Add the class-based dark variant.
- [x] Step 4: Import `tailwind.css` in `src/main.jsx` after `styles.css`.

### Task P0.3: Theme provider and toggle

- [x] Step 1: Create `src/theme.jsx` with a provider that reads/writes the theme and toggles `.dark` on `document.documentElement`.
- [x] Step 2: Add an inline bootstrap in `index.html` to apply the stored theme before paint.
- [x] Step 3: Add a theme toggle to the shell top bar (`App.jsx`) using `lucide-react`.
- [x] Step 4: Add token-based dark overrides to the shell so it themes without touching unmigrated page internals.

### Task P0.4: Verify P0

- [x] Step 1: `npm run build` succeeds.
- [x] Step 2: Headless screenshots at 1440x900, 1024x768, 390x844; confirm no visual regression on existing pages and zero console errors.
- [x] Step 3: Commit explicit paths and push.

## Phase P1 - UI kit and shell

### Task P1.1: Vendored UI kit

- [x] Step 1: Add `src/ui/` primitives (Button, Card, Badge, Sheet, Tooltip, Tabs, Skeleton) using CVA + clsx + tailwind-merge.
- [x] Step 2: Add a `Sheet` drawer with focus trap, Escape close, backdrop, and reduced-motion-aware transition.
- [x] Step 3: Add a `Command` palette (Ctrl/Cmd+K) for navigation and entity search.

### Task P1.2: Shell modernization

- [x] Step 1: Replace unicode nav glyphs with `lucide-react` icons; keep the existing routes and labels.
- [x] Step 2: Add breadcrumbs and active-area cues.
- [x] Step 3: Add the command palette trigger and keyboard shortcut.

## Phase P2 - Executive command center

### Task P2.1: Interactive briefing

- [x] Step 1: Reimplement the briefing with the UI kit and Tailwind, in light and dark themes.
- [x] Step 2: Animate KPI counters and chart draw-in with `motion`, honoring reduced motion.
- [x] Step 3: Wire KPI/chart drill-down to a `Sheet` drawer showing aggregate and exception detail (counts, trend, top rows).
- [x] Step 4: Add live refresh and hover detail on charts.
- [x] Step 5: Route `/executive/summary` through the shared summary cache so repeat loads are instant (was bypassing `scopedSummary`).

## Phase P3 - Worker field experience

### Task P3.1: Mobile-first work surface

- [x] Step 1: Redesign the worker home/work surface with large touch targets and thumb-reachable actions.
- [x] Step 2: Add an animated step-by-step task runner (progress stepper, current step, validation).
- [x] Step 3: Present photo/GPS/reading capture in bottom sheets with optimistic feedback.
- [x] Step 4: Add a persistent sync/offline indicator.

## Phase P4 - Rollout and visualization

### Task P4.1: App-wide rollout

- [ ] Step 1: Migrate remaining pages to the kit area by area.
- [ ] Step 2: Complete token-based dark mode across legacy surfaces.
- [ ] Step 3: Upgrade `components/viz` with hover/tap detail and draw-in animation.
- [ ] Step 4: Final verification pass and documentation update.
