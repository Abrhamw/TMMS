# Recurring Schedule Engine Implementation Plan (Sub-project D)

Date: 2026-09-10
Spec: `docs/superpowers/specs/2026-09-10-recurring-schedule-engine-design.md`
Sub-project: D of the six-part operations workstream. A (crew status), B1 (counting standards),
B2 (line map workspace) are complete. D adds rich recurrence rules (custom intervals, weekly
multi-weekday, monthly day, monthly nth/last weekday) with optional end conditions, a shared pure
recurrence module, and a recurrence builder on the Schedules page.

## Goal

Let maintenance schedules recur on flexible patterns stored in `frequency_config`, end after a
date or a number of occurrences (auto-deactivating), preview upcoming occurrence dates, and keep
legacy enum-frequency schedules working unchanged via one shared pure recurrence module.

## Architecture

- **`backend/recurrence.js`** (new, pure): rule parsing/normalization, next-occurrence math
  (UTC, clamp-to-last-day, nth/last weekday), human-readable `describe`, `preview`, and the pure
  `advanceAfterGeneration` step function. No DB, no Express.
- **Generators** (`backend/scheduler.js`, `backend/routes/schedules.js`): replace their local,
  divergent `advance()` with `recurrence.advanceAfterGeneration` and persist
  `next_due_date` / `occurrences_generated` / `is_active` together. Scope expansion, task
  numbering, permissions, cadence, and the OPEN-task dedupe guard are untouched.
- **`maintenance_schedule.occurrences_generated`** (new column via `migrate()`): basis for the
  count-based end condition.
- **Schedules API**: validates `frequency_config` for `CUSTOM` rows (400 with a specific
  message), and returns `recurrence`, `recurrence_summary`, `occurrences_generated`, and
  `next_occurrences`.
- **`frontend/src/pages/Schedules.jsx`**: a recurrence builder in the create/edit modal plus a
  human-readable summary and upcoming-dates display. No new dependencies.

## Tech Stack

Express 5 / CommonJS / Node >=22.5 / `node:sqlite` (`DatabaseSync`, `PRAGMA foreign_keys = ON`).
React + Vite. No test framework: verify with `node --check`, scratch `node` assertion scripts, and
a scratch server on a copied demo DB (ports 3011+ are taken by B2 checks; use 3014). No new
dependencies.

## Global Constraints

- All recurrence date math is UTC and preserves the anchor datetime's time-of-day.
- Stored `frequency_config` is a JSON string; `frequency = 'CUSTOM'` marks a config-driven row.
- Legacy enum rows (`DAILY`/`WEEKLY`/`BIWEEKLY`/`MONTHLY`/`QUARTERLY`/`SEMI_ANNUAL`/`ANNUAL`/
  `BIENNIAL`) map to an equivalent rule anchored on `next_due_date` and otherwise behave as today.
  One intentional improvement: legacy monthly-style rows on the 29th-31st now clamp to the last
  day of short months instead of overflowing into the next month.
- Clamp-to-last-day for monthly day-of-month; a monthly nth weekday that does not exist in a month
  is skipped (next valid month used).
- While an OPEN task exists for a schedule (existing guard), generation is skipped WITHOUT
  advancing state. No catch-up and no lead-time generation.
- `next_due_date` / `occurrences_generated` / `is_active` are persisted together after each
  successful generation. Reaching an end date or the max occurrence count sets `is_active = 0`.
- Invalid rule input returns HTTP 400 `{ "error": "<specific message>" }`.
- Never stage runtime files (`backend/tmms.db*`, `backend/uploads/`, `frontend/dist/`); `.superpowers/`
  is gitignored.

---

## Task 1: `backend/recurrence.js` (pure recurrence module)

**Files**: create `backend/recurrence.js`

**Interfaces**:
- Consumes: nothing (pure).
- Produces (exports):
  - `parseRule(config)` → normalized rule object; throws `Error` with a specific message.
  - `ruleFromSchedule(s)` → normalized rule for a schedule row (parses config for `CUSTOM`;
    maps the legacy enum otherwise; lenient fallback for a malformed `CUSTOM` config).
  - `nextAfter(dateISO, rule)` → ISO datetime string strictly after `dateISO`, or `null` when
    exhausted.
  - `preview(startISO, rule, n=5)` → array of up to `n` ISO datetimes (capped at 20).
  - `describe(rule)` → human-readable string.
  - `advanceAfterGeneration(s)` → `{ next_due_date, occurrences_generated, is_active }`.

**Steps**:

1. Create the file with the following content:

```js
// Pure recurrence helpers for maintenance schedules. No DB access, no Express.
// A rule is a plain object:
//   { type, interval, weekdays?, day?, nth?, weekday?, ends? }
// type: INTERVAL_DAYS | WEEKLY | MONTHLY_DAY | MONTHLY_NTH
// All date math is UTC and preserves the time-of-day of the anchor datetime.

const TYPES = ['INTERVAL_DAYS', 'WEEKLY', 'MONTHLY_DAY', 'MONTHLY_NTH'];
const DAY_MS = 86400000;
const WEEKDAY_NAMES = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

function isoWeekday(date) {
  const wd = date.getUTCDay(); // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd;
}

function startOfWeekMonday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - (isoWeekday(d) - 1));
  return d;
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function atSameTime(anchor, year, monthIndex, day) {
  return new Date(Date.UTC(
    year, monthIndex, day,
    anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()
  ));
}

function parseRule(config) {
  let raw = config;
  if (typeof raw === 'string') {
    if (!raw.trim()) raw = {};
    else {
      try { raw = JSON.parse(raw); }
      catch { throw new Error('frequency_config is not valid JSON'); }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid recurrence rule');
  const type = raw.type;
  if (!TYPES.includes(type)) throw new Error(`Unsupported recurrence type: ${type || '(missing)'}`);
  const interval = raw.interval == null ? 1 : Number(raw.interval);
  if (!Number.isInteger(interval) || interval < 1) throw new Error('Recurrence interval must be an integer >= 1');
  const rule = { type, interval };

  if (type === 'WEEKLY') {
    const mapped = Array.isArray(raw.weekdays) ? raw.weekdays.map(Number) : [];
    const weekdays = [...new Set(mapped)].sort((a, b) => a - b);
    if (!weekdays.length) throw new Error('Weekly recurrence needs at least one weekday');
    if (weekdays.some((x) => !Number.isInteger(x) || x < 1 || x > 7)) throw new Error('Weekdays must be integers 1..7 (Mon=1)');
    rule.weekdays = weekdays;
  } else if (type === 'MONTHLY_DAY') {
    const day = Number(raw.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Day of month must be an integer 1..31');
    rule.day = day;
  } else if (type === 'MONTHLY_NTH') {
    const nth = Number(raw.nth);
    if (!(nth === -1 || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) throw new Error('Ordinal must be 1..5 or -1 (last)');
    const weekday = Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error('Weekday must be an integer 1..7 (Mon=1)');
    rule.nth = nth;
    rule.weekday = weekday;
  }

  if (raw.ends && typeof raw.ends === 'object') {
    const ends = {};
    if (raw.ends.until != null && raw.ends.until !== '') {
      const until = String(raw.ends.until).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('End date must be YYYY-MM-DD');
      ends.until = until;
    }
    if (raw.ends.count != null && raw.ends.count !== '') {
      const count = Number(raw.ends.count);
      if (!Number.isInteger(count) || count < 1) throw new Error('Occurrence count must be an integer >= 1');
      ends.count = count;
    }
    if (Object.keys(ends).length) rule.ends = ends;
  }
  return rule;
}

// Map a legacy frequency enum (or a CUSTOM config) to a normalized rule. For CUSTOM we are
// lenient: a malformed historical config falls back to the monthly mapping instead of aborting
// the background sweep. Write-time validation (parseRule) is what rejects bad input.
function ruleFromSchedule(s) {
  if (!s) throw new Error('Schedule is required');
  if (s.frequency === 'CUSTOM') {
    try { return parseRule(s.frequency_config); }
    catch { /* fall through to the legacy mapping */ }
  }
  const anchor = new Date(s.next_due_date);
  if (Number.isNaN(anchor.getTime())) throw new Error('Schedule next_due_date is invalid');
  const weekday = isoWeekday(anchor);
  const day = anchor.getUTCDate();
  const byFrequency = {
    DAILY: { type: 'INTERVAL_DAYS', interval: 1 },
    WEEKLY: { type: 'WEEKLY', interval: 1, weekdays: [weekday] },
    BIWEEKLY: { type: 'WEEKLY', interval: 2, weekdays: [weekday] },
    MONTHLY: { type: 'MONTHLY_DAY', interval: 1, day },
    QUARTERLY: { type: 'MONTHLY_DAY', interval: 3, day },
    SEMI_ANNUAL: { type: 'MONTHLY_DAY', interval: 6, day },
    ANNUAL: { type: 'MONTHLY_DAY', interval: 12, day },
    BIENNIAL: { type: 'MONTHLY_DAY', interval: 24, day },
  };
  return byFrequency[s.frequency] || { type: 'MONTHLY_DAY', interval: 1, day };
}

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  if (nth === -1) {
    const last = daysInMonth(year, monthIndex);
    for (let day = last; day >= last - 6; day--) {
      if (isoWeekday(new Date(Date.UTC(year, monthIndex, day))) === weekday) return day;
    }
    return null;
  }
  const firstWeekday = isoWeekday(new Date(Date.UTC(year, monthIndex, 1)));
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
  return day > daysInMonth(year, monthIndex) ? null : day;
}

function nextWeekly(anchor, interval, weekdays) {
  const anchorWeek = startOfWeekMonday(anchor);
  const maxScan = interval * 7 + 7;
  for (let i = 1; i <= maxScan; i++) {
    const cand = new Date(anchor.getTime());
    cand.setUTCDate(cand.getUTCDate() + i);
    if (!weekdays.includes(isoWeekday(cand))) continue;
    const weekIndex = Math.round((startOfWeekMonday(cand).getTime() - anchorWeek.getTime()) / (7 * DAY_MS));
    if (weekIndex % interval === 0) return cand;
  }
  return null;
}

function nextMonthlyDay(anchor, interval, day) {
  const baseYear = anchor.getUTCFullYear();
  const baseMonth = anchor.getUTCMonth();
  for (let k = 0; k < 1200; k++) {
    const total = baseMonth + interval * k;
    const year = baseYear + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    const cand = atSameTime(anchor, year, month, Math.min(day, daysInMonth(year, month)));
    if (cand.getTime() > anchor.getTime()) return cand;
  }
  return null;
}

function nextMonthlyNth(anchor, interval, nth, weekday) {
  const baseYear = anchor.getUTCFullYear();
  const baseMonth = anchor.getUTCMonth();
  for (let k = 0; k < 1200; k++) {
    const total = baseMonth + interval * k;
    const year = baseYear + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    const day = nthWeekdayOfMonth(year, month, weekday, nth);
    if (day == null) continue;
    const cand = atSameTime(anchor, year, month, day);
    if (cand.getTime() > anchor.getTime()) return cand;
  }
  return null;
}

function computeNext(anchor, rule) {
  switch (rule.type) {
    case 'INTERVAL_DAYS': return nextIntervalDays(anchor, rule.interval);
    case 'WEEKLY': return nextWeekly(anchor, rule.interval, rule.weekdays);
    case 'MONTHLY_DAY': return nextMonthlyDay(anchor, rule.interval, rule.day);
    case 'MONTHLY_NTH': return nextMonthlyNth(anchor, rule.interval, rule.nth, rule.weekday);
    default: return null;
  }
}

function nextIntervalDays(anchor, interval) {
  const d = new Date(anchor.getTime());
  d.setUTCDate(d.getUTCDate() + interval);
  return d;
}

function nextAfter(dateISO, rule) {
  const anchor = new Date(dateISO);
  if (Number.isNaN(anchor.getTime())) throw new Error('nextAfter received an invalid date');
  const next = computeNext(anchor, rule);
  if (!next) return null;
  if (rule.ends && rule.ends.until) {
    const limit = new Date(`${rule.ends.until}T23:59:59.999Z`);
    if (next.getTime() > limit.getTime()) return null;
  }
  return next.toISOString();
}

function preview(startISO, rule, n = 5) {
  const count = Math.max(1, Math.min(20, Number(n) || 5));
  const start = new Date(startISO);
  const out = [];
  if (Number.isNaN(start.getTime())) return out;
  out.push(start.toISOString());
  let cursor = start.toISOString();
  for (let i = 1; i < count; i++) {
    const next = nextAfter(cursor, rule);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

function describe(rule) {
  if (!rule) return '';
  let base;
  if (rule.type === 'INTERVAL_DAYS') {
    base = rule.interval === 1 ? 'Every day' : `Every ${rule.interval} days`;
  } else if (rule.type === 'WEEKLY') {
    const days = rule.weekdays.map((w) => WEEKDAY_NAMES[w]).join(', ');
    base = `${rule.interval === 1 ? 'Every week' : `Every ${rule.interval} weeks`} on ${days}`;
  } else if (rule.type === 'MONTHLY_DAY') {
    base = rule.interval === 1
      ? `Monthly on the ${ordinal(rule.day)}`
      : `Every ${rule.interval} months on the ${ordinal(rule.day)}`;
  } else if (rule.type === 'MONTHLY_NTH') {
    const nthWord = rule.nth === -1 ? 'last' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][rule.nth];
    base = `${rule.interval === 1 ? 'Monthly' : `Every ${rule.interval} months`} on the ${nthWord} ${WEEKDAY_NAMES[rule.weekday]}day`;
  } else {
    return '';
  }
  let suffix = '';
  if (rule.ends && rule.ends.until) suffix += ` until ${rule.ends.until}`;
  if (rule.ends && rule.ends.count) suffix += ` for ${rule.ends.count} occurrences`;
  return base + suffix;
}

// Pure step applied after a schedule's occurrence has been materialised.
function advanceAfterGeneration(s) {
  const rule = ruleFromSchedule(s);
  const occurrences_generated = (Number(s.occurrences_generated) || 0) + 1;
  const next = nextAfter(s.next_due_date, rule);
  const countReached = !!(rule.ends && rule.ends.count && occurrences_generated >= rule.ends.count);
  if (countReached || !next) {
    return { next_due_date: s.next_due_date, occurrences_generated, is_active: 0 };
  }
  return { next_due_date: next, occurrences_generated, is_active: 1 };
}

module.exports = {
  parseRule,
  ruleFromSchedule,
  nextAfter,
  preview,
  describe,
  advanceAfterGeneration,
};
```

2. Create the scratch verification script `/tmp/recurrence-check.js`:

```js
const assert = require('node:assert');
const r = require('/workspace/backend/recurrence.js');
const rule = (o) => r.parseRule(o);

// INTERVAL_DAYS
assert.strictEqual(r.nextAfter('2026-01-01T00:00:00.000Z', rule({ type: 'INTERVAL_DAYS', interval: 3 })), '2026-01-04T00:00:00.000Z');

// WEEKLY single weekday, interval 2: anchor Wed 2026-01-07, next allowed Monday is 2026-01-19
assert.strictEqual(r.nextAfter('2026-01-07T00:00:00.000Z', rule({ type: 'WEEKLY', interval: 2, weekdays: [1] })), '2026-01-19T00:00:00.000Z');

// WEEKLY multi weekday, interval 1: Mon 2026-01-05 -> Thu 2026-01-08 -> Mon 2026-01-12
assert.strictEqual(r.nextAfter('2026-01-05T00:00:00.000Z', rule({ type: 'WEEKLY', interval: 1, weekdays: [1, 4] })), '2026-01-08T00:00:00.000Z');
assert.strictEqual(r.nextAfter('2026-01-08T00:00:00.000Z', rule({ type: 'WEEKLY', interval: 1, weekdays: [1, 4] })), '2026-01-12T00:00:00.000Z');

// MONTHLY_DAY clamp-to-last-day (2026 not leap; 2028 leap)
assert.strictEqual(r.nextAfter('2026-01-31T00:00:00.000Z', rule({ type: 'MONTHLY_DAY', interval: 1, day: 31 })), '2026-02-28T00:00:00.000Z');
assert.strictEqual(r.nextAfter('2028-01-31T00:00:00.000Z', rule({ type: 'MONTHLY_DAY', interval: 1, day: 31 })), '2028-02-29T00:00:00.000Z');

// MONTHLY_NTH last Friday of Jan 2026 = 2026-01-30
assert.strictEqual(r.nextAfter('2026-01-01T00:00:00.000Z', rule({ type: 'MONTHLY_NTH', interval: 1, nth: -1, weekday: 5 })), '2026-01-30T00:00:00.000Z');

// MONTHLY_NTH 5th Monday: Jan/Feb 2026 have only 4 -> first 5-Monday month is Mar 2026 -> 2026-03-30
assert.strictEqual(r.nextAfter('2026-01-01T00:00:00.000Z', rule({ type: 'MONTHLY_NTH', interval: 1, nth: 5, weekday: 1 })), '2026-03-30T00:00:00.000Z');

// End date is inclusive; the occurrence after it is null
assert.strictEqual(r.nextAfter('2026-01-02T00:00:00.000Z', rule({ type: 'INTERVAL_DAYS', interval: 1, ends: { until: '2026-01-03' } })), '2026-01-03T00:00:00.000Z');
assert.strictEqual(r.nextAfter('2026-01-03T00:00:00.000Z', rule({ type: 'INTERVAL_DAYS', interval: 1, ends: { until: '2026-01-03' } })), null);

// Count-based end via the pure step
const s0 = { frequency: 'CUSTOM', frequency_config: JSON.stringify({ type: 'INTERVAL_DAYS', interval: 1, ends: { count: 2 } }), next_due_date: '2026-01-01T00:00:00.000Z', occurrences_generated: 0 };
const step1 = r.advanceAfterGeneration(s0);
assert.deepStrictEqual(step1, { next_due_date: '2026-01-02T00:00:00.000Z', occurrences_generated: 1, is_active: 1 });
const step2 = r.advanceAfterGeneration({ ...s0, next_due_date: step1.next_due_date, occurrences_generated: 1 });
assert.deepStrictEqual(step2, { next_due_date: '2026-01-02T00:00:00.000Z', occurrences_generated: 2, is_active: 0 });

// describe
assert.strictEqual(r.describe(rule({ type: 'INTERVAL_DAYS', interval: 3 })), 'Every 3 days');
assert.strictEqual(r.describe(rule({ type: 'WEEKLY', interval: 2, weekdays: [1, 4] })), 'Every 2 weeks on Mon, Thu');
assert.strictEqual(r.describe(rule({ type: 'MONTHLY_DAY', interval: 1, day: 15 })), 'Monthly on the 15th');
assert.strictEqual(r.describe(rule({ type: 'MONTHLY_NTH', interval: 1, nth: -1, weekday: 5 })), 'Monthly on the last Friday');
assert.strictEqual(r.describe(rule({ type: 'MONTHLY_DAY', interval: 1, day: 15, ends: { until: '2026-12-31', count: 10 } })), 'Monthly on the 15th until 2026-12-31 for 10 occurrences');

// Legacy enum mapping
assert.deepStrictEqual(r.ruleFromSchedule({ frequency: 'WEEKLY', next_due_date: '2026-01-07T00:00:00.000Z' }).weekdays, [3]);
assert.strictEqual(r.ruleFromSchedule({ frequency: 'ANNUAL', next_due_date: '2026-01-15T00:00:00.000Z' }).interval, 12);
assert.deepStrictEqual(r.ruleFromSchedule({ frequency: 'CUSTOM', frequency_config: '{}', next_due_date: '2026-01-15T00:00:00.000Z' }), { type: 'MONTHLY_DAY', interval: 1, day: 15 });

// parseRule rejections
assert.throws(() => rule({ type: 'WEEKLY', interval: 1, weekdays: [] }));
assert.throws(() => rule({ type: 'MONTHLY_DAY', day: 0 }));
assert.throws(() => rule({ type: 'MONTHLY_NTH', nth: 6, weekday: 1 }));
assert.throws(() => rule({ type: 'BOGUS' }));
assert.throws(() => r.parseRule('{not json'));

console.log('recurrence checks passed');
```

3. Run the scratch checks:

Run: `node /tmp/recurrence-check.js`
Expected: `recurrence checks passed`

4. Syntax check:

Run: `node --check backend/recurrence.js`
Expected: exit 0, no output.

5. Commit:

```bash
git add backend/recurrence.js
git commit -m "feat(recurrence): pure recurring-schedule rule and occurrence engine"
```

---

## Task 2: Engine wiring (schema + generators)

**Files**:
- Modify: `backend/db.js:537` (add migration after the last `migrate(...)` call)
- Modify: `backend/scheduler.js` (require, update statement :59, remove `advance` :112-119)
- Modify: `backend/routes/schedules.js` (require, update statement :192, remove `advance` :197-205)

**Interfaces**:
- Consumes: `recurrence.advanceAfterGeneration(s)` → `{ next_due_date, occurrences_generated, is_active }` (Task 1).
- Produces: `maintenance_schedule.occurrences_generated`; generation in both paths persists the
  advanced state and deactivates ended schedules.

**Steps**:

1. In `backend/db.js`, insert after line 537 (the last existing `migrate(...)`):

```js
  migrate('maintenance_schedule', 'occurrences_generated', 'ALTER TABLE maintenance_schedule ADD COLUMN occurrences_generated INTEGER NOT NULL DEFAULT 0');
```

2. In `backend/scheduler.js`, add the require at the top (after line 1):

```js
const recurrence = require('./recurrence');
```

3. In `backend/scheduler.js`, replace the schedule update at line 59:

```js
      d.prepare('UPDATE maintenance_schedule SET last_generated_at = ?, next_due_date = ? WHERE id = ?').run(now, advance(s.next_due_date, s.frequency), s.id);
```

with:

```js
      const step = recurrence.advanceAfterGeneration(s);
      d.prepare('UPDATE maintenance_schedule SET last_generated_at = ?, next_due_date = ?, occurrences_generated = ?, is_active = ? WHERE id = ?')
        .run(now, step.next_due_date, step.occurrences_generated, step.is_active, s.id);
```

4. In `backend/scheduler.js`, remove the now-unused local `advance` function (lines 112-119):

```js
function advance(dateStr, frequency) {
  const d = new Date(dateStr);
  const map = { DAILY: 0, WEEKLY: 7, BIWEEKLY: 14, MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12, BIENNIAL: 24 };
  if (frequency === 'DAILY') d.setDate(d.getDate() + 1);
  else if (['WEEKLY', 'BIWEEKLY'].includes(frequency)) d.setDate(d.getDate() + map[frequency]);
  else d.setMonth(d.getMonth() + map[frequency]);
  return d.toISOString();
}

```

5. In `backend/routes/schedules.js`, add the require after line 3:

```js
const recurrence = require('../recurrence');
```

6. In `backend/routes/schedules.js`, replace the update at line 192:

```js
    updateRow('maintenance_schedule', s.id, { last_generated_at: now, next_due_date: advance(s.next_due_date, s.frequency) });
```

with:

```js
    const step = recurrence.advanceAfterGeneration(s);
    updateRow('maintenance_schedule', s.id, {
      last_generated_at: now,
      next_due_date: step.next_due_date,
      occurrences_generated: step.occurrences_generated,
      is_active: step.is_active,
    });
```

7. In `backend/routes/schedules.js`, remove the now-unused local `advance` function (lines 197-205):

```js
function advance(dateStr, frequency) {
  const numeric = /^\d+(\.\d+)?$/.test(String(dateStr)) ? Number(dateStr) : NaN;
  const d = new Date(Number.isNaN(numeric) ? dateStr : numeric);
  const map = { DAILY: 0, WEEKLY: 7, BIWEEKLY: 14, MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12, BIENNIAL: 24, CUSTOM_DAYS: 30 };
  if (frequency === 'DAILY') d.setDate(d.getDate() + 1);
  else if (['WEEKLY', 'BIWEEKLY'].includes(frequency)) d.setDate(d.getDate() + map[frequency]);
  else d.setMonth(d.getMonth() + map[frequency]);
  return d.toISOString();
}

```

8. Syntax checks:

Run: `node --check backend/db.js && node --check backend/scheduler.js && node --check backend/routes/schedules.js`
Expected: exit 0, no output.

9. Scratch end-to-end (copied demo DB; never touch `backend/tmms.db`):

```bash
cp backend/tmms.db /tmp/tmms-d2.db
[ -f backend/tmms.db-wal ] && cp backend/tmms.db-wal /tmp/tmms-d2.db-wal || true
[ -f backend/tmms.db-shm ] && cp backend/tmms.db-shm /tmp/tmms-d2.db-shm || true
TMMS_DB=/tmp/tmms-d2.db PORT=3014 node backend/server.js
```

Start the server in a background terminal (not a blocking shell). Wait ~2s, then read the log to
confirm it is listening. Login and create a due `CUSTOM` schedule (pick an existing tower for
scope):

```bash
TOKEN=$(curl -s -X POST localhost:3014/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
PAST=$(node -e "console.log(new Date(Date.now()-86400000).toISOString())")
curl -s -X POST localhost:3014/api/schedules -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"schedule_name\":\"D2 probe\",\"schedule_code\":\"D2-PROBE\",\"scope_type\":\"TOWER\",\"tower_id\":21,\"frequency\":\"CUSTOM\",\"frequency_config\":\"{\\\"type\\\":\\\"INTERVAL_DAYS\\\",\\\"interval\\\":1,\\\"ends\\\":{\\\"count\\\":2}}\",\"priority\":\"LOW\",\"next_due_date\":\"$PAST\"}"
```

Run generation for just that schedule, then assert the first occurrence advanced:

```bash
SID=$(curl -s "localhost:3014/api/schedules?q=D2 probe" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
curl -s -X POST localhost:3014/api/schedules/run -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"schedule_id\":$SID}"
curl -s "localhost:3014/api/schedules/$SID" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log('generated=',x.occurrences_generated,'active=',x.is_active,'next=',x.next_due_date)})"
```

Expected: `generated= 1 active= 1` and `next=` is 24h after the past `next_due_date`.

Close the generated task so the OPEN-task guard does not block the second run (scratch DB only):

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/tmp/tmms-d2.db');db.prepare(\"UPDATE task SET status='COMPLETED' WHERE schedule_id=?\").run($SID);console.log('closed')"
```

Run again and assert exhaustion deactivates:

```bash
curl -s -X POST localhost:3014/api/schedules/run -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"schedule_id\":$SID}"
curl -s "localhost:3014/api/schedules/$SID" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log('generated=',x.occurrences_generated,'active=',x.is_active)})"
```

Expected: `generated= 2 active= 0`.

Legacy regression check (a plain `MONTHLY` schedule still generates):

```bash
curl -s -X POST localhost:3014/api/schedules -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"schedule_name\":\"D2 legacy\",\"schedule_code\":\"D2-LEGACY\",\"scope_type\":\"TOWER\",\"tower_id\":21,\"frequency\":\"MONTHLY\",\"priority\":\"LOW\",\"next_due_date\":\"$PAST\"}"
LSID=$(curl -s "localhost:3014/api/schedules?q=D2 legacy" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
curl -s -X POST localhost:3014/api/schedules/run -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"schedule_id\":$LSID}"
```

Expected: `generated` count is 1 (the response's `generated` field is 1).

10. Stop the scratch server (by PID; do not use pkill). Then commit:

```bash
git add backend/db.js backend/scheduler.js backend/routes/schedules.js
git commit -m "feat(schedules): drive generation through the recurrence engine"
```

---

## Task 3: Schedules API surface (validation, detail, preview)

**Files**: modify `backend/routes/schedules.js`

**Interfaces**:
- Consumes: `recurrence.parseRule`, `recurrence.ruleFromSchedule`, `recurrence.describe`,
  `recurrence.preview` (Task 1).
- Produces:
  - `POST /schedules`, `PUT /schedules/:id`: reject invalid `CUSTOM` config with 400; store
    normalized JSON.
  - `scheduleDetail(s)` fields: `recurrence` (rule object), `recurrence_summary` (string),
    `occurrences_generated` (integer).
  - `GET /schedules/:id/preview` field: `next_occurrences` (array of ISO strings).

**Steps**:

1. In `backend/routes/schedules.js`, extend `scheduleDetail` (currently lines 28-39). Replace:

```js
function scheduleDetail(s) {
  const out = { ...s };
  out.checklist_template = s.checklist_template_id ? get('checklist_template', s.checklist_template_id) : null;
  out.responsible_crew = s.responsible_crew_id ? get('crew', s.responsible_crew_id) : null;
  out.task_type = resolveTaskType(s);
  out.targets = expandTargets(s);
```

with:

```js
function scheduleDetail(s) {
  const out = { ...s };
  out.checklist_template = s.checklist_template_id ? get('checklist_template', s.checklist_template_id) : null;
  out.responsible_crew = s.responsible_crew_id ? get('crew', s.responsible_crew_id) : null;
  out.task_type = resolveTaskType(s);
  const rule = recurrence.ruleFromSchedule(s);
  out.recurrence = rule;
  out.recurrence_summary = recurrence.describe(rule);
  out.occurrences_generated = s.occurrences_generated || 0;
  out.targets = expandTargets(s);
```

2. In `POST /schedules` (currently line 103), add validation right after the `task_type` check
(after line 106):

```js
  if (body.frequency === 'CUSTOM') {
    try { body.frequency_config = JSON.stringify(recurrence.parseRule(body.frequency_config)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
```

3. In `PUT /schedules/:id` (currently line 121), add the same validation after the `task_type`
check (after line 126):

```js
  if (req.body.frequency === 'CUSTOM') {
    try { req.body.frequency_config = JSON.stringify(recurrence.parseRule(req.body.frequency_config)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
```

(Applied fix: because `updateRow` does a partial spread, the shipped code validates whenever
the effective frequency — `req.body.frequency` when present, else the stored `s.frequency` — is
`CUSTOM` and either `frequency` or `frequency_config` was supplied, closing the partial-update
bypass while keeping parity with `POST`.)

4. In `GET /schedules/:id/preview` (currently line 133), replace the final response line:

```js
  res.json({ schedule: s, target_count: targets.length, targets: targets.map((x) => ({ id: x.id, name: x.name || x.tower_id || x.substation_id || x.line_id || x.asset_id, type: s.scope_type })), next_due_date: s.next_due_date });
```

with:

```js
  const rule = recurrence.ruleFromSchedule(s);
  res.json({
    schedule: s,
    target_count: targets.length,
    targets: targets.map((x) => ({ id: x.id, name: x.name || x.tower_id || x.substation_id || x.line_id || x.asset_id, type: s.scope_type })),
    next_due_date: s.next_due_date,
    next_occurrences: recurrence.preview(s.next_due_date, rule, 5),
  });
```

5. Syntax check: `node --check backend/routes/schedules.js` → exit 0.

6. Scratch API check on the running copied-DB server (start it as in Task 2 step 9 if not running):

```bash
# invalid config -> 400 with a specific message
curl -s -o /tmp/d2-bad.json -w "%{http_code}\n" -X POST localhost:3014/api/schedules -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"schedule_name":"D2 bad","schedule_code":"D2-BAD","scope_type":"TOWER","tower_id":21,"frequency":"CUSTOM","frequency_config":"{\"type\":\"WEEKLY\",\"weekdays\":[]}","next_due_date":"2026-12-01T00:00:00.000Z"}'
cat /tmp/d2-bad.json
```

Expected: `400` and `{"error":"Weekly recurrence needs at least one weekday"}`.

```bash
# valid config -> 201 with recurrence summary + rule, and preview dates
curl -s -X POST localhost:3014/api/schedules -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"schedule_name":"D2 weekly","schedule_code":"D2-WEEKLY","scope_type":"TOWER","tower_id":21,"frequency":"CUSTOM","frequency_config":"{\"type\":\"WEEKLY\",\"interval\":2,\"weekdays\":[1,4]}","priority":"LOW","next_due_date":"2026-01-05T00:00:00.000Z"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log('summary=',x.recurrence_summary,'rule=',JSON.stringify(x.recurrence))})"
WSID=$(curl -s "localhost:3014/api/schedules?q=D2 weekly" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
curl -s "localhost:3014/api/schedules/$WSID/preview" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('occurrences=',JSON.parse(s).next_occurrences.join(' | ')))"
```

Expected: `summary= Every 2 weeks on Mon, Thu`, `rule={"type":"WEEKLY","interval":2,"weekdays":[1,4]}`, and `occurrences= 2026-01-05T00:00:00.000Z | 2026-01-08T00:00:00.000Z | 2026-01-19T00:00:00.000Z | 2026-01-22T00:00:00.000Z | 2026-02-02T00:00:00.000Z`.

7. Stop the scratch server (by PID). Commit:

```bash
git add backend/routes/schedules.js
git commit -m "feat(schedules): validate recurrence config and expose summary/occurrences"
```

---

## Task 4: Frontend recurrence builder

**Files**: modify `frontend/src/pages/Schedules.jsx`

**Interfaces**:
- Consumes: `s.recurrence` (rule object) from `GET /schedules`; 400 `{ error }` from create/update.
- Produces: create/edit modal writes `frequency='CUSTOM'` + normalized `frequency_config`.

**Steps**:

1. Add builder constants and helpers after the existing constants (after line 9):

```js
const WEEKDAY_OPTS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const NTH_OPTS = [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [5, 'Fifth'], [-1, 'Last']];
const PATTERNS = [
  ['INTERVAL_DAYS', 'Every N days'],
  ['WEEKLY', 'Every N weeks on'],
  ['MONTHLY_DAY', 'Every N months on day'],
  ['MONTHLY_NTH', 'Monthly on the'],
];

function blankRule(anchorISO) {
  const d = anchorISO ? new Date(anchorISO) : new Date();
  return { type: 'MONTHLY_DAY', interval: 1, weekdays: [], day: d.getUTCDate(), nth: 1, weekday: 1, endType: 'never', until: '', count: 2 };
}

function ruleToUi(rule) {
  if (!rule || !rule.type) return blankRule();
  const ui = {
    type: rule.type,
    interval: rule.interval || 1,
    weekdays: Array.isArray(rule.weekdays) ? rule.weekdays : [],
    day: rule.day || 1,
    nth: rule.nth == null ? 1 : rule.nth,
    weekday: rule.weekday || 1,
    endType: 'never',
    until: '',
    count: 2,
  };
  if (rule.ends && rule.ends.until) { ui.endType = 'until'; ui.until = rule.ends.until; }
  else if (rule.ends && rule.ends.count) { ui.endType = 'count'; ui.count = rule.ends.count; }
  return ui;
}

function uiToRule(ui) {
  const interval = Number(ui.interval);
  if (!Number.isInteger(interval) || interval < 1) throw new Error('Interval must be an integer >= 1');
  const rule = { type: ui.type, interval };
  if (ui.type === 'WEEKLY') {
    const weekdays = [...new Set((ui.weekdays || []).map(Number))].sort((a, b) => a - b);
    if (!weekdays.length) throw new Error('Pick at least one weekday');
    rule.weekdays = weekdays;
  } else if (ui.type === 'MONTHLY_DAY') {
    const day = Number(ui.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Day of month must be 1..31');
    rule.day = day;
  } else if (ui.type === 'MONTHLY_NTH') {
    const nth = Number(ui.nth);
    if (!(nth === -1 || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) throw new Error('Ordinal must be 1..5 or Last');
    const weekday = Number(ui.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error('Weekday must be 1..7');
    rule.nth = nth;
    rule.weekday = weekday;
  }
  if (ui.endType === 'until') {
    if (!ui.until) throw new Error('Pick an end date');
    rule.ends = { until: ui.until };
  } else if (ui.endType === 'count') {
    const count = Number(ui.count);
    if (!Number.isInteger(count) || count < 1) throw new Error('Occurrence count must be an integer >= 1');
    rule.ends = { count };
  }
  return rule;
}
```

2. Add rule state next to the existing form state (after line 30):

```js
  const [rule, setRule] = useState(blankRule());
```

3. Replace `save()` (currently lines 45-53) so it serializes the builder:

```js
  async function save() {
    try {
      const body = {
        ...form,
        frequency: 'CUSTOM',
        frequency_config: JSON.stringify(uiToRule(rule)),
        next_due_date: new Date(form.next_due_date).toISOString(),
      };
      if (form.id) await api.put(`/schedules/${form.id}`, body);
      else await api.post('/schedules', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }
```

4. Initialize the rule when opening the modal. Replace the Add button's `onClick` (line 75):

```jsx
        {canWrite && <button className="btn btn-primary" onClick={() => { setForm({ ...blank }); setRule(blankRule(blank.next_due_date)); }}>+ Add Schedule</button>}
```

and the Edit button's `onClick` (line 97):

```jsx
                    {canWrite && <button className="btn btn-sm" onClick={() => { setForm({ ...s, next_due_date: s.next_due_date.slice(0, 10) }); setRule(ruleToUi(s.recurrence)); }}>Edit</button>}
```

5. Replace the Frequency field in the form modal (currently lines 182-185):

```jsx
            <div className="field"><label>Frequency</label>
              <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                {FREQ.map((f) => <option key={f}>{f}</option>)}
              </select></div>
```

with the recurrence builder:

```jsx
            <div className="field"><label>Recurrence</label>
              <select value={rule.type} onChange={(e) => setRule({ ...rule, type: e.target.value })}>
                {PATTERNS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></div>
            {rule.type !== 'MONTHLY_NTH' && (
              <div className="field"><label>{rule.type === 'INTERVAL_DAYS' ? 'Days between' : rule.type === 'WEEKLY' ? 'Weeks between' : 'Months between'}</label>
                <input type="number" min="1" value={rule.interval} onChange={(e) => setRule({ ...rule, interval: e.target.value })} /></div>
            )}
            {rule.type === 'WEEKLY' && (
              <div className="field full"><label>On weekdays</label>
                <div className="chip-row">
                  {WEEKDAY_OPTS.map(([value, label]) => (
                    <button type="button" key={value} className={`chip${rule.weekdays.includes(value) ? ' chip-on' : ''}`}
                      onClick={() => setRule({ ...rule, weekdays: rule.weekdays.includes(value) ? rule.weekdays.filter((x) => x !== value) : [...rule.weekdays, value] })}>{label}</button>
                  ))}
                </div></div>
            )}
            {rule.type === 'MONTHLY_DAY' && (
              <div className="field"><label>Day of month</label>
                <input type="number" min="1" max="31" value={rule.day} onChange={(e) => setRule({ ...rule, day: e.target.value })} /></div>
            )}
            {rule.type === 'MONTHLY_NTH' && (<>
              <div className="field"><label>Which</label>
                <select value={rule.nth} onChange={(e) => setRule({ ...rule, nth: Number(e.target.value) })}>
                  {NTH_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></div>
              <div className="field"><label>Weekday</label>
                <select value={rule.weekday} onChange={(e) => setRule({ ...rule, weekday: Number(e.target.value) })}>
                  {WEEKDAY_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></div>
            </>)}
            <div className="field full"><label>Ends</label>
              <div className="chip-row">
                {[['never', 'Never'], ['until', 'On date'], ['count', 'After N occurrences']].map(([value, label]) => (
                  <button type="button" key={value} className={`chip${rule.endType === value ? ' chip-on' : ''}`}
                    onClick={() => setRule({ ...rule, endType: value })}>{label}</button>
                ))}
              </div></div>
            {rule.endType === 'until' && (
              <div className="field"><label>End date</label>
                <input type="date" value={rule.until} onChange={(e) => setRule({ ...rule, until: e.target.value })} /></div>
            )}
            {rule.endType === 'count' && (
              <div className="field"><label>Occurrences</label>
                <input type="number" min="1" value={rule.count} onChange={(e) => setRule({ ...rule, count: e.target.value })} /></div>
            )}
```

6. Remove the now-unused `FREQ` constant (line 8) and the `frequency`/`frequency_config` keys from
`blank` (line 14) so no stale reference remains. Keep `blank.next_due_date` (used by
`blankRule`).

7. Build check:

Run: `npm run build` (in `frontend`)
Expected: exit 0 (pre-existing chunk-size warning acceptable).

8. Commit:

```bash
git add frontend/src/pages/Schedules.jsx
git commit -m "feat(schedules-ui): recurrence builder in the schedule editor"
```

---

## Task 5: Frontend display (summary, occurrence preview, styles)

**Files**:
- Modify: `frontend/src/pages/Schedules.jsx`
- Modify: `frontend/src/styles.css`

**Interfaces**:
- Consumes: `s.recurrence_summary`, `detail.recurrence_summary`, `detail.occurrences_generated`,
  `detail.next_occurrences` (Task 3).
- Produces: list summary column, detail recurrence/occurrence display, `.chip` styles.

**Steps**:

1. In the list table, replace the Frequency cell (line 89):

```jsx
                  <td>{s.frequency}</td>
```

with:

```jsx
                  <td>{s.recurrence_summary || s.frequency}</td>
```

2. In the detail modal, replace the Frequency row (line 111):

```jsx
            <span className="k">Frequency</span><span>{detail.frequency} · lead {detail.lead_time_days} days</span>
```

with:

```jsx
            <span className="k">Recurrence</span><span>{detail.recurrence_summary || detail.frequency}{detail.occurrences_generated ? ` · ${detail.occurrences_generated} generated` : ''}</span>
```

3. In the detail modal, add an upcoming-occurrences block after the targets header (after line 116):

```jsx
          {(detail.next_occurrences || []).length > 0 && (
            <>
              <div className="card-head mt"><h3 className="card-title">Upcoming occurrences</h3></div>
              <ul className="occ-list">
                {detail.next_occurrences.map((d) => <li key={d}>{fmtDate(d)}</li>)}
              </ul>
            </>
          )}
          {detail.is_active === 0 && detail.occurrences_generated > 0 && (
            <div className="muted mt" style={{ fontSize: 12 }}>This schedule has ended.</div>
          )}
```

4. Append styles to `frontend/src/styles.css`:

```css
.chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  background: #fff; border: 1px solid var(--border); border-radius: 999px;
  padding: 4px 12px; font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer;
}
.chip:hover { background: #f1f5f9; }
.chip-on { background: var(--primary); border-color: var(--primary); color: #fff; }
.occ-list { margin: 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
.occ-list li { margin: 2px 0; }
```

5. Build check: `npm run build` (in `frontend`) → exit 0.

6. Commit:

```bash
git add frontend/src/pages/Schedules.jsx frontend/src/styles.css
git commit -m "feat(schedules-ui): show recurrence summary and upcoming occurrences"
```

---

## Task 6: Final end-to-end verification (no commit)

**Files**: none (scratch scripts and curl only)

**Steps**:

1. Syntax sweep:

Run: `node --check backend/recurrence.js && node --check backend/db.js && node --check backend/scheduler.js && node --check backend/routes/schedules.js`
Expected: exit 0.

2. Re-run the pure recurrence checks: `node /tmp/recurrence-check.js` → `recurrence checks passed`.

3. Fresh scratch DB and full flow. Copy the live demo DB, start on port 3014, then:
   - create the invalid `CUSTOM` schedule → 400 with the weekday message;
   - create a valid weekly multi-day schedule with `count: 2` due in the past;
   - run generation → `occurrences_generated` becomes 1, `next_due_date` advanced to the next
     weekday occurrence, `is_active` stays 1;
   - close the generated task in the scratch DB, run again → `occurrences_generated` becomes 2 and
     `is_active` becomes 0;
   - `GET /schedules/:id/preview` → `next_occurrences` has 5 entries in the expected weekday order;
   - a legacy `MONTHLY` schedule still generates one occurrence.
   Record the exact commands and observed output.

4. Frontend build: `npm run build` (in `frontend`) → exit 0.

5. Confirm `backend/tmms.db` is unchanged (`git status --porcelain` shows no runtime DB file
   staged) and stop the scratch server by PID.

---

## Self-Review Notes

- Spec coverage: §4 data model → Task 2 step 1; §5 recurrence module → Task 1; §6 backend
  integration → Tasks 2-3; §7 frontend → Tasks 4-5; §8 errors → Task 3 validation + Task 4
  client validation; §9 verification → Task 6.
- Type consistency: `advanceAfterGeneration` returns `{ next_due_date, occurrences_generated,
  is_active }` in Task 1 and is consumed with exactly those keys in Task 2. `scheduleDetail` adds
  `recurrence` / `recurrence_summary` / `occurrences_generated` in Task 3 and `Schedules.jsx`
  reads `s.recurrence`, `s.recurrence_summary`, `detail.next_occurrences`,
  `detail.occurrences_generated` in Tasks 4-5. `parseRule` field names (`type`, `interval`,
  `weekdays`, `day`, `nth`, `weekday`, `ends.until`, `ends.count`) are identical on both sides.
- No placeholder steps remain; every backend step shows the full code and every frontend step
  shows the full JSX snippet.
