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

## Asset register now server-filtered

The Register tab (`frontend/src/pages/Assets.jsx`) no longer downloads the full
`GET /assets` collection. Its search, asset-type filter, region filter,
substation filter, and paging are all sent to the server, which returns a
`{items,total,page,page_size}` envelope (50 rows per view). `GET /assets` gained
a `region_id` filter and its `q` search now also matches parent substation and
line names server-side. The table and cards render only the current page; the
Register tree keeps its own scoped tree endpoint.

This removes the largest remaining over-fetch (previously about 12 MB on the
demo register; a page is roughly tens of KB).

