# TMMS — System Diagnosis Report

Generated 2026-10-07. Branch `260928-feat-mailbox-reports-schedules`. Runtime Node v22.22.0.

TMMS is a three-surface asset maintenance management system (backend API, React web, Expo field app). This report records the state of the system after the operational-readiness hardening (readiness gate, labor, resources, materials, costing, defects, budget, procurement, control tower).

## Overall health

GOOD (B+). Core business logic is well-factored and tested. The gaps are concentrated in release hygiene, frontend test coverage, authorization ergonomics, and a few scalability hotspots rather than in the core domain.

| Dimension | Rating | Notes |
|---|---|---|
| Domain / data model | Strong | 72 tables, appended ledgers, closure gates |
| Backend correctness | Strong | 114/114 tests, transactions on write paths |
| Security | Good | Strong headers, scrypt, sniffed uploads; gaps in tokens, rate limit, authorization wiring |
| Frontend | Fair | 0 tests, client-only RBAC, localStorage tokens, bundle bloat |
| Mobile | Good | 37 tests, tsc clean; some sync/robustness defects |
| Ops / release hygiene | Fair | No CI for web/backend, untracked artifacts in tree |

## System inventory

| Area | Scale |
|---|---|
| Backend | ~29,400 JS LOC, 30 route modules, 72 tables, 20 test files (114 tests) |
| Frontend | ~26,200 JS LOC, 79 JSX files, ~37 pages, 0 tests |
| Mobile | ~5,500 TS LOC, 15 screens, 10 test files (37 tests) |
| DB | SQLite (node:sqlite), WAL, ~52 MB dev DB |
| Deps | Backend: express 5 + adm-zip only. Frontend: React 19 / Vite 7 / Tailwind 4 / motion 14 / leaflet. Mobile: Expo 57 / RN 0.86 / Expo Router |

## Architecture

### Backend

- Boot (`server.js:23-52`): seeds, runs idempotent migrations, reconciles infrastructure, asserts production secrets.
- Middleware order (`server.js:55-60`): `requestContext -> securityHeaders -> gzip -> json(12mb) -> stripImmutable`.
- Auth boundary: public `/api/auth` with its own rate limit (`server.js:90`), then global `requireAuth + auditMiddleware` for all other `/api` routes (`server.js:92`).
- Layering: thin routers over domain services (`labor`, `resources`, `materials`, `costing`, `defects`, `budget`, `procurement`, `readiness`, `controlTower`, `integrity`, `jobs`).
- DB: `db.js` schema plus additive `migrate()`; `util.js` statement cache, `insertRow`/`updateRow`, `byClientRef` idempotency, `withTx`.

### Frontend

- React 19 + Vite 7, custom router guards (`App.jsx:422-463`), lazy pages, custom i18n (en/es/zh/am), class-based dark mode, `motion/react`.
- API wrapper `src/api.js` (caching, 401 redirect, sync overlay); dev proxy `/api -> :3001` (`vite.config.js:37-42`).

### Mobile

- Expo Router app with offline-first SQLite store, outbox sync engine, MapLibre offline tile packs, secure-store session (`auth/session.ts`). Operator-entered backend URL (`api/client.ts:74`).

## Data model

72 tables grouped into operational master data (region, substation, transmission_line, tower, asset, crew, person, org_unit), work management (task, checklist_*, maintenance_schedule, task_finding, gps_validation), auth/audit (user, session, audit_log, job), mailbox, and the finance/labor/resource/material/procurement layer.

Immutable ledgers: `audit_log`, `labor_rate`, `time_entry`, `resource_usage`, `material_transaction`, `cost_transaction`. Enforced in code by status guards, not by DB triggers.

## Security assessment

Strengths:

- Opaque 256-bit bearer tokens, scrypt password hashes, 12h expiry, 10-session cap, pruning (`auth.js:7-41`).
- RBAC matrix plus region/crew scoping (`auth.js:139-241`, `authority.js`).
- CSP/HSTS/nosniff/XFO/Permissions-Policy (`security.js:25-37`); no `x-powered-by`.
- Uploads: base64, 8 MB cap, magic-byte allowlist JPEG/PNG/WebP/PDF, UUID names, authenticated and `taskVisible`-scoped serving (`routes/attachments.js:160-170`).
- Production startup refuses live demo credentials unless explicitly overridden (`security.js:55-68`).

Findings:

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | High | Session tokens stored plaintext in DB | `auth.js:38` |
| S2 | Medium | `requirePerm` defined but never wired; authorization is ad-hoc inline `can()` | `auth.js:216` |
| S3 | Medium | Rate limiting only on `/api/auth`, in-memory (resets on restart, per-instance) | `server.js:90`, `rateLimit.js` |
| S4 | Medium | Demo credentials hardcoded in source; guard bypassable via `TMMS_ALLOW_DEMO_SEED=1` | `security.js:16-23,58` |
| S5 | Medium | `stripImmutable` removes only 4 fields globally; residual mass-assignment surface | `validation.js:122-130` |
| S6 | Low | No explicit CORS policy (same-origin by design, undocumented) | no `cors` refs |

## Reliability and correctness

Strengths: WAL + `foreign_keys=ON` + `busy_timeout` (`db.js:7-9`); `withTx` on multi-write paths; `client_ref` unique indexes give idempotency across labor/resource/material/cost/defect/procurement; durable job queue with leases/backoff (`jobs.js`).

Findings:

| # | Severity | Finding | Evidence |
|---|---|---|---|
| R1 | Medium | `idempotency_key` table created but unused | `db.js:867` |
| R2 | Medium | `withTx` uses plain `BEGIN` and is non-reentrant | `util.js:113-125` |
| R3 | Low | Ledger immutability enforced in app code, not DB constraints | `db.js` |
| R4 | Low | Migrations additive-only, run every boot, no rollback | `db.js:1263+` |

## Testing and quality gates

- Backend: 114/114 passing (`node --test`). Only 3 of 30 routers have HTTP tests (`taskListPagination`, `mailboxJunkTrash`, `procurement`).
- Frontend: no tests, no lint, no typecheck.
- Mobile: 37/37 passing, `tsc --noEmit` clean; tests excluded from tsconfig typecheck (`tsconfig.json:6`).
- CI: only `mobile-android.yml`, branch-gated to `260928-...`, no test/typecheck step.

## Performance

| # | Severity | Finding | Evidence |
|---|---|---|---|
| P1 | Medium | Control tower loads all tasks into memory and runs `dispatchGate` per open task | `controlTower.js:14` |
| P2 | Medium | Budget status scans all tasks and resolves cost center per task | `budget.js:46` |
| P3 | Low | Frontend entry chunk ~488 KB; i18n dictionaries bundled into entry | `dist/assets/index-*.js` |
| P4 | Low | Largest files: `routes/tasks.js` 2132, `routes/mailbox.js` 1737, `db.js` 1518, `routes/reports.js` 1365, `routes/core.js` 1322 |

## Frontend and mobile findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| F1 | Medium | Client-only RBAC not applied per-route; UI exposes pages to under-privileged users | `App.jsx:485-500` |
| F2 | Medium | Bearer tokens in localStorage/sessionStorage | `session.js:13-17,87` |
| F3 | Low | Auth duplicated in direct fetch calls instead of the api wrapper | `TaskDetail.jsx:1158,1167` |
| F4 | Low | ~438 hardcoded JSX strings; es/zh routes render English | `i18n.js` |
| F5 | Low | Dead files and duplicate route pairs | `App.jsx:489-500` |
| M1 | Medium | Photos always saved `.jpg`; PNG/HEIC uploaded with wrong MIME | `capture/photo.ts:41,66` |
| M2 | Medium | Whole-file base64 upload, no resize/cap | `sync/attachments.ts:31-32` |
| M3 | Medium | Entity-level backoff blocks unrelated writes; no max attempts | `engine.ts:103-126` |
| M4 | Low | No fetch timeout; global mutable API client; session restored unvalidated | `api/client.ts:71`, `auth/context.tsx:51-66` |

## Repository hygiene

- Untracked runtime artifacts: `backend/uploads/*`, `design/`, `mobile/LICENSE`, modified `backend/tmms.db`; `.gitignore` does not exclude them.
- `mobile/App.tsx` and `mobile/index.ts` are dead (entry is `expo-router/entry`).
- Docs present: `SYSTEM_MAP.md`, `CORE_MODULES.md`, `BACKUP_RECOVERY.md`, `FUNCTION_INVENTORY.md`, `TASK_LIFECYCLE.md`, `USER_MANUAL.md`.

## Prioritized remediation roadmap

P0 — before production go-live:

1. Rotate demo credentials and enforce production secret assertion in the deploy pipeline.
2. Hash session tokens at rest; consider httpOnly cookies for web.
3. Make authorization declarative (`requirePerm` or a route permission table).
4. Add a global API rate limiter; persist counters if multi-instance.

P1 — hardening and coverage:

5. HTTP regression tests for auth, tasks writes, admin, attachments; frontend test runner; CI running backend tests, tsc, mobile vitest.
6. Fix mobile photo MIME and upload cap; per-entity outbox keying and max attempts.
7. `.gitignore` entries for uploads, DB files, design.

P2 — scale and polish:

8. Push control-tower/budget aggregation into SQL.
9. Split i18n dictionaries; prune dead code and duplicate routes.
10. Per-route frontend permission guards.

## Verdict

The backend domain layer is production-grade in design, and the financial/operational modules are coherent and testable. The principal risks are operational: credential and session handling, authorization ergonomics, absent CI for web and backend, and thin HTTP-level tests. None block continued development; several should be closed before a real deployment.
