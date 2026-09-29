const express = require('express');
const { list } = require('../util');
const { can } = require('../auth');
const { commandScope, taskVisible, readCrewIds } = require('../authority');

const router = express.Router();

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const MAX_QUERY = 80;

function text(v) {
  return v == null ? '' : String(v);
}

function contains(q, ...fields) {
  return fields.some((f) => text(f).toLowerCase().includes(q));
}

// Global search across the operational entities the caller can see. Each group
// is gated by the matching read permission and filtered through the same
// command scope used by the entity list routes, so results never leak rows
// outside the user's command / region.
router.get('/search', (req, res) => {
  const raw = text(req.query.q).trim();
  if (!raw) return res.json({ query: '', total: 0, groups: [] });
  const q = raw.slice(0, MAX_QUERY).toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const scope = commandScope(req.user);
  const groups = [];

  const regionById = new Map(list('region').map((r) => [r.id, r]));
  const regionName = (id) => regionById.get(id)?.name || null;
  const push = (type, label, items) => {
    if (items.length) groups.push({ type, label, total: items.length, items: items.slice(0, limit) });
  };

  if (can(req, 'task:read')) {
    const items = list('task')
      .filter((t) => taskVisible(req.user, t) && contains(q, t.title, t.task_number))
      .map((t) => ({
        id: t.id,
        type: 'task',
        title: t.title || t.task_number,
        subtitle: [t.task_number, t.status, regionName(t.region_id)].filter(Boolean).join(' · '),
        badge: t.status,
        href: `/tasks/${t.id}`,
      }));
    push('task', 'Tasks', items);
  }

  if (can(req, 'asset:read')) {
    const inScope = (a) => scope.global || scope.assetIds.has(a.id);
    const items = list('asset')
      .filter((a) => inScope(a) && contains(q, a.name, a.asset_id, a.serial_number, a.manufacturer, a.model, a.asset_type, a.sub_type))
      .map((a) => ({
        id: a.id,
        type: 'asset',
        title: a.name || a.asset_id,
        subtitle: [a.asset_id, a.asset_type, a.condition_rating != null ? `cond ${a.condition_rating}/10` : null].filter(Boolean).join(' · '),
        document_type: 'ASSET_DETAIL',
      }));
    push('asset', 'Assets', items);
  }

  if (can(req, 'crew:read')) {
    const ids = readCrewIds(req.user);
    const items = list('crew')
      .filter((c) => ids.has(c.id) && contains(q, c.name, c.crew_code, c.crew_type))
      .map((c) => ({
        id: c.id,
        type: 'crew',
        title: c.name,
        subtitle: [c.crew_code, c.crew_type, regionName(c.region_id)].filter(Boolean).join(' · '),
        document_type: 'CREW_DETAIL',
      }));
    push('crew', 'Crews', items);
  }

  if (can(req, 'people:read')) {
    const inScope = (p) => scope.global || scope.memberIds.has(p.id);
    const items = list('person')
      .filter((p) => inScope(p) && contains(q, p.first_name, p.last_name, `${text(p.first_name)} ${text(p.last_name)}`, p.title, p.email))
      .map((p) => ({
        id: p.id,
        type: 'person',
        title: [p.first_name, p.last_name].filter(Boolean).join(' ') || `Person ${p.id}`,
        subtitle: [p.title, p.email].filter(Boolean).join(' · '),
        href: `/certifications?person=${p.id}`,
      }));
    push('person', 'People', items);
  }

  if (can(req, 'substation:read')) {
    const inScope = (s) => scope.global || scope.substationIds.has(s.id);
    const items = list('substation')
      .filter((s) => inScope(s) && contains(q, s.name, s.substation_id))
      .map((s) => ({
        id: s.id,
        type: 'substation',
        title: s.name,
        subtitle: [s.substation_id, regionName(s.region_id)].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=substation&substation=${s.id}`,
      }));
    push('substation', 'Substations', items);
  }

  if (can(req, 'line:read')) {
    const inScope = (l) => scope.global || scope.lineIds.has(l.id);
    const items = list('transmission_line')
      .filter((l) => inScope(l) && contains(q, l.name, l.line_id))
      .map((l) => ({
        id: l.id,
        type: 'line',
        title: l.name,
        subtitle: [l.line_id, l.voltage_kv != null ? `${l.voltage_kv} kV` : null, regionName(l.region_id)].filter(Boolean).join(' · '),
        document_type: 'LINE_DETAIL',
      }));
    push('line', 'Transmission lines', items);
  }

  if (can(req, 'tower:read')) {
    const inScope = (t) => scope.global || scope.towerIds.has(t.id);
    const items = list('tower')
      .filter((t) => inScope(t) && contains(q, t.tower_id, t.tower_number, t.tower_type))
      .map((t) => ({
        id: t.id,
        type: 'tower',
        title: t.tower_id || t.tower_number || `Tower ${t.id}`,
        subtitle: [t.tower_type, t.km_marker != null ? `km ${t.km_marker}` : null].filter(Boolean).join(' · '),
        href: t.line_id != null ? `/infrastructure?tab=line&line=${t.line_id}&manage=towers` : '/infrastructure?manage=towers',
      }));
    push('tower', 'Towers', items);
  }

  if (can(req, 'region:read')) {
    const inScope = (r) => scope.global || scope.regionIds.has(r.id);
    const items = list('region')
      .filter((r) => inScope(r) && contains(q, r.name, r.code))
      .map((r) => ({
        id: r.id,
        type: 'region',
        title: r.name,
        subtitle: r.code,
        href: `/infrastructure?tab=region&region=${r.id}`,
      }));
    push('region', 'Regions', items);
  }

  if (can(req, 'schedule:read')) {
    const inScope = (s) => scope.global || scope.scheduleIds.has(s.id);
    const items = list('maintenance_schedule')
      .filter((s) => inScope(s) && contains(q, s.schedule_name, s.schedule_code))
      .map((s) => ({
        id: s.id,
        type: 'schedule',
        title: s.schedule_name,
        subtitle: [s.schedule_code, s.frequency, regionName(s.region_id)].filter(Boolean).join(' · '),
        href: '/schedules',
      }));
    push('schedule', 'Schedules', items);
  }

  const total = groups.reduce((n, g) => n + g.total, 0);
  res.json({ query: raw, total, groups });
});

module.exports = router;
