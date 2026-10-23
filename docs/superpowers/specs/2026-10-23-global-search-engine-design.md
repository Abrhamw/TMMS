# Global Search Engine Design

Date: 2026-10-23.

## 1. Problem

TMMS already has an authenticated `GET /api/search` and a header search box, but:

- Matching is a single substring (`includes`) over the whole query. A combination such as `sululta 230 transformer` fails unless that exact contiguous string appears in one field.
- Search lives only behind `requireAuth`. The landing page's right-hand blank space cannot show results before sign-in.
- List endpoints (`defects`, `materials`, `resources`, mailbox) each reimplement their own `q` filter and do not share tokenization.

Dispatchers and visitors need a keyword engine that answers combinations of terms, a public landing panel that shows limited results without a session, and a login gate only when a result is opened.

## 2. Goals

1. Extract a reusable keyword engine used by every search surface.
2. Match records when **every** query token appears in at least one searchable field of that record (AND, order-independent).
3. Keep authenticated `GET /api/search` permission-scoped and command-scoped as today.
4. Add unauthenticated `GET /api/search/public` that returns title/subtitle only for regions, substations, lines, towers, assets, and schedules.
5. Put a search panel in the blank right column of the landing page. Opening a result requires sign-in; after login the visitor is sent to that record.
6. Do not leak serial numbers, GPS, condition ratings, people, tasks, crews, or mail on the public endpoint.

## 3. Non-goals

- SQLite FTS5, trigram, or fuzzy matching.
- Rewriting every list endpoint's `q` filter in this pass. The engine is shared; migrating defects/materials/resources/mailbox is follow-up.
- Public access to tasks, people, crews, mailbox, reports, or GPS.
- Changing header GlobalSearch or Ctrl-K layout. They keep calling authenticated `/search` and inherit AND matching.
- Saved searches, search history, or typeahead suggestions beyond live grouped results.

## 4. Keyword engine

New module `backend/searchEngine.js`.

### 4.1 Tokenize

```
tokenize(q) -> string[]
```

- Coerce to string, trim, lowercase.
- Truncate the raw query to 80 characters before splitting.
- Split on whitespace (`/\s+/`).
- Drop empty tokens.
- Keep at most the first 8 tokens.
- Empty input yields `[]`.

### 4.2 Match

```
matches(tokens, fields) -> boolean
```

- `fields` is an array of values (string/number/null). Null/undefined become `''`.
- Each field is lowercased independently.
- Returns true iff every token is a substring of at least one field. A token cannot match across two fields.
- Empty `tokens` returns false (callers short-circuit empty queries before matching).

### 4.3 Rank

```
rank(tokens, titleFields, extraFields) -> number
```

Used to order items inside a group, highest first:

- +3 per token that hits a title/code field (`titleFields`).
- +1 per token that hits only `extraFields`.
- Stable tie-break is the existing id descending (newest / highest id first), applied by the route after rank.

### 4.4 Query helper

```
parseSearchQuery(raw) -> { raw, tokens }
```

`raw` is the trimmed original (still capped at 80 chars). `tokens` is `tokenize(raw)`.

## 5. Authenticated search

`GET /api/search?q=&limit=` stays behind `requireAuth`. Behaviour:

- Empty `q` → `{ query: '', total: 0, groups: [] }`.
- `limit` default 8, min 1, max 25 (unchanged).
- Groups unchanged: task, asset, crew, person, substation, line, tower, region, schedule. Each still gated by the matching read permission and `commandScope` / `taskVisible` / `readCrewIds`.
- Matching uses `matches(tokens, fields)` instead of `contains(q, ...)`.
- Item shape unchanged (`id`, `type`, `title`, `subtitle`, `badge?`, `href?`, `document_type?`).
- `total` remains the sum of untruncated group totals (each group still slices to `limit` for `items`).

Searchable fields per type (authenticated):

| Type | Title/code fields | Extra fields |
| --- | --- | --- |
| task | title, task_number | status |
| asset | name, asset_id | serial_number, manufacturer, model, asset_type, sub_type |
| crew | name, crew_code | crew_type |
| person | first_name, last_name, full name | title, email |
| substation | name, substation_id | region name |
| line | name, line_id | voltage_kv, region name |
| tower | tower_id, tower_number | tower_type, km_marker |
| region | name, code | — |
| schedule | schedule_name, schedule_code | frequency, region name |

## 6. Public search

`GET /api/search/public?q=&limit=` is mounted on `/api` **before** `requireAuth`. Same limiter as other `/api` routes. Never 401s.

Allowed types only:

| Type | Title/code fields | Extra fields | Public subtitle | href |
| --- | --- | --- | --- | --- |
| region | name, code | — | code | `/infrastructure?tab=region&region={id}` |
| substation | name, substation_id | region name | substation_id · region name | `/infrastructure?tab=substation&substation={id}` |
| line | name, line_id | voltage_kv, region name | line_id · `{n} kV` · region name | `/infrastructure?tab=line&line={id}` |
| tower | tower_id, tower_number | tower_type | tower_type | `/infrastructure?tab=line&line={line_id}&manage=towers` (or `/infrastructure?manage=towers` if no line) |
| asset | name, asset_id | asset_type, sub_type, parent voltage, parent region name | asset_id · asset_type | `/assets?asset={id}` |
| schedule | schedule_name, schedule_code | frequency | schedule_code · frequency | `/schedules` |

Public item shape is strictly `{ id, type, title, subtitle, href }`. Forbidden on this endpoint:

- serial_number, manufacturer, model, condition_rating, GPS, lat/lng
- people, crews, tasks, mailbox, reports, documents
- `document_type` (opening a document requires auth; public results always use `href`)

`limit` and empty-query behaviour match authenticated search.

Public matching still uses region names as extra fields so `sululta 230 transformer` can hit an asset whose name contains transformer, whose type/voltage/parent region supply the other tokens. Voltage for assets is taken from the parent line or substation when present; it is not a stored asset column.

## 7. Login `next`

Landing result clicks go to `/login?persona=other&next=<href>`.

- `Login.jsx` reads `next` from the query string.
- A path is accepted only when it is a single internal path: starts with `/`, does not start with `//`, contains no `://`, and has no backslash. Everything else is discarded.
- After a successful sign-in, navigate to the accepted `next`, else `/home`.
- Existing persona handling is unchanged. `persona=other` is the default for search-driven login.

Unauthenticated users who already have a token are still redirected from landing to `/home` (current behaviour). They use header search, not the landing panel.

## 8. Landing UI

`frontend/src/pages/Landing.jsx` becomes a two-column shell:

- Left: existing hero, persona grid, footer. Unchanged copy and navigation (`/login?persona={key}`).
- Right: search panel filling the blank dark column from the attached mock.

Right panel contents:

1. Heading ("Search the network") and a one-line hint that results are public infrastructure; opening one requires sign-in.
2. Search input (same debounce 220ms as `GlobalSearch`).
3. Grouped results (type label + count, title, subtitle). Keyboard: ArrowUp/Down, Enter, Escape.
4. States: idle hint, loading, empty ("No matches."), error.

Clicking a result navigates to `/login?persona=other&next={encodeURIComponent(item.href)}`. No document modal on landing.

On viewports below 960px the search panel stacks below the persona grid so the page remains usable on a phone.

`GlobalSearch.jsx` is not reused on landing: it calls authenticated `/search` and opens document modals. Landing uses a small dedicated panel that calls `/search/public` without a token.

Header `GlobalSearch` and Ctrl-K are unchanged callers of `/search`.

## 9. Server wiring

In `backend/server.js`, register the public route **before** `requireAuth`:

```
app.use('/api', apiLimiterFromEnv());
app.use('/api', publicSearchRouter);   // GET /search/public only
app.use('/api', requireAuth, auditMiddleware);
...
app.use('/api', require('./routes/search'));  // authenticated /search
```

`publicSearchRouter` exports a router with a single `GET /search/public`. Authenticated `/search` stays in `backend/routes/search.js` and imports the engine.

`GET /search/public` must not run `auditMiddleware` (no user). Rate limit is the shared API limiter.

## 10. Error handling

- Empty / whitespace query: 200 `{ query: '', total: 0, groups: [] }`.
- Query longer than 80 characters: truncated, then tokenized.
- More than 8 tokens: first 8 used.
- Public endpoint: never 401 / 403. Unknown types are simply absent from `groups`.
- Invalid `next`: ignored; user lands on `/home`.
- Frontend: loading, empty, and error notes in the panel. After login, a missing record is the destination page's normal 404.

## 11. Testing

Backend (`backend/test/searchEngine.test.js` and `backend/test/searchPublic.test.js`):

- `tokenize`: trim, lowercase, cap 80 chars, cap 8 tokens, empty → `[]`.
- `matches`: AND across fields; missing token fails; order does not matter.
- `rank`: title hits outrank extra-field hits.
- Public search requires no token.
- Public groups contain only the six allowed types.
- Public items have only `id`, `type`, `title`, `subtitle`, `href`.
- AND query `sululta 230` matches a 230 kV Sululta line; dropping a token that is not present yields no match.
- Authenticated search still hides another region's tasks from a region-scoped user.
- Login `next` helper (or Login page test) accepts `/infrastructure?tab=line&line=1` and rejects `//evil.example` and `https://evil.example`.

Frontend:

- Landing panel renders in the right column.
- Typing hits `/api/search/public`.
- Clicking a result goes to `/login?persona=other&next=…`.

Verification commands (existing convention):

```
cd /workspace/backend && npm test
cd /workspace/frontend && npm run build && npm test
```

## 12. i18n

Add keys in `en.js` (and the matching `es`, `zh`, `am` files so the lookup does not fall through to the key name):

- `landingSearchTitle`
- `landingSearchHint`
- `landingSearchPlaceholder`
- `landingSearchEmpty`
- `landingSearchSignIn`

English copy:

- Title: Search the network
- Hint: Public infrastructure, assets, and schedules. Sign in to open a result.
- Placeholder: Try sululta 230 transformer
- Empty: No matches.
- Sign-in note: Sign in to open this record.

## 13. Out of scope follow-ups

- Point defects/materials/resources/mailbox `q` filters at `searchEngine.matches`.
- FTS5 if table scans become slow on a much larger register.
- Public document previews.
