'use strict';

const { db } = require('./db');

const TIME_KINDS = new Set(['NORMAL', 'OVERTIME', 'STANDBY', 'TRAVEL', 'CALL_OUT']);
const MINUTES_PER_HOUR = 60;

function minutesBetween(startedAt, endedAt) {
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return (b - a) / 60000;
}

// Productive hours for an entry: an explicit `hours` wins, otherwise the
// start/end span is used. Breaks are deducted; travel and standby are tracked
// separately for productivity analysis rather than netted out here.
function computeHours(entry = {}) {
  let gross;
  if (entry.hours !== undefined && entry.hours !== null && entry.hours !== '') {
    gross = Number(entry.hours);
  } else {
    const span = minutesBetween(entry.started_at, entry.ended_at);
    gross = span == null ? 0 : span / MINUTES_PER_HOUR;
  }
  if (!Number.isFinite(gross) || gross < 0) gross = 0;
  const brk = Number(entry.break_minutes) || 0;
  return Math.max(0, Math.round((gross - brk / MINUTES_PER_HOUR) * 100) / 100);
}

// The rate in force for a person at an instant: the most recent person-specific
// rate not effective in the future, else the most recent global default
// (person_id IS NULL). Rates are append-only so history is never rewritten.
function resolveRate(personId, at) {
  const when = at || new Date().toISOString();
  if (personId != null) {
    const person = db.prepare(
      'SELECT * FROM labor_rate WHERE person_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1'
    ).get(Number(personId), when);
    if (person) return person;
  }
  return db.prepare(
    'SELECT * FROM labor_rate WHERE person_id IS NULL AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1'
  ).get(when) || null;
}

function costFor(hours, rate) {
  if (!rate || rate.hourly_rate == null) return null;
  const n = Math.round(Number(hours) * Number(rate.hourly_rate) * 100) / 100;
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Roll up a task's labor, counting only the statuses requested (approved actuals
// by default, with pending available for a commitment view).
function taskLaborSummary(taskId, opts = {}) {
  const include = new Set(opts.include || ['APPROVED']);
  const rows = db.prepare('SELECT * FROM time_entry WHERE task_id = ? ORDER BY work_date, id').all(taskId);
  const counted = rows.filter((r) => include.has(r.status));
  const byPerson = new Map();
  let hours = 0;
  let laborCost = 0;
  for (const r of counted) {
    hours += Number(r.hours) || 0;
    laborCost += Number(r.labor_cost) || 0;
    const cur = byPerson.get(r.person_id) || { person_id: r.person_id, hours: 0, labor_cost: 0, entries: 0 };
    cur.hours += Number(r.hours) || 0;
    cur.labor_cost += Number(r.labor_cost) || 0;
    cur.entries += 1;
    byPerson.set(r.person_id, cur);
  }
  const byKind = {};
  for (const r of counted) byKind[r.kind] = round2((byKind[r.kind] || 0) + (Number(r.hours) || 0));
  return {
    task_id: Number(taskId),
    entries: rows.length,
    counted_entries: counted.length,
    hours: round2(hours),
    labor_cost: round2(laborCost),
    by_kind: byKind,
    by_person: [...byPerson.values()].map((x) => ({ ...x, hours: round2(x.hours), labor_cost: round2(x.labor_cost) })),
  };
}

module.exports = { TIME_KINDS, minutesBetween, computeHours, resolveRate, costFor, taskLaborSummary };
