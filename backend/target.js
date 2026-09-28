const { get } = require('./util');

// Human-readable name for the infrastructure a task targets: the substation,
// else the transmission line, else the tower. Used to build descriptive
// document titles.
function infraName(target) {
  if (!target) return null;
  return (target.substation && (target.substation.name || target.substation.substation_id))
    || (target.line && (target.line.name || target.line.line_id))
    || (target.tower && target.tower.tower_id)
    || null;
}

// Human-readable name for the asset a task targets.
function assetName(target) {
  if (!target || !target.asset) return null;
  return target.asset.name || target.asset.asset_id || null;
}

// Resolve what a task (and therefore a field checklist execution) was carried
// out on. A task may target an asset and/or infrastructure — a substation, a
// line, a tower — and an asset inherits its location from the asset record when
// the task itself does not name one, so a printed execution always says where
// the work actually happened.
function resolveTarget({ task, asset } = {}) {
  const a = asset || (task && task.asset_id ? get('asset', task.asset_id) : null);
  const substation = (task && task.substation_id ? get('substation', task.substation_id, ['boundary_json']) : null)
    || (a && a.substation_id ? get('substation', a.substation_id, ['boundary_json']) : null);
  const line = (task && task.line_id ? get('transmission_line', task.line_id, ['route_json']) : null)
    || (a && a.line_id ? get('transmission_line', a.line_id, ['route_json']) : null);
  const tower = (task && task.tower_id ? get('tower', task.tower_id) : null)
    || (a && a.tower_id ? get('tower', a.tower_id) : null);
  const region = task && task.region_id ? get('region', task.region_id) : null;
  // A line's terminals are what make "start → end" legible on a printed map.
  if (line) {
    line.from_substation = line.from_substation_id ? get('substation', line.from_substation_id) : null;
    line.to_substation = line.to_substation_id ? get('substation', line.to_substation_id) : null;
  }
  return {
    asset: a || null,
    substation: substation || null,
    line: line || null,
    tower: tower || null,
    region: region || null,
  };
}

// A descriptive, standard title for an executed checklist or a task report:
// task type, task title (when known), the infrastructure and the asset.
function targetHeadline({ taskType, taskTitle, target } = {}) {
  const infra = infraName(target);
  const asset = assetName(target);
  const bits = [];
  const type = taskType ? String(taskType).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  if (type) bits.push(type);
  if (taskTitle && taskTitle !== infra && taskTitle !== asset) bits.push(taskTitle);
  if (infra && !bits.some((b) => b.includes(infra))) bits.push(infra);
  if (asset && !bits.some((b) => b.includes(asset))) bits.push(asset);
  return bits.join(' — ');
}

module.exports = { resolveTarget, infraName, assetName, targetHeadline };
