const express = require('express');
const { list } = require('../util');
const { can, userCrewIds } = require('../auth');
const { commandScope, taskVisible, readCrewIds } = require('../authority');
const { parseSearchQuery, searchGroup, hasSearchIntent, shouldSearchType, rowMatchesMine } = require('../searchEngine');

const router = express.Router();

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

function personalActor(user) {
  return { personId: user && user.person_id != null ? user.person_id : null, crewIds: userCrewIds(user) };
}

function mineFilter(type, rows, intent, user) {
  if (!intent || !intent.mine) return rows;
  const actor = personalActor(user);
  return rows.filter((row) => rowMatchesMine(type, row, actor));
}

router.get('/search', (req, res) => {
  const { raw, tokens, intent } = parseSearchQuery(req.query.q);
  if (!tokens.length && !hasSearchIntent(intent)) return res.json({ query: '', total: 0, groups: [] });
  const limit = Math.min(Math.max(Number(req.query.limit) || (intent.mine ? MAX_LIMIT : DEFAULT_LIMIT), 1), MAX_LIMIT);
  const scope = commandScope(req.user);
  const groups = [];

  const regionById = new Map(list('region').map((r) => [r.id, r]));
  const lineById = new Map(list('transmission_line').map((l) => [l.id, l]));
  const regionName = (id) => regionById.get(id)?.name || null;
  const lineRegionName = (lineId) => regionName(lineById.get(lineId)?.region_id);
  const push = (group) => { if (group.total) groups.push(group); };

  if (can(req, 'task:read') && shouldSearchType('task', intent, tokens)) {
    push(searchGroup({
      type: 'task', label: 'Tasks',
      rows: mineFilter('task', list('task').filter((t) => taskVisible(req.user, t)), intent, req.user),
      tokens, limit, intent,
      titleFields: (t) => [t.title, t.task_number],
      extraFields: (t) => [t.status, t.task_type, t.priority, regionName(t.region_id)],
      toItem: (t) => ({
        id: t.id, type: 'task', title: t.title || t.task_number,
        subtitle: [t.task_number, t.status, regionName(t.region_id)].filter(Boolean).join(' · '),
        badge: t.status,
        href: `/tasks/${t.id}`,
      }),
    }));
  }

  if (can(req, 'asset:read') && shouldSearchType('asset', intent, tokens)) {
    const inScope = (a) => scope.global || scope.assetIds.has(a.id);
    push(searchGroup({
      type: 'asset', label: 'Assets',
      rows: list('asset').filter(inScope),
      tokens, limit, intent,
      titleFields: (a) => [a.name, a.asset_id],
      extraFields: (a) => [a.serial_number, a.manufacturer, a.model, a.asset_type, a.sub_type],
      toItem: (a) => ({
        id: a.id, type: 'asset', title: a.name || a.asset_id,
        subtitle: [a.asset_id, a.asset_type, a.condition_rating != null ? `cond ${a.condition_rating}/10` : null].filter(Boolean).join(' · '),
        document_type: 'ASSET_DETAIL',
      }),
    }));
  }

  if (can(req, 'crew:read') && shouldSearchType('crew', intent, tokens)) {
    const ids = readCrewIds(req.user);
    push(searchGroup({
      type: 'crew', label: 'Crews',
      rows: mineFilter('crew', list('crew').filter((c) => ids.has(c.id)), intent, req.user),
      tokens, limit, intent,
      titleFields: (c) => [c.name, c.crew_code],
      extraFields: (c) => [c.crew_type],
      toItem: (c) => ({
        id: c.id, type: 'crew', title: c.name,
        subtitle: [c.crew_code, c.crew_type, regionName(c.region_id)].filter(Boolean).join(' · '),
        document_type: 'CREW_DETAIL',
      }),
    }));
  }

  if (can(req, 'people:read') && shouldSearchType('person', intent, tokens)) {
    const inScope = (p) => scope.global || scope.memberIds.has(p.id);
    push(searchGroup({
      type: 'person', label: 'People',
      rows: mineFilter('person', list('person').filter(inScope), intent, req.user),
      tokens, limit, intent,
      titleFields: (p) => [p.first_name, p.last_name, `${p.first_name || ''} ${p.last_name || ''}`],
      extraFields: (p) => [p.title, p.email],
      toItem: (p) => ({
        id: p.id, type: 'person',
        title: [p.first_name, p.last_name].filter(Boolean).join(' ') || `Person ${p.id}`,
        subtitle: [p.title, p.email].filter(Boolean).join(' · '),
        href: `/certifications?person=${p.id}`,
      }),
    }));
  }

  if (can(req, 'substation:read') && shouldSearchType('substation', intent, tokens)) {
    const inScope = (s) => scope.global || scope.substationIds.has(s.id);
    push(searchGroup({
      type: 'substation', label: 'Substations',
      rows: list('substation').filter(inScope),
      tokens, limit, intent,
      titleFields: (s) => [s.name, s.substation_id],
      extraFields: (s) => [regionName(s.region_id)],
      toItem: (s) => ({
        id: s.id, type: 'substation', title: s.name,
        subtitle: [s.substation_id, regionName(s.region_id)].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=substation&substation=${s.id}`,
      }),
    }));
  }

  if (can(req, 'line:read') && shouldSearchType('line', intent, tokens)) {
    const inScope = (l) => scope.global || scope.lineIds.has(l.id);
    push(searchGroup({
      type: 'line', label: 'Transmission lines',
      rows: list('transmission_line').filter(inScope),
      tokens, limit, intent,
      titleFields: (l) => [l.name, l.line_id],
      extraFields: (l) => [l.voltage_kv, regionName(l.region_id)],
      toItem: (l) => ({
        id: l.id, type: 'line', title: l.name,
        subtitle: [l.line_id, l.voltage_kv != null ? `${l.voltage_kv} kV` : null, regionName(l.region_id)].filter(Boolean).join(' · '),
        document_type: 'LINE_DETAIL',
      }),
    }));
  }

  if (can(req, 'tower:read') && shouldSearchType('tower', intent, tokens)) {
    const inScope = (t) => scope.global || scope.towerIds.has(t.id);
    push(searchGroup({
      type: 'tower', label: 'Towers',
      rows: list('tower').filter(inScope),
      tokens, limit, intent,
      titleFields: (t) => [t.tower_id, t.tower_number],
      extraFields: (t) => [t.tower_type, t.km_marker, lineById.get(t.line_id)?.name, lineRegionName(t.line_id)],
      toItem: (t) => ({
        id: t.id, type: 'tower', title: t.tower_id || t.tower_number || `Tower ${t.id}`,
        subtitle: [t.tower_type, t.km_marker != null ? `km ${t.km_marker}` : null].filter(Boolean).join(' · '),
        href: t.line_id != null ? `/infrastructure?tab=line&line=${t.line_id}&manage=towers` : '/infrastructure?manage=towers',
      }),
    }));
  }

  if (can(req, 'region:read') && shouldSearchType('region', intent, tokens)) {
    const inScope = (r) => scope.global || scope.regionIds.has(r.id);
    push(searchGroup({
      type: 'region', label: 'Regions',
      rows: list('region').filter(inScope),
      tokens, limit, intent,
      titleFields: (r) => [r.name, r.code],
      extraFields: () => [],
      toItem: (r) => ({
        id: r.id, type: 'region', title: r.name, subtitle: r.code,
        href: `/infrastructure?tab=region&region=${r.id}`,
      }),
    }));
  }

  if (can(req, 'schedule:read') && shouldSearchType('schedule', intent, tokens)) {
    const inScope = (s) => scope.global || scope.scheduleIds.has(s.id);
    push(searchGroup({
      type: 'schedule', label: 'Schedules',
      rows: mineFilter('schedule', list('maintenance_schedule').filter(inScope), intent, req.user),
      tokens, limit, intent,
      titleFields: (s) => [s.schedule_name, s.schedule_code],
      extraFields: (s) => [s.frequency, regionName(s.region_id)],
      toItem: (s) => ({
        id: s.id, type: 'schedule', title: s.schedule_name,
        subtitle: [s.schedule_code, s.frequency, regionName(s.region_id)].filter(Boolean).join(' · '),
        href: '/schedules',
      }),
    }));
  }

  const total = groups.reduce((n, g) => n + g.total, 0);
  res.json({ query: raw, total, groups });
});

module.exports = router;
