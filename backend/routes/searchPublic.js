const express = require('express');
const { list } = require('../util');
const { can, requireAuth } = require('../auth');
const { parseSearchQuery, searchGroup } = require('../searchEngine');

const router = express.Router();

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

const OPEN_PERM = {
  region: 'region:read',
  substation: 'substation:read',
  line: 'line:read',
  tower: 'tower:read',
  asset: 'asset:read',
  schedule: 'schedule:read',
};

function voltageText(v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.filter((n) => n != null && n !== '').join(' ');
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.filter((n) => n != null && n !== '').join(' ');
    } catch (_) {}
    return v;
  }
  return String(v);
}

function item(req, type, payload) {
  const canOpen = can(req, OPEN_PERM[type]);
  const out = {
    id: payload.id,
    type,
    title: payload.title,
    subtitle: payload.subtitle || '',
    description: payload.description,
    can_open: canOpen,
  };
  if (canOpen && payload.href) out.href = payload.href;
  return out;
}

router.get('/search/public', requireAuth, (req, res) => {
  const { raw, tokens } = parseSearchQuery(req.query.q);
  if (!tokens.length) return res.json({ query: '', total: 0, groups: [] });
  const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const regions = list('region');
  const substations = list('substation');
  const lines = list('transmission_line');
  const towers = list('tower');
  const assets = list('asset');
  const schedules = list('maintenance_schedule');

  const regionById = new Map(regions.map((r) => [r.id, r]));
  const subById = new Map(substations.map((s) => [s.id, s]));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const towerById = new Map(towers.map((t) => [t.id, t]));
  const regionName = (id) => regionById.get(id)?.name || '';

  function assetContext(a) {
    if (a.substation_id) {
      const s = subById.get(a.substation_id);
      return {
        place: s ? s.name : '',
        region: s ? regionName(s.region_id) : '',
        voltage: s ? voltageText(s.voltage_levels) : '',
      };
    }
    const line = a.line_id ? lineById.get(a.line_id) : (a.tower_id ? lineById.get(towerById.get(a.tower_id)?.line_id) : null);
    return {
      place: line ? line.name : '',
      region: line ? regionName(line.region_id) : '',
      voltage: line ? voltageText(line.voltage_kv) : '',
    };
  }

  const groups = [
    searchGroup({
      type: 'region', label: 'Regions', rows: regions, tokens, limit,
      titleFields: (r) => [r.name, r.code],
      extraFields: () => [],
      toItem: (r) => item(req, 'region', {
        id: r.id, title: r.name, subtitle: r.code || '',
        description: [r.code, 'Network region'].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=region&region=${r.id}`,
      }),
    }),
    searchGroup({
      type: 'substation', label: 'Substations', rows: substations, tokens, limit,
      titleFields: (s) => [s.name, s.substation_id],
      extraFields: (s) => [regionName(s.region_id)],
      toItem: (s) => item(req, 'substation', {
        id: s.id, title: s.name,
        subtitle: [s.substation_id, regionName(s.region_id)].filter(Boolean).join(' · '),
        description: ['Substation', s.substation_id, regionName(s.region_id)].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=substation&substation=${s.id}`,
      }),
    }),
    searchGroup({
      type: 'line', label: 'Transmission lines', rows: lines, tokens, limit,
      titleFields: (l) => [l.name, l.line_id],
      extraFields: (l) => [l.voltage_kv, regionName(l.region_id)],
      toItem: (l) => item(req, 'line', {
        id: l.id, title: l.name,
        subtitle: [l.line_id, l.voltage_kv != null ? `${l.voltage_kv} kV` : null, regionName(l.region_id)].filter(Boolean).join(' · '),
        description: ['Transmission line', l.voltage_kv != null ? `${l.voltage_kv} kV` : null, regionName(l.region_id)].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=line&line=${l.id}`,
      }),
    }),
    searchGroup({
      type: 'tower', label: 'Towers', rows: towers, tokens, limit,
      titleFields: (t) => [t.tower_id, t.tower_number],
      extraFields: (t) => [t.tower_type],
      toItem: (t) => item(req, 'tower', {
        id: t.id, title: t.tower_id || t.tower_number || `Tower ${t.id}`,
        subtitle: t.tower_type || '',
        description: ['Tower', t.tower_type, t.tower_number != null ? `No. ${t.tower_number}` : null].filter(Boolean).join(' · '),
        href: t.line_id != null
          ? `/infrastructure?tab=line&line=${t.line_id}&manage=towers`
          : '/infrastructure?manage=towers',
      }),
    }),
    searchGroup({
      type: 'asset', label: 'Assets', rows: assets, tokens, limit,
      titleFields: (a) => [a.name, a.asset_id],
      extraFields: (a) => {
        const ctx = assetContext(a);
        return [a.asset_type, a.sub_type, ctx.place, ctx.voltage, ctx.region];
      },
      toItem: (a) => {
        const ctx = assetContext(a);
        return item(req, 'asset', {
          id: a.id, title: a.name || a.asset_id,
          subtitle: [a.asset_id, a.asset_type].filter(Boolean).join(' · '),
          description: ['Asset', a.asset_type, ctx.place, ctx.region].filter(Boolean).join(' · '),
          href: `/assets?asset=${a.id}`,
        });
      },
    }),
    searchGroup({
      type: 'schedule', label: 'Schedules', rows: schedules, tokens, limit,
      titleFields: (s) => [s.schedule_name, s.schedule_code],
      extraFields: (s) => [s.frequency],
      toItem: (s) => item(req, 'schedule', {
        id: s.id, title: s.schedule_name,
        subtitle: [s.schedule_code, s.frequency].filter(Boolean).join(' · '),
        description: ['Maintenance schedule', s.frequency, s.schedule_code].filter(Boolean).join(' · '),
        href: '/schedules',
      }),
    }),
  ].filter((g) => g.total > 0);

  const total = groups.reduce((n, g) => n + g.total, 0);
  res.json({ query: raw, total, groups });
});

module.exports = router;
