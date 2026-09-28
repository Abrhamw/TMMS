const { db } = require('./db');
const { withTx } = require('./util');
const recurrence = require('./recurrence');

// Runs schedule auto-generation for due schedules. Safe to call repeatedly.
// Scan existing task numbers instead of parsing the newest row: legacy rows
// like TK-SCRATCH-CAP must not poison the next number.
function runGeneration() {
  try {
    const { db: d } = require('./db');
    const { maxTaskSeq, formatTaskNumber } = require('./taskNumber');
    const currentTaskSeq = maxTaskSeq;
    const OPEN = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
    const schedules = d.prepare('SELECT * FROM maintenance_schedule WHERE is_active = 1').all();
    const now = new Date().toISOString();
    const nowMs = Date.now();
    let generated = 0;
    let seq = currentTaskSeq();
    for (const s of schedules) {
      try {
        // Generate within the lead window: `lead_time_days` before the due date.
        const dueMs = s.next_due_date ? new Date(s.next_due_date).getTime() : NaN;
        const leadMs = Math.max(0, Number(s.lead_time_days) || 0) * 86400000;
        if (Number.isNaN(dueMs) || dueMs - leadMs > nowMs) continue;
        const existing = d.prepare(
          `SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`
        ).get(s.id, ...OPEN).c;
        if (existing > 0) continue;
        const targets = expand(s);
        // Generate every task for this schedule and advance the schedule in a
        // single transaction: a failure must not leave tasks created without the
        // schedule advancing (or advance without the tasks).
        const outcome = withTx(() => {
          let localSeq = seq;
          let count = 0;
          for (const target of targets) {
            localSeq += 1;
            const name = target.name || target.tower_id || target.substation_id || target.line_id || target.asset_id || target.code || '';
            const isTower = target.tower_id !== undefined;
            // SUBSTATION/REGION schedules expand into substation rows whose
            // `substation_id` column is the human code; task.substation_id must
            // reference the numeric primary key (FK) or the insert fails.
            const isSubstationTarget = s.scope_type === 'SUBSTATION' || s.scope_type === 'REGION';
            const lineId = isTower ? target.line_id : (s.scope_type === 'LINE' || s.scope_type === 'LINE_TOWERS' ? s.line_id : null);
            d.prepare(
              `INSERT INTO task (task_number, title, description, task_type, priority, status, region_id, substation_id, line_id, tower_id, asset_id, checklist_template_id, crew_id, due_date, source, schedule_id, created_at, updated_at, revision)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
            ).run(
              formatTaskNumber(localSeq),
              `${s.schedule_name} — ${name}`.trim(),
              s.instructions || `Auto-generated from schedule ${s.schedule_code}`,
              'PREVENTIVE',
              s.priority,
              'SCHEDULED',
              targetRegion(target, s.region_id),
              isSubstationTarget ? target.id : (target.substation_id ?? null),
              lineId,
              isTower ? target.id : null,
              target.asset_type && target.id ? target.id : null,
              s.checklist_template_id,
              s.responsible_crew_id,
              s.next_due_date,
              'SCHEDULE_GENERATED',
              s.id,
              now,
              now
            );
            count++;
          }
          const step = recurrence.advanceAfterGeneration(s);
          d.prepare('UPDATE maintenance_schedule SET last_generated_at = ?, next_due_date = ?, occurrences_generated = ?, is_active = ?, frequency = COALESCE(?, frequency), frequency_config = COALESCE(?, frequency_config) WHERE id = ?')
            .run(now, step.next_due_date, step.occurrences_generated, step.is_active, step.frequency ?? null, step.frequency_config ?? null, s.id);
          return { seq: localSeq, count };
        });
        seq = outcome.seq;
        generated += outcome.count;
      } catch (e) {
        console.error(`[scheduler] schedule ${s.id} failed:`, e);
      }
    }
    if (generated > 0) console.log(`[scheduler] generated ${generated} tasks`);
  } catch (e) {
    console.error('[scheduler] error:', e);
  }
}

function expand(s) {
  const { db } = require('./db');
  if (s.scope_type === 'ASSET_CLASS') return db.prepare("SELECT * FROM asset WHERE asset_type = ? AND lifecycle_status IN ('IN_SERVICE','UNDER_MAINTENANCE')").all(s.asset_type);
  if (s.scope_type === 'ASSET') return s.asset_id ? [db.prepare('SELECT * FROM asset WHERE id = ?').get(s.asset_id)].filter(Boolean) : [];
  if (s.scope_type === 'SUBSTATION') return s.substation_id ? [db.prepare('SELECT * FROM substation WHERE id = ?').get(s.substation_id)].filter(Boolean) : [];
  if (s.scope_type === 'LINE') return s.line_id ? [db.prepare('SELECT * FROM transmission_line WHERE id = ?').get(s.line_id)].filter(Boolean) : [];
  if (s.scope_type === 'LINE_TOWERS') return s.line_id ? db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker').all(s.line_id) : [];
  if (s.scope_type === 'TOWER') return s.tower_id ? [db.prepare('SELECT * FROM tower WHERE id = ?').get(s.tower_id)].filter(Boolean) : [];
  if (s.scope_type === 'REGION') return db.prepare('SELECT * FROM substation WHERE region_id = ?').all(s.region_id);
  return [];
}

// Resolve the region a generated task should belong to. Targets (assets, towers,
// lines) do not carry region_id directly, so derive it from their parent.
function targetRegion(target, scheduleRegion) {
  const { db } = require('./db');
  if (target.region_id) return target.region_id;
  if (target.substation_id) {
    const s = db.prepare('SELECT region_id FROM substation WHERE id = ?').get(target.substation_id);
    if (s) return s.region_id;
  }
  if (target.line_id) {
    const l = db.prepare('SELECT region_id FROM transmission_line WHERE id = ?').get(target.line_id);
    if (l) return l.region_id;
  }
  if (target.tower_id !== undefined && target.line_id) {
    const l = db.prepare('SELECT region_id FROM transmission_line WHERE id = ?').get(target.line_id);
    if (l) return l.region_id;
  }
  if (target.asset_id || target.asset_type) {
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(target.id);
    if (a) {
      if (a.substation_id) {
        const s = db.prepare('SELECT region_id FROM substation WHERE id = ?').get(a.substation_id);
        if (s) return s.region_id;
      }
      if (a.line_id) {
        const l = db.prepare('SELECT region_id FROM transmission_line WHERE id = ?').get(a.line_id);
        if (l) return l.region_id;
      }
    }
  }
  return scheduleRegion;
}

module.exports = { runGeneration };
