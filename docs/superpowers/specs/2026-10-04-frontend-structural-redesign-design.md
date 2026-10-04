# Frontend Structural Redesign - Design

Date: 2026-10-04
Status: Approved (design), pending implementation plan

## 1. Summary

The modernization pass (P0-P4) introduced Tailwind, a vendored UI kit, motion, dark
mode, and interactive executive and worker surfaces. In practice the result reads as
"theme switching": the app shell is still the original 220px fixed sidebar plus a
per-page top bar, the type scale is still 11-14px everywhere, surfaces are flat, hover
states are largely absent, and first paint of the data-heavy pages still waits on
backend computation.

This design changes the structure, not just the skin. It rebuilds the application
shell and navigation, replaces the type/color/spacing system with a real hierarchy,
introduces a consistent hover and motion language, and adds a shared data layer so
pages render instantly from cache while fresh data streams in. Every existing route,
guard, locale, and capability is preserved.

The guiding sentence: give the app a real structural spine - consistent shell, clear
hierarchy, responsive hover, instant-feeling data - without breaking what works.

## 2. Goals

- Restructure the shell so navigation, page header, and content are one consistent
  system across every page and every role.
- Introduce a genuine type hierarchy (larger base, clear heading steps) and a layered
  color system (brand, neutral, and semantic ramps), replacing the flat 11-14px text
  and single-surface look.
- Define one hover/motion language with shared duration and easing tokens, applied to
  cards, rows, buttons, nav, and focus states.
- Add a shared frontend data layer (stale-while-revalidate cache, in-flight dedupe,
  abort on unmount, prefetch/warm) and skeleton-first rendering so navigation feels
  instant.
- Keep role gating, i18n, legacy page behavior, and the existing backend contract
  intact throughout.

## 3. Non-goals

- No change to the backend API contract. All data comes from existing endpoints.
- No removal of pages, records, or capabilities.
- No big-bang rewrite: the app builds, runs, and passes verification after every
  phase; unmigrated pages keep working.
- No full cold-path optimization of `computeSummary` (the ~9s first computation). That
  is a separate follow-up; this design only removes duplicate work and hides latency.
- No accessibility regression: contrast, focus visibility, and
  `prefers-reduced-motion` are preserved.

## 4. Shell and navigation structure

Today `Page` renders its own `.main` column with a `.topbar` per page, and `App`'s
`Shell` renders a separate 220px sidebar that never adapts. The redesign makes the
shell own the frame and the page own only its content.

- **Navigation rail.** The sidebar becomes a persistent rail with two states: expanded
  (labels) and collapsed (icons only, 64px). The collapsed/expanded choice is persisted
  per device. Below 768px the rail is replaced by a bottom tab bar showing the first
  four destinations of the current role's navigation plus a "More" item, and a
  slide-in drawer that exposes the full grouped navigation.
- **Shell header slot.** The shell owns the page header: title, breadcrumbs, and an
  actions area. Page components continue to pass `title`/`crumbs`/`actions` and render
  into that slot, so existing pages need no rewrite. This gives every page one anatomy
  and lets actions sit in a stable position.
- **Content container.** Content renders inside a max-width container
  (`--content-max`, ~1280px) with consistent gutters. Full-bleed pages (the map and the
  mailbox) opt out via the existing `fill` flag.
- **Grouping.** Navigation keeps the existing group labels and role-driven item sets
  but is presented as fewer, clearer sections with an active item shown as an accent
  bar plus a tinted pill.

The `buildNav` role logic, route guards, and lazy-loaded routes are unchanged. Only
presentation and the header ownership move.

## 5. Typography, color, and spacing

The current scale (xs 11, sm 12, base 14, lg 16, xl 20, 2xl 26) and flat surfaces
produce a page that does not read as hierarchical. The redesign replaces the tokens.

- **Type scale.** Base 15px with steps xs 12 / sm 13 / base 15 / lg 18 / xl 22 /
  2xl 30 / display 38. Headings get tighter line-height and clearer weight steps.
  Table and body density are rebalanced so the larger base does not feel loose.
- **Color ramps.** An explicit brand (green) ramp and neutral (gray) ramp with named
  steps, plus semantic tokens for surface, border, text, muted text, hover, active, and
  focus. Rules: brand/primary for identity and primary actions, accent for interactive
  affordances, severity for status only.
- **Surfaces.** A layered surface model (base, raised, overlay) so cards, tables, and
  menus sit at visibly different elevations instead of one flat panel color.
- **Spacing.** Formalize the existing 4px rhythm into a documented scale used by both
  Tailwind utilities and legacy CSS variables.

Tokens remain exposed as CSS variables, so legacy `styles.css` rules adopt the new
values without being rewritten. Dark mode maps the same ramp to dark values.

## 6. Hover and motion language

- **Tokens.** `--dur-fast` 120ms, `--dur` 180ms, `--dur-slow` 240ms, and a single
  standard easing curve, shared by CSS and motion.
- **Interaction states.** Cards lift subtly on hover (small translate plus elevation);
  table rows highlight with an accent tint; buttons show hover and an `:active` press;
  nav items transition color/background; every interactive element has a visible
  `:focus-visible` ring.
- **Motion.** Section enter uses fade plus slide and simple staggering; dialogs and
  sheets animate in/out; animated counters and chart draw-in from the prior phase are
  retained. All motion is disabled under `prefers-reduced-motion`.

## 7. Data layer and perceived speed

- **Shared query cache.** Generalize the current 5s GET cache into a small
  stale-while-revalidate store keyed by method+URL (plus the existing locale/region
  scope): serve cached data immediately, revalidate in the background, dedupe
  simultaneous requests for the same key, and abort in-flight requests on unmount.
- **Warm and prefetch.** After the shell mounts, warm the summary endpoints during idle
  time - `/dashboard/summary`, and `/executive/summary` when the role permits - so the
  first visit to those pages is already cached. Navigation links prefetch their target
  data on hover/focus.
- **Skeleton-first.** Every async region renders a skeleton (the kit `Skeleton` already
  exists) on first load instead of a blank area or a bare "Loading..." line, so first
  paint is instant even when data is cold.
- **No behavior change.** The backend and endpoint contract are untouched; caching only
  removes duplicate and repeated work, and the cache is invalidated on writes as it is
  today.

## 8. Rollout and safety

- **R0 - Shell and tokens.** Navigation rail/bottom bar/drawer, shell header slot,
  content container, new type/color/spacing tokens, hover/motion tokens. App-wide but
  presentation-only; guards and routes untouched.
- **R1 - Data layer.** Query cache upgrade, warm/prefetch, skeleton-first rendering.
- **R2 - Page anatomy.** Adopt the header slot and spacing/surface tokens across hubs
  and registers, page by page, keeping the `Page` API compatible.
- **R3 - Motion polish.** Apply the hover/motion language consistently and finish dark
  mapping of any remaining legacy surfaces.

Every phase: `npm run build` green; headless Playwright across admin, executive, and
crew roles at desktop/tablet/mobile in light and dark, asserting no console errors and
no overflow; reduced-motion check.

## 9. Verification

- `npm run build` succeeds after every phase.
- Playwright: role x viewport x theme matrix for shell and migrated pages; zero console
  errors; no horizontal overflow; active nav and header correctness.
- Data layer: second navigation to a warmed route renders cached content before the
  network resolves; write paths still invalidate.
- Accessibility: keyboard traversal of the rail/drawer/tab bar, visible focus, and
  reduced-motion honored.
