# System Simplification - Deprecations and Follow-ups

The database remains the system of record. This change is presentation-only: no
table, column, or row was dropped, and no destructive SQL is required. Everything
below is either a route consolidation or a note for the user to act on.

## Consolidated routes

Old paths remain valid. Redirects point at the new areas:

| Old path | New path |
|----------|----------|
| `/overview` | `/dashboard` |
| `/regions` | `/assets?area=infrastructure&manage=regions` |
| `/substations` | `/assets?area=infrastructure&manage=substations` |
| `/lines` | `/assets?area=infrastructure&manage=lines` |
| `/towers` | `/assets?area=infrastructure&manage=towers` |

`/tasks`, `/tasks/:id`, `/crews`, `/schedules`, `/checklists`, `/certifications`,
`/reports`, `/value`, `/settings`, `/organization`, `/gps`, `/model`, and
`/infrastructure` are still served directly so existing deep links and query
parameters keep working. They are simply no longer in the primary navigation.

## Hidden by default, still stored

These remain in the database and are read on demand, but are no longer rendered
in bulk on any landing screen:

- Asset `metadata` JSON and line `route_json` / tower waypoints.
- Full GPS validation traces and audit logs.
- Complete maintenance-event and revaluation history.

No SQL is needed to keep them. If you later choose to physically remove legacy
tables, do it from a database backup and outside this tool; the environment
disables destructive SQL.

## Known follow-up: asset register eager fetch

The Register tab (`frontend/src/pages/Assets.jsx`) still requests the full
`GET /assets` collection to power client-side search, region filtering, and its
three view modes. The API now supports opt-in pagination
(`?page=&page_size=&q=`), and `GET /assets/summary` covers the Overview tab, but
the register itself has not been migrated. This is the largest remaining
over-fetch (about 12 MB on the demo register).

Suggested next step: move the register's search, region filter, and pagination
to the server (the endpoint already accepts `asset_type`, `substation_id`, and
`q`; add `region_id` server-side), then page the table and cards. Track this as
the follow-up task rather than mixing it into the area restructure.
