# Recurring Schedule Engine Design

Date: 2026-09-10. Sub-project D of the six-part operations enhancement workstream
(crew status lifecycle; auto-counting substation bays + tower/asset standards; follow-up
auto-checklist; recurring schedule engine; line-inspection route tracing). This spec covers
only the recurring schedule engine. It builds on the maintenance-schedule model already
present in `backend/db.js` and the generator in `backend/scheduler.js` /
`backend/routes/schedules.js`.

## 1. Problem

Maintenance schedules today can only express a fixed cadence via the `frequency` enum
(`DAILY`, `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`, `SEMI_ANNUAL`, `ANNUAL`,
`BIENNIAL`, `CUSTOM`). There is no way to express:

- every N days,
- every N weeks on one or more chosen weekdays,
- every N months on a chosen day-of-month,
- monthly on an ordinal weekday (e.g. the last Friday),
- an end condition (stop on a date or after a number of occurrences).

`frequency_config` exists on `maintenance_schedule` but is never read or written (always
`'{}'`), and the UI exposes only the enum. The two generator implementations also diverge:
`backend/routes/schedules.js:advance()` understands `CUSTOM_DAYS` while
`backend/scheduler.js:advance()` does not, so a `CUSTOM_DAYS` schedule advances to an
Invalid Date in the background sweep. There is no persisted occurrence counter, so
count-based endings cannot be represented.

## 2. Goals

1. Support four recurrence patterns, stored in `frequency_config`:
   - `INTERVAL_DAYS` — every N days,
   - `WEEKLY` — every N weeks on one or more weekdays,
   - `MONTHLY_DAY` — every N months on a chosen day-of-month,
   - `MONTHLY_NTH` — every N months on the nth (or last) weekday.
2. Optional end condition: an end date, a maximum occurrence count, or both.
3. When an end condition is reached, auto-deactivate the schedule (`is_active = 0`) after
   generating the final occurrence.
4. Backward compatibility: existing enum-frequency schedules continue to generate exactly as
   they do today.
5. One shared, pure recurrence module is the single source of truth for "what is the next
   occurrence", used by both generator paths. This also removes the `CUSTOM_DAYS` Invalid Date
   bug.
6. The Schedules page can build a recurrence, shows a human-readable summary, and previews the
   next occurrence dates.

## 3. Non-goals

- No catch-up of occurrences missed while the app was offline, and no lead-time generation
  before the due date. `lead_time_days` remains stored but unused, as today.
- No change to the duplicate-suppression semantics: while an OPEN task for the schedule exists,
  generation is skipped.
- No per-target independent cadence; recurrence stays schedule-global.
- No time-of-day picker; the recurrence operates on dates and preserves the anchor's
  time-of-day component.
- No changes to scope expansion, target resolution, task numbering, permissions, or the
  generation cadence (boot + every 6 hours, plus the manual run endpoint).
- No new frontend dependencies.

## 4. Data Model

### 4.1 New column `occurrences_generated`

Added through the existing inline migration helper in `backend/db.js` (alongside the other
`migrate(...)` calls near `db.js:512`):

```js
migrate('maintenance_schedule', 'occurrences_generated', 'ALTER TABLE maintenance_schedule ADD COLUMN occurrences_generated INTEGER NOT NULL DEFAULT 0');
```

It counts how many occurrences the schedule has materialised. It starts at 0 for all existing
rows. It is the basis for the count-based end condition.

### 4.2 `frequency_config` rule object

`frequency_config` stays a `TEXT` column holding JSON. Its shape:

```jsonc
{
  "type": "INTERVAL_DAYS" | "WEEKLY" | "MONTHLY_DAY" | "MONTHLY_NTH",
  "interval": 1,          // integer >= 1: days, weeks, or months depending on type
  "weekdays": [1, 4],     // WEEKLY only; 1=Mon .. 7=Sun, non-empty, unique, sorted
  "day": 15,              // MONTHLY_DAY only; integer 1..31
  "nth": -1,              // MONTHLY_NTH only; 1..5, or -1 for "last"
  "weekday": 5,           // MONTHLY_NTH only; 1..7
  "ends": {               // optional; either/both keys may be absent
    "until": "2026-12-31", // inclusive upper bound date (date-only)
    "count": 10             // integer >= 1 total occurrences ever
  }
}
```

Rules:

- `interval` defaults to 1 when absent.
- `weekdays` is required and non-empty for `WEEKLY`; ignored otherwise.
- `day` is required for `MONTHLY_DAY`; ignored otherwise.
- `nth` and `weekday` are required for `MONTHLY_NTH`; ignored otherwise.
- `ends` may be absent entirely (never ending), or contain only `until`, only `count`, or both.
  When both are present, whichever limit is reached first wins.
- Unknown `type` values are rejected by validation.

### 4.3 `frequency='CUSTOM'` marker

A schedule whose recurrence comes from `frequency_config` stores `frequency='CUSTOM'`. Legacy
schedules keep their existing enum value and an empty/`'{}'` config; they are mapped to an
equivalent rule at read time (see 5.1). The editor writes `CUSTOM` when saving a configured
recurrence, so editing a legacy schedule converts it to `CUSTOM` on save.

## 5. Recurrence Module — `backend/recurrence.js`

A new pure module (no database access, no Express). It is the single source of truth for the
next-occurrence computation and is shared by both generator paths.

### 5.1 `ruleFromSchedule(s)`

Returns a normalized rule for a schedule row.

- If `s.frequency === 'CUSTOM'`, parse `s.frequency_config` via `parseRule`.
- Else map the enum to a rule anchored on `s.next_due_date`:
  - `DAILY` → `{ type:'INTERVAL_DAYS', interval:1 }`
  - `WEEKLY` → `{ type:'WEEKLY', interval:1, weekdays:[<weekday of next_due_date>] }`
  - `BIWEEKLY` → `{ type:'WEEKLY', interval:2, weekdays:[<weekday of next_due_date>] }`
  - `MONTHLY` / `QUARTERLY` / `SEMI_ANNUAL` / `ANNUAL` / `BIENNIAL` →
    `{ type:'MONTHLY_DAY', interval:1|3|6|12|24, day:<day-of-month of next_due_date> }`
  - Any other/unknown value → `{ type:'MONTHLY_DAY', interval:1, day:<day-of-month> }` as a safe
    fallback (matches today's default branch, which called `setMonth`).

`ruleFromSchedule` does not mutate the row.

### 5.2 `parseRule(config)`

Accepts a JSON string or an object. Validates and normalizes:

- `type` must be one of the four supported values.
- `interval` must be an integer in 1..1000 (default 1 when absent).
- `WEEKLY`: `weekdays` must be a non-empty array of unique integers in 1..7; the result is
  sorted ascending.
- `MONTHLY_DAY`: `day` must be an integer 1..31.
- `MONTHLY_NTH`: `nth` must be an integer in 1..5 or exactly -1; `weekday` must be an integer
  1..7.
- `ends`: if present, at least one of `until` (a `YYYY-MM-DD` string) / `count` (integer ≥ 1)
  must be valid; invalid entries are rejected.

On any violation it throws `Error` with a specific, user-facing message (used as the 400 body).

### 5.3 Date math

All computation is done in UTC to avoid timezone drift, and preserves the time-of-day of the
anchor datetime.

- **INTERVAL_DAYS**: add `interval` days.
- **WEEKLY**: let `anchorWeekMonday` be the Monday 00:00 (UTC date) of the week containing the
  anchor. For a candidate date, `weekIndex = floor((candidateWeekMonday - anchorWeekMonday) / 7d)`.
  A date is an occurrence when its ISO weekday is in `weekdays` and `weekIndex % interval === 0`.
  `nextAfter` scans forward day by day (bounded to at most `7 * interval + 7` days) and returns
  the first matching occurrence strictly after the input; returns null if none within the bound
  and no valid occurrence exists.
- **MONTHLY_DAY**: step `interval` months at a time from the anchor month. The day is
  `min(day, daysInMonth)`, so the 31st becomes the last day in short months (clamp-to-last-day).
  Finds the first occurrence strictly after the input.
- **MONTHLY_NTH**: for each candidate month, compute the nth weekday (`nth` in 1..5) or the last
  weekday (`nth = -1`); finds the first occurrence strictly after the input. If `nth` is 1..5 and
  the month does not contain that many of the chosen weekday (e.g. a 5th Friday in a month with
  only four Fridays), that month is skipped and the next valid month is used.

### 5.4 `nextAfter(dateISO, rule)`

Returns an ISO datetime string for the next occurrence strictly after `dateISO`, or `null` when
the rule is exhausted. A rule is exhausted when `ends.until` exists and the computed occurrence
date would be after `until`.

### 5.5 `preview(startISO, rule, n)`

Returns `[startISO, nextAfter(startISO), ...]` — the given start followed by up to `n - 1`
further occurrences, stopping early when exhausted. `n` defaults to 5 and is capped at 20.

### 5.6 `describe(rule)`

Returns a short human-readable string, e.g.:

- `"Every 3 days"`
- `"Every 2 weeks on Mon, Thu"`
- `"Monthly on the 15th"`
- `"Every 3 months on the 31st"`
- `"Monthly on the last Friday"`
- Appends `" until YYYY-MM-DD"` and/or `" for N occurrences"` when the corresponding end
  condition is present.

Ordinal day-of-month values are rendered with English suffixes (`1st`, `2nd`, `3rd`, `4th`,
`21st`, `31st`).

### 5.7 `advanceAfterGeneration(s)`

Pure. Given a schedule row, returns `{ next_due_date, occurrences_generated, is_active }` (plus the optional promotion fields described below):

- `occurrences_generated = (s.occurrences_generated || 0) + 1`.
- `rule = ruleFromSchedule(s)`; `next = nextAfter(s.next_due_date, rule)`.
- If `ends.count` is reached (`occurrences_generated >= count`) or `next` is null (end date
  passed), return `{ next_due_date: s.next_due_date, occurrences_generated, is_active: 0 }`
  (the final occurrence was just generated and the schedule deactivates).
- Otherwise return `{ next_due_date: next, occurrences_generated, is_active: 1 }`.

When a legacy monthly-family rule is advanced — the schedule is not `CUSTOM`, its `type` is
`MONTHLY_DAY`, and its `day > 28` — the result additionally carries `frequency: 'CUSTOM'` and
`frequency_config` set to the normalized rule JSON (anchored on the pre-advance date). This
promotes the schedule to an explicit rule so the intended day survives month-end clamping.
Callers persist these two fields when present.

## 6. Backend Integration

### 6.1 `backend/scheduler.js`

Replace the local `advance()` with a call to `recurrence.ruleFromSchedule` /
`recurrence.nextAfter`, and after each successful generation call
`recurrence.advanceAfterGeneration(s)` and persist `next_due_date`, `occurrences_generated`, and
`is_active`. This fixes the Invalid Date produced for unknown/`CUSTOM_DAYS` frequencies. Callers
persist the promoted `frequency` / `frequency_config` when the step carries them (the scheduler
uses `COALESCE` so absent promotions leave existing values untouched). The
`expand()` and `targetRegion()` helpers are unchanged.

### 6.2 `backend/routes/schedules.js`

Same substitution in the `POST /schedules/run` loop: use `advanceAfterGeneration` to persist the
new `next_due_date` / `occurrences_generated` / `is_active`, plus the promoted `frequency` /
`frequency_config` when the step carries them. The local `advance()` and its
`CUSTOM_DAYS` entry are removed. Target expansion, task-numbering, and the OPEN-task guard are
unchanged. `scheduleDetail()` gains `recurrence_summary` (`describe(ruleFromSchedule(s))`),
`recurrence` (the normalized rule object, so the editor can initialise the builder), and
`occurrences_generated`.

### 6.3 Validation on create/update

`POST /schedules` and `PUT /schedules/:id` validate `frequency_config` whenever
`frequency === 'CUSTOM'` (and also validate a provided config when the frequency is being
switched to `CUSTOM`). Validation uses `parseRule`; a thrown error becomes a 400 with the error
message. On success, the stored `frequency_config` is the normalized JSON string.

### 6.4 Preview endpoint

`GET /schedules/:id/preview` additionally returns `next_occurrences`: the result of
`recurrence.preview(s.next_due_date, rule, 5)`. The existing `targets`, `target_count`, and
`next_due_date` fields are unchanged.

### 6.5 Task completion

On task completion, `applyCompletionSideEffects` no longer uses a local `advanceDate`; it calls
`recurrence.advanceAfterGeneration` only when `s.next_due_date <= t.due_date` (i.e. generation had
not already advanced the schedule), keeping a single source of truth and honouring `CUSTOM` rules
and end conditions. The promoted `frequency` / `frequency_config` are persisted when present.

## 7. Frontend

### 7.1 `frontend/src/pages/Schedules.jsx` — recurrence builder

The create/edit modal replaces the plain Frequency select with a builder:

- **Pattern** select:
  - "Every N days",
  - "Every N weeks on",
  - "Every N months on day",
  - "Monthly on the".
- **Interval** number input (≥ 1) for the first three patterns.
- **Weekday toggles** (Mon–Sun, multi-select) for the weekly pattern.
- **Day-of-month** number (1–31) for "Every N months on day".
- **Ordinal + weekday** selects (First/Second/Third/Fourth/Last + weekday) for the monthly-nth
  pattern.
- **End condition** radio: "Never" / "On date" (date input) / "After N occurrences"
  (number ≥ 1).

On save the builder serialises to the rule object, writes it to `frequency_config`, and sets
`frequency='CUSTOM'`. Client-side validation mirrors `parseRule`; violations show an inline
`ErrorNote` and no request is sent.

When editing a legacy schedule, the builder is initialised from the schedule's `recurrence`
object returned by `scheduleDetail` (which applies the legacy enum mapping). Saving writes the
configured rule and therefore converts the row to `CUSTOM`.

### 7.2 Display

- The list "Frequency" column renders `describe(rule)` when `recurrence_summary` is present,
  falling back to the raw `frequency` value otherwise.
- The detail modal shows the recurrence summary, an occurrence counter when a count end is set
  (e.g. "3 of 10 generated"), and a small ordered list of `next_occurrences` with formatted
  dates.
- An inactive schedule whose end condition is reached shows an "Ended" indicator consistent with
  the existing Active/Inactive Pill.

### 7.3 Styles

Reuse existing classes; small additions only (weekday toggle chips, occurrence list). No new
dependencies.

## 8. Error Handling

- Invalid rule input (API or UI) → HTTP 400 `{ "error": "<specific message>" }`; the page shows
  it through the existing `ErrorNote`.
- `nextAfter` returning null or a reached count → schedule deactivated (`is_active = 0`); the UI
  reflects the ended state.
- Short months clamp to their last day rather than skipping or overflowing.
- Because bad configs are rejected at write time, `ruleFromSchedule` on stored rows is expected
  to succeed; the legacy fallback covers older/unexpected enum values.

## 9. Verification

Isolated-DB end-to-end (same pattern as prior phases: copied demo DB, ephemeral port, server
killed by PID; the real `backend/tmms.db` is never touched):

1. Pure-function checks for `backend/recurrence.js`: all four patterns; weekly multi-day across
   a 2-week interval (correct weeks and weekdays); monthly 31st clamped in Feb/Apr; nth and last
   weekday; `until` and `count` exhaustion returning null / deactivation; `describe` strings;
   `parseRule` rejection of bad shapes.
2. Create a `CUSTOM` weekly multi-day schedule with a count end; run generation; assert the
   generated tasks carry recurrence-date `due_date`s, `occurrences_generated` increments, and
   `next_due_date` advances. Exhaust the count and assert `is_active = 0`.
3. Invalid `frequency_config` on create → 400 with a specific message.
4. A legacy enum schedule still generates identically to before (no regression).
5. `node --check` on every changed backend file; `npm run build` clean.

## 10. Files Touched

- `backend/db.js` — `occurrences_generated` migration.
- `backend/recurrence.js` — new pure recurrence module.
- `backend/scheduler.js` — use the recurrence module; persist the advanced state.
- `backend/routes/schedules.js` — same; validation; `recurrence_summary`; preview occurrences.
- `frontend/src/pages/Schedules.jsx` — recurrence builder, summary, occurrence preview.
- `frontend/src/styles.css` — minor additions.
