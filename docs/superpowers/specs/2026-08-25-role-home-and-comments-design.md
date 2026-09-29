# Role-Aware Home, Guided Entry & Lightweight Comments — Design

**Date:** 2026-08-25
**Status:** Approved by user (entry flow, role-feed home, comments, detailed reports, checklist template editing)

## 1. Goal

Replace the generic operations dashboard as the startup experience with a **persona-guided entry** that asks "Who are you?", directs the user to sign-in, and then lands them on a **personalized Home feed** tailored to their role — very easy to use, and designed to scale across the whole EEP (Ethiopian Electric Power) Transmission organization.

## 2. Entry Flow

1. **`/` (landing)** — public page (no auth required). Full-screen EEP-branded welcome ("Ethiopian Electric Power — Transmission Maintenance Management", deep-green/red identity) with a **"Who are you?"** picker of 6 persona tiles:
   - **Field Crew** — "My assigned maintenance jobs"
   - **Director / Manager** — "My region's health: tasks, violations, schedules, certs"
   - **Executive** — "Whole-of-company overview & governance"
   - **Planner / Dispatcher** — "Create and schedule work"
   - **Auditor** — "Review evidence and compliance"
   - **Other / Sign in** — "I have an account"
2. Each tile routes to **`/login`** carrying the persona (query param), shown as a badge on the login card; the login screen lists matching **demo accounts** with quick-login buttons so reviewers can try each persona.
3. After sign-in the user is redirected to **`/home`** — the personalized role feed. `GET /` when already authenticated redirects to `/home`. The old dashboard remains at **`/overview`** (linked in the nav) for those who want the full operations view.
4. EEP brand applied to the landing, login, sidebar logo and page titles.

## 3. Role Home (backend role-feed)

### 3.1 `GET /api/home` (role-aware feed)

Returns a **section list** the Home page renders generically. Each section: `{ id, title, icon, kind, items, summary, quick_actions }`. Kinds: `cards` (StatCards), `table` (columns + rows), `task_queue` (crew tasks with actions), `violations`, `schedule_list`, `cert_list`, `activity`, `audit_list`.

Per-persona content (all RBAC/region/crew scoped):

| Persona | Feed sections |
|---|---|
| Field Crew | My assigned task queue (open tasks for my crew, due dates, Start-checklist action), my expiring certifications, quick GPS capture link |
| Director/Manager | Open tasks & overdue (region), GPS violations, next 7/30-day scheduled work, certifications expiring ≤90d, asset condition, regional activity |
| Executive | Whole-company totals, all directorates activity table, violations across Ethiopia, upcoming schedules, certification expiry, governance (org units/crews) |
| Planner/Dispatcher | Draft/scheduled tasks to schedule & assign, assignable task pool, crew availability, schedule generation shortcut |
| Auditor | Recent audit trail, GPS coverage, cert expiry, pending-verification tasks |
| Viewer/Other | Read-only overview: counts, recent tasks, coverage |

Quick actions per section are gated by the user's existing permissions (`task:create`, `task:verify`, `gps:write`, `report:write`, admin checklist edit, etc.).

### 3.2 Frontend Home renderer

`Home.jsx` fetches `/api/home`, renders each section via shared presentational components (reuse `StatCard`, `Pill`, tables, progress). Add to `buildNav`: keep dashboard at `/overview`. Landing picker + login persona hint in `Login.jsx`.

## 4. Comments & Violation Notes

- **Table `comment`**: `id`, `entity_type` (`task` | `asset` | `gps_validation`), `entity_id`, `user_id` (author), `body` TEXT, `created_at`, `updated_at`. Index on `(entity_type, entity_id)`.
- **API** (new `routes/comments.js`, mounted at `/api`):
  - `GET /comments?entity_type=&entity_id=` — thread, newest-last, with author.
  - `POST /comments` — any authenticated user with read access to the entity can post.
  - `DELETE /comments/:id` — author or admin.
- **UI**:
  - TaskDetail: comment thread panel.
  - Asset detail modal: comment thread.
  - GPS page: per-violation "review note" box (comment thread on `gps_validation`).
- Comments are the lightweight write channel for non-admin roles; all other writes remain RBAC-gated.

## 5. Detailed Reports & Checklist Templates

- **New report types** in `routes/reports.js` `compute()`:
  - `ASSET_DETAIL` (param `asset_id`): full asset record, location/bay, condition/health/RUL, lifecycle, maintenance events, checklist executions with results, GPS validations, open tasks, tower components.
  - `CREW_DETAIL` (param `crew_id`): roster + skills, certifications & expiries, task history with completion/on-time, utilization, current open work.
  - Reports render as a printable document page (HTML template). Generate buttons on the **asset detail modal** and **crew detail modal** ("Generate document").
- **Director Home** includes a one-click **"Generate region report"** quick action (chooses report type; region-scoped).
- **Checklist templates**: keep admin CRUD on the Checklists page; standard 17 templates remain seeded + admin-editable. Admin Home includes a "Checklist templates" quick action and a manager-facing **checklist compliance** widget (templates vs executions).

## 6. Files touched

- Backend: `routes/home.js` (new), `routes/comments.js` (new), `routes/reports.js` (2 report types + document rendering), `db.js` (`comment` table migration), `server.js` (mount routes).
- Frontend: `App.jsx` (public landing route + `/home` + `/overview` routing, nav), `pages/Home.jsx` (new role feed), `pages/Landing.jsx` (new picker), `pages/Login.jsx` (persona hint + demo quick-login), `pages/Overview.jsx` (renamed/moved dashboard at `/overview`), `pages/TaskDetail.jsx` (comments), `pages/Assets.jsx` (comments + document button), `pages/Crews.jsx` (document button), `pages/Gps.jsx` (violation notes), `styles.css` (landing + comments styles), `i18n.js` (new keys).

## 7. Verification

- `npx vite build` passes; backend syntax check; restart and smoke-test `/api/home` for each persona; comment CRUD on task/asset/gps_validation; report generation for `ASSET_DETAIL`/`CREW_DETAIL`; RBAC checks (e.g., viewer cannot post comment on entity it cannot read).
