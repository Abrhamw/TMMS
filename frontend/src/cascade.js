// Parent/child filtering for the infrastructure dropdowns. A network is layered
// Region -> Substation/Line -> Tower/Asset, so once a parent box is chosen every
// child list should shrink to what actually belongs to that parent. These
// helpers are deliberately pure and tolerant of missing fields, because the
// different list endpoints carry different projections (an asset brief has
// substation_id/line_id but no region_id, for example).

const same = (a, b) => a != null && b != null && String(a) === String(b);

export function subsInRegion(subs, regionId) {
  if (!regionId) return subs || [];
  return (subs || []).filter((s) => same(s.region_id, regionId));
}

export function linesInRegion(lines, regionId) {
  if (!regionId) return lines || [];
  return (lines || []).filter((l) => same(l.region_id, regionId));
}

// Lines are attached to a substation at either end, so a substation narrows the
// line list to the circuits that terminate there.
export function linesForSubstation(lines, substationId) {
  if (!substationId) return lines || [];
  return (lines || []).filter(
    (l) => same(l.from_substation_id, substationId) || same(l.to_substation_id, substationId)
  );
}

export function towersForLine(towers, lineId) {
  if (!lineId) return towers || [];
  return (towers || []).filter((t) => same(t.line_id, lineId));
}

// Assets can hang off a substation, a line or a tower. The most specific parent
// wins: substation, then line, then the region they resolve to.
export function assetsInScope(assets, { regionId, substationId, lineId } = {}, { subs = [], lines = [] } = {}) {
  const list = assets || [];
  if (substationId) return list.filter((a) => same(a.substation_id, substationId));
  if (lineId) return list.filter((a) => same(a.line_id, lineId));
  if (regionId) {
    const subIds = new Set(subsInRegion(subs, regionId).map((s) => String(s.id)));
    const lineIds = new Set(linesInRegion(lines, regionId).map((l) => String(l.id)));
    return list.filter(
      (a) =>
        (a.substation_id != null && subIds.has(String(a.substation_id))) ||
        (a.line_id != null && lineIds.has(String(a.line_id)))
    );
  }
  return list;
}
