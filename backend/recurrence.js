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
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) throw new Error('Recurrence interval must be an integer 1..1000');
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
  if (!next || Number.isNaN(next.getTime())) return null;
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
  const out = (countReached || !next)
    ? { next_due_date: s.next_due_date, occurrences_generated, is_active: 0 }
    : { next_due_date: next, occurrences_generated, is_active: 1 };
  if (s.frequency !== 'CUSTOM' && rule.type === 'MONTHLY_DAY' && rule.day > 28) {
    out.frequency = 'CUSTOM';
    out.frequency_config = JSON.stringify(rule);
  }
  return out;
}

module.exports = {
  parseRule,
  ruleFromSchedule,
  nextAfter,
  preview,
  describe,
  advanceAfterGeneration,
};
