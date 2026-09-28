import { taskTypeLabel } from './labels.js';

// Turn a raw checklist response into the wording a reader actually needs.
// The stored values are technical (true / false / a bare number / a JSON GPS
// blob); every printable checklist and report should describe what the crew
// observed instead ("Pass", "Yes", "118 kV", coordinates), so the mapping lives
// here and is shared by the live run surfaces and the printed dossiers.

function parseStored(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

function isTruthy(v) {
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'pass' || s === 'ok' || s === '1';
}

function numericUnit(item) {
  const pc = parseStored(item && item.pass_criteria);
  return pc && typeof pc === 'object' && pc.unit ? pc.unit : null;
}

// Human wording for the value the crew recorded. Falls back to the recorded
// result when nothing was entered, so a printed step never reads as a blank.
export function formatChecklistResponse(item) {
  if (!item) return '—';
  const raw = parseStored(item.response_value);
  if (raw === null || raw === undefined) {
    if (item.result === 'NOT_RUN') return 'Not run';
    if (item.result === 'NA') return 'Not applicable';
    return 'Not recorded';
  }
  switch (item.response_type) {
    case 'PASS_FAIL':
      return isTruthy(raw) ? 'Pass' : 'Fail';
    case 'YES_NO':
      return isTruthy(raw) ? 'Yes' : 'No';
    case 'NUMERIC': {
      const unit = numericUnit(item);
      return unit ? `${raw} ${unit}` : String(raw);
    }
    case 'SELECT':
      return String(raw);
    case 'PHOTO':
      return 'Photo attached';
    case 'GPS_POINT': {
      let o = raw;
      if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch (_) { o = raw; } }
      if (o && typeof o === 'object' && o.lat !== undefined && o.lng !== undefined) {
        const acc = o.accuracy_m != null ? ` · ±${Math.round(o.accuracy_m)} m` : '';
        return `${Number(o.lat).toFixed(6)}, ${Number(o.lng).toFixed(6)}${acc}`;
      }
      return String(raw);
    }
    default:
      return String(raw);
  }
}

const RESULT_WORDS = {
  PASS: 'Passed',
  FAIL: 'Failed',
  NOT_RUN: 'Not run',
  NA: 'Not applicable',
  INCOMPLETE: 'Incomplete',
  UNGRADED: 'Not graded',
};

// Spelled-out result for prose and print, where a coloured pill is not wanted.
export function formatChecklistResult(result) {
  if (!result) return '—';
  return RESULT_WORDS[result] || String(result);
}

// Readable description of where a checklist was carried out: the asset worked
// on plus the infrastructure (substation / line / tower) named on the task, so
// a printed execution states both the equipment and its location.
export function describeTarget(target) {
  const a = target && target.asset;
  const asset = a
    ? [a.asset_id, a.name].filter(Boolean).join(' · ') + (a.asset_type ? ` (${a.asset_type})` : '')
    : null;
  const infra = [];
  if (target && target.substation) {
    infra.push(`Substation ${target.substation.name}${target.substation.substation_id ? ` (${target.substation.substation_id})` : ''}`);
  }
  if (target && target.line) {
    infra.push(`Line ${target.line.name}${target.line.line_id ? ` (${target.line.line_id})` : ''}`);
  }
  if (target && target.tower) infra.push(`Tower ${target.tower.tower_id}`);
  return {
    asset: asset || null,
    infrastructure: infra.length ? infra.join(' · ') : null,
    region: target && target.region ? target.region.name : null,
  };
}

// The infrastructure an execution targeted: substation, else line (with its
// voltage), else tower.
export function targetInfraLabel(target) {
  if (!target) return null;
  if (target.substation) return target.substation.name || target.substation.substation_id || null;
  if (target.line) {
    const kv = target.line.voltage_kv ? ` ${target.line.voltage_kv} kV` : '';
    return `${target.line.name || target.line.line_id || 'Line'}${kv}`;
  }
  if (target.tower) return `Tower ${target.tower.tower_id}`;
  return null;
}

// The asset an execution targeted, annotated with where it is installed.
export function targetAssetLabel(target) {
  if (!target || !target.asset) return null;
  const a = target.asset;
  const name = a.name || a.asset_id;
  const where = a.location_type ? ` (${a.location_type}${a.bay ? `, bay ${a.bay}` : ''})` : '';
  return `${name}${where}`;
}

function voltageText(levels) {
  let arr = levels;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch (_) { arr = [arr]; }
  }
  if (!Array.isArray(arr)) return null;
  const nums = arr.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  return nums.length ? `${Math.max(...nums)} kV` : null;
}

// A one-line description of a substation built from its identifying attributes,
// shown beside its map and used by the detail rows.
export function substationDescription(sub) {
  if (!sub) return null;
  return [sub.substation_type, voltageText(sub.voltage_levels), sub.bay_count ? `${sub.bay_count} bays` : null, sub.operational_status]
    .filter(Boolean).join(' · ') || null;
}

// A one-line description of an asset (make, model, serial, condition).
export function assetDescription(asset) {
  if (!asset) return null;
  return [asset.manufacturer, asset.model, asset.serial_number ? `S/N ${asset.serial_number}` : null, asset.condition_rating != null ? `condition ${asset.condition_rating}/10` : null]
    .filter(Boolean).join(' · ') || null;
}

// Descriptive rows for the executed checklist / task report: the line and its
// start-to-end terminals, the substation premises, the tower and the asset
// (including whether it is installed indoors or outdoors), each with the
// attributes a reader needs to identify the equipment.
export function targetDetailRows(target) {
  const rows = [];
  if (!target) return rows;
  const { line, substation: sub, tower, asset, region } = target;
  if (region) rows.push({ label: 'Region', value: region.name || region.code || '—' });
  if (line) {
    rows.push({ label: 'Transmission line', value: [line.name, line.line_id].filter(Boolean).join(' · ') || '—' });
    const from = line.from_substation && line.from_substation.name;
    const to = line.to_substation && line.to_substation.name;
    rows.push({ label: 'Line route', value: from && to ? `${from} → ${to}` : '—' });
    rows.push({
      label: 'Line rating',
      value: [line.voltage_kv ? `${line.voltage_kv} kV` : null, line.line_type, line.length_km ? `${line.length_km} km` : null, line.conductor_type]
        .filter(Boolean).join(' · ') || '—',
    });
  }
  if (sub) {
    rows.push({ label: 'Substation premises', value: [sub.name, sub.substation_id].filter(Boolean).join(' · ') || '—' });
    rows.push({ label: 'Premises detail', value: substationDescription(sub) || '—' });
  }
  if (tower) {
    rows.push({ label: 'Tower', value: [tower.tower_id, tower.tower_number ? `#${tower.tower_number}` : null].filter(Boolean).join(' · ') || '—' });
    rows.push({
      label: 'Tower detail',
      value: [tower.tower_type, tower.tower_material, tower.height_m ? `${tower.height_m} m` : null, tower.km_marker != null ? `km ${tower.km_marker}` : null, tower.foundation_type]
        .filter(Boolean).join(' · ') || '—',
    });
  }
  if (asset) {
    rows.push({ label: 'Asset worked on', value: [asset.name, asset.asset_id].filter(Boolean).join(' · ') || '—' });
    rows.push({ label: 'Asset type', value: [asset.asset_type, asset.sub_type].filter(Boolean).join(' / ') || '—' });
    rows.push({
      label: 'Indoor / outdoor',
      value: [asset.location_type || 'OUTDOOR', asset.bay ? `bay ${asset.bay}` : null].filter(Boolean).join(' · '),
    });
    rows.push({ label: 'Asset detail', value: assetDescription(asset) || '—' });
  }
  return rows;
}

// Eligibility gaps recorded when the task was dispatched — the certifications
// the crew was missing and the test equipment it had to secure — so a printed
// record carries the caveats as a note. Missed items are called out explicitly
// as a "missed certification" / "missed equipment" so a reader cannot mistake
// them for optional extras.
export function readinessNotes(readiness) {
  if (!readiness) return [];
  const notes = [];
  const missing = [...(readiness.missing_certs || [])];
  const obtain = (readiness.certs_to_obtain || []).map((c) => c.cert || c).filter(Boolean);
  const all = [...new Set([...missing, ...obtain])];
  if (all.length) notes.push({ label: 'Missed certification', value: all.join(', ') });
  const equipmentMissed = Array.isArray(readiness.equipment_checks)
    ? readiness.equipment_checks.filter((item) => item.status !== 'USED').map((item) => item.equipment)
    : readiness.equipment_to_secure || [];
  if (equipmentMissed.length) {
    notes.push({ label: 'Missed equipment', value: equipmentMissed.join(', ') });
  }
  if (readiness.team_shortfall > 0) notes.push({ label: 'Team shortfall', value: `${readiness.team_shortfall} person(s)` });
  return notes;
}

// The full list of test equipment the linked checklist recommends for the job
// (advisory — the schema holds no crew equipment inventory). Shown as a
// printable checklist so the crew has somewhere to tick off what it secures.
export function recommendedEquipment(readiness) {
  if (!readiness) return [];
  const fromReq = readiness.requirements && readiness.requirements.equipment_to_secure;
  const list = Array.isArray(fromReq) ? fromReq : readiness.equipment_to_secure;
  return [...new Set((list || []).filter(Boolean))];
}

// Workflow people in order of the task lifecycle.
export function workflowRows({ created_by, assigned_by, executed_by, verified_by } = {}) {
  const name = (p) => {
    if (!p) return null;
    if (typeof p === 'string') return p;
    return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.title || (p.id != null ? `person #${p.id}` : null);
  };
  return [
    { label: 'Created by', value: name(created_by) },
    { label: 'Assigned by', value: name(assigned_by) },
    { label: 'Executed by', value: name(executed_by) },
    { label: 'Verified by', value: name(verified_by) },
  ].filter((r) => r.value);
}

// A descriptive document title for an executed checklist: the task type and
// title, then the infrastructure and the asset, so a printed sheet is
// identifiable at a glance without reading the body.
export function executionTitle(exec) {
  const target = (exec && exec.target) || {};
  const type = exec && exec.task_type ? taskTypeLabel(exec.task_type) : null;
  const title = exec && exec.task_title ? exec.task_title : null;
  const parts = [];
  if (type && title) parts.push(`${type}: ${title}`);
  else if (type) parts.push(type);
  else if (title) parts.push(title);
  const infra = targetInfraLabel(target);
  const asset = targetAssetLabel(target);
  if (infra && infra !== title && !parts.some((p) => p.includes(infra))) parts.push(infra);
  if (asset && asset !== title && asset !== infra && !parts.some((p) => p.includes(asset))) parts.push(asset);
  if (parts.length) return parts.join(' — ');
  return exec && exec.id != null ? `Execution EX-${String(exec.id).padStart(5, '0')}` : 'Execution';
}
