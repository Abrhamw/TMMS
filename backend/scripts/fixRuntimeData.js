#!/usr/bin/env node
// Idempotent runtime data corrections for TMMS.
//
// The live SQLite database is git-ignored and regenerated from seeds, so any
// correction applied directly to it is lost on a reset. This script re-applies
// the small set of known data corrections the application depends on. It only
// writes when a correction is actually needed, so it is safe to run on every
// boot and on an already-correct (or freshly regenerated) database.
//
// Usage
//   node scripts/fixRuntimeData.js            # dry run, prints what it would do
//   node scripts/fixRuntimeData.js --apply    # write the corrections
//   APPLY=1 node scripts/fixRuntimeData.js    # same as --apply
//
// Corrections
//   1. SS-C1-001 "Sululta 400kV" device point: pin it to the mean of its yard
//      boundary vertices when it still sits somewhere else. The boundary itself
//      is never modified.
//   2. Transmission-line endpoints: repair only under strict guards (the
//      current endpoint is clearly misplaced, the route end genuinely lands on
//      a different substation, and the line name references that substation).
//      Anything that disagrees with its own name, or whose route reaches no
//      substation, is reported for manual review and never rewritten.
//
// Everything else is reported, not changed.

const { db, updateRow } = require('../util');
const { haversine } = require('../geo');

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';

// geo.haversine returns metres; the guards below are expressed in kilometres.
const havKm = (aLat, aLng, bLat, bLng) => haversine(aLat, aLng, bLat, bLng) / 1000;

// A boundary may be stored as a JSON string, an array, or [{lat,lng}] entries.
function parseBoundary(value) {
  if (!value) return [];
  let v = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (_) { return []; }
  }
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const p of v) {
    if (Array.isArray(p) && p.length >= 2) out.push([Number(p[0]), Number(p[1])]);
    else if (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))) out.push([Number(p.lat), Number(p.lng)]);
  }
  return out;
}

// Mean of the ring vertices. Matches the coordinate the live fix used, so the
// script is a no-op once the correction is in place.
function ringMean(ring) {
  const lat = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lng = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return { lat, lng };
}

const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
function nameMatches(lineName, subName) {
  const a = tokens(lineName);
  const b = tokens(subName);
  return a.some((t) => b.some((u) => u.includes(t) || t.includes(u)));
}

function fixSulultaPoint() {
  const s = db.prepare("SELECT id, name, latitude, longitude, boundary_json FROM substation WHERE substation_id = 'SS-C1-001'").get();
  if (!s) return { status: 'skipped', reason: 'SS-C1-001 not found' };
  const ring = parseBoundary(s.boundary_json);
  if (ring.length < 3) return { status: 'skipped', reason: 'no usable boundary' };
  const c = ringMean(ring);
  const movedM = (Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude)))
    ? Math.round(havKm(Number(s.latitude), Number(s.longitude), c.lat, c.lng) * 1000)
    : null;
  if (movedM !== null && movedM < 5) return { status: 'ok' };
  if (APPLY) updateRow('substation', s.id, { latitude: c.lat, longitude: c.lng });
  return {
    status: APPLY ? 'applied' : 'would-apply',
    from: [s.latitude, s.longitude],
    to: [Number(c.lat.toFixed(6)), Number(c.lng.toFixed(6))],
    moved_m: movedM,
  };
}

// Guarded line-endpoint repair. An endpoint changes only when ALL hold:
//   - the current endpoint substation is > 2 km from that route end,
//   - the nearest substation is < 1 km from that route end (a real match),
//   - the line name references the new substation and not the current one, and
//   - the change does not collapse from == to.
// Routes stored end-to-end reversed (same pair, correct links) are left alone.
function repairLineEndpoints() {
  const subs = db.prepare('SELECT id, name, latitude, longitude FROM substation').all();
  const byId = new Map(subs.map((s) => [s.id, s]));
  const points = subs.filter((s) => Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude)));
  const nearest = (lat, lng) => {
    let best = null;
    for (const s of points) {
      const d = havKm(lat, lng, Number(s.latitude), Number(s.longitude));
      if (!best || d < best.d) best = { d, s };
    }
    return best;
  };
  const distTo = (id, lat, lng) => (byId.has(id) ? havKm(lat, lng, Number(byId.get(id).latitude), Number(byId.get(id).longitude)) : Infinity);

  const lines = db.prepare('SELECT id, line_id, name, from_substation_id, to_substation_id, route_json FROM transmission_line').all();
  const applied = [];
  const skipped = [];
  const flagged = [];

  for (const l of lines) {
    const route = parseBoundary(l.route_json);
    if (route.length < 2) continue;
    const [fLat, fLng] = route[0];
    const [lLat, lLng] = route[route.length - 1];
    const nf = nearest(fLat, fLng);
    const nt = nearest(lLat, lLng);
    if (!nf || !nt) continue;
    const curF = l.from_substation_id;
    const curT = l.to_substation_id;
    // Reversed storage: links already describe the right pair.
    if (curF && curT && curF !== curT && nf.s.id === curT && nt.s.id === curF) continue;

    const dF = distTo(curF, fLat, fLng);
    const dT = distTo(curT, lLat, lLng);
    let newF = curF;
    let newT = curT;
    let skipF = null;
    let skipT = null;

    if (!(curF && dF <= 1) && nf.d <= 1) {
      if (dF > 2 && nameMatches(l.name, nf.s.name) && !nameMatches(l.name, (byId.get(curF) || {}).name)) newF = nf.s.id;
      else if (dF > 2) skipF = nf.s.name;
    }
    if (!(curT && dT <= 1) && nt.d <= 1) {
      if (dT > 2 && nameMatches(l.name, nt.s.name) && !nameMatches(l.name, (byId.get(curT) || {}).name)) newT = nt.s.id;
      else if (dT > 2) skipT = nt.s.name;
    }
    if (newF === newT && newF != null) { newF = curF; newT = curT; }

    if (newF !== curF || newT !== curT) {
      applied.push(`${l.line_id} ${l.name}: from ${(byId.get(curF) || {}).name} -> ${(byId.get(newF) || {}).name}; to ${(byId.get(curT) || {}).name} -> ${(byId.get(newT) || {}).name}`);
      if (APPLY) updateRow('transmission_line', l.id, { from_substation_id: newF, to_substation_id: newT });
    } else if (skipF) {
      skipped.push(`${l.line_id} ${l.name}: 'from' route end is ${nf.d.toFixed(2)} km from "${skipF}" but the name does not match`);
    } else if (skipT) {
      skipped.push(`${l.line_id} ${l.name}: 'to' route end is ${nt.d.toFixed(2)} km from "${skipT}" but the name does not match`);
    } else if (nf.d > 1 && nt.d > 1) {
      flagged.push(`${l.line_id} ${l.name}: route ends ${nf.d.toFixed(0)}/${nt.d.toFixed(0)} km from any substation`);
    }
  }
  return { applied, skipped, flagged };
}

function main() {
  console.log(`fixRuntimeData — ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const sululta = fixSulultaPoint();
  console.log('\n[1] SS-C1-001 Sululta 400kV device point');
  console.log('   ', JSON.stringify(sululta));

  const lines = repairLineEndpoints();
  console.log(`\n[2] Line endpoint repair — ${APPLY ? 'applied' : 'would apply'} (${lines.applied.length})`);
  lines.applied.forEach((x) => console.log('   ', x));
  console.log(`    skipped — route disagrees with name (${lines.skipped.length})`);
  lines.skipped.forEach((x) => console.log('   ', x));
  console.log(`    manual review — route reaches no substation (${lines.flagged.length})`);
  lines.flagged.forEach((x) => console.log('   ', x));

  if (!APPLY) console.log('\nRe-run with --apply to write these changes.');
}

main();
