// Analytics + expert-evaluation layer for reports.
//
// Every report the platform produces is more than a table: this module turns
// the computed facts into a normalised analytics block (KPI tiles, bar charts,
// condition donut) plus a rule-based *expert evaluation* — a graded finding
// list and prioritised recommendations derived from real thresholds over the
// asset / crew / people evidence. Keeping the rules here (rather than in the
// React renderer) means the same judgement is printed, exported and shared.

const { suggestAssetCondition } = require('./assetCondition');
const { currencyCode } = require('./maintenanceCost');

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function money(v, code) {
  const c = code || currencyCode();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(Number(v) || 0);
  } catch (_) {
    return `${c} ${Math.round(Number(v) || 0).toLocaleString('en-US')}`;
  }
}

function gradeFor(score) {
  if (score == null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'E';
}

function hasImportant(evaluation) {
  return evaluation && evaluation.findings && evaluation.findings.length > 0;
}

function newEval() {
  return { score: null, grade: null, findings: [], recommendations: [] };
}

function finding(sev, text) {
  return { severity: sev, text };
}

function recommendation(priority, text) {
  return { priority, text };
}

// ---------------------------------------------------------------------------
// Report-type builders
// ---------------------------------------------------------------------------

function maintenanceCompletion(a, d) {
  const byLabel = {};
  for (const r of d.rows || []) byLabel[r.label] = r.value;
  const total = Number(byLabel['Total tasks']) || 0;
  const done = Number(byLabel['Completed']) || 0;
  const rate = Number(String(byLabel['Completion rate'] || '0').replace('%', '')) || 0;
  const onTimeRaw = String(byLabel['On-time rate'] || '');
  const onTime = onTimeRaw.includes('%') ? Number(onTimeRaw.replace('%', '')) : null;
  a.kpis = [
    { label: 'Total tasks', value: total },
    { label: 'Completed', value: done, sub: `${rate}% completion`, tone: rate >= 85 ? 'ok' : rate >= 70 ? 'warn' : 'bad' },
    { label: 'On-time', value: onTime == null ? 'N/A' : `${onTime}%`, tone: onTime == null ? undefined : onTime >= 85 ? 'ok' : onTime >= 70 ? 'warn' : 'bad' },
    { label: 'Outstanding', value: Math.max(0, total - done), sub: 'not completed in period' },
  ];
  const statusItems = Object.entries(d.by_status || {}).map(([label, value]) => ({ label, value }));
  if (statusItems.length) a.bars.push({ title: 'Tasks by status', items: statusItems });
  const ev = newEval();
  ev.score = Math.round((rate * 0.6) + ((onTime == null ? rate : onTime) * 0.4));
  ev.grade = gradeFor(ev.score);
  if (rate < 70) ev.findings.push(finding('critical', `Completion rate is ${rate}%, well below the 70% floor for the period.`));
  else if (rate < 85) ev.findings.push(finding('medium', `Completion rate is ${rate}%; the 85% target was not met.`));
  else ev.findings.push(finding('ok', `Completion rate is ${rate}%, at or above target.`));
  if (onTime != null && onTime < 75) ev.findings.push(finding('high', `Only ${onTime}% of completed work finished on time.`));
  const failed = Number(byLabel['Failed']) || 0;
  const cancelled = Number(byLabel['Cancelled']) || 0;
  if (failed) ev.findings.push(finding('high', `${failed} task(s) closed as failed and may need rework or follow-up.`));
  if (cancelled && total) ev.findings.push(finding('low', `${cancelled} task(s) were cancelled (${pct(cancelled, total)}% of the programme).`));
  if (rate < 85) ev.recommendations.push(recommendation('high', 'Re-sequence the remaining open work and confirm crew capacity against the backlog.'));
  if (onTime != null && onTime < 85) ev.recommendations.push(recommendation('medium', 'Review dispatch timing so field teams are mobilised before due dates, not after.'));
  a.evaluation = ev;
  return a;
}

function assetCondition(a, d) {
  const byKey = {};
  for (const b of d.buckets || []) byKey[b.key] = b;
  const good = byKey.good ? byKey.good.count : 0;
  const fair = byKey.fair ? byKey.fair.count : 0;
  const poor = (byKey.poor ? byKey.poor.count : 0) + (byKey.critical ? byKey.critical.count : 0);
  const critical = byKey.critical ? byKey.critical.count : 0;
  const total = d.total_assets || (good + fair + poor);
  const midpoint = ((byKey.good?.min + byKey.good?.max) / 2);
  let weighted = 0;
  for (const b of d.buckets || []) weighted += ((b.min + b.max) / 2) * b.count;
  const avg = total ? round1(weighted / total) : 0;
  void midpoint;
  a.kpis = [
    { label: 'Assets assessed', value: total },
    { label: 'Average condition', value: `${avg} / 10`, tone: avg >= 7 ? 'ok' : avg >= 5.5 ? 'warn' : 'bad' },
    { label: 'At risk (1-5)', value: poor, sub: `${pct(poor, total)}% of population`, tone: poor && pct(poor, total) > 15 ? 'bad' : poor ? 'warn' : 'ok' },
    { label: 'Critical (1-3)', value: critical, tone: critical ? 'bad' : 'ok' },
  ];
  a.donuts.push({ title: 'Condition mix', good, fair, poor, labels: ['Good (8-10)', 'Fair (6-7)', 'Poor (1-5)'] });
  if ((d.by_region || []).length) {
    a.bars.push({ title: 'Average condition by region', max: 10, items: d.by_region.map((r) => ({ label: r.region, value: r.avg_condition, sub: `${r.count} assets`, valueText: `${r.avg_condition}/10` })) });
  }
  const ev = newEval();
  ev.score = total ? Math.round((avg / 10) * 100) : null;
  ev.grade = gradeFor(ev.score);
  const poorShare = pct(poor, total);
  if (poorShare > 20) ev.findings.push(finding('critical', `${poorShare}% of the assessed fleet (${poor} assets) is in poor or critical condition.`));
  else if (poorShare > 10) ev.findings.push(finding('high', `${poorShare}% of the fleet (${poor} assets) sits below condition 6 and needs attention.`));
  else if (poor) ev.findings.push(finding('medium', `${poor} asset(s) are in poor or critical condition — monitor before the next cycle.`));
  else ev.findings.push(finding('ok', 'No assets are currently in poor or critical condition.'));
  if (avg && avg < 6) ev.findings.push(finding('high', `Average fleet condition of ${avg}/10 indicates ageing infrastructure.`));
  if (critical) ev.findings.push(finding('high', `${critical} asset(s) are at condition 1-3 and are candidates for renewal.`));
  if (poorShare > 10) ev.recommendations.push(recommendation('high', 'Prioritise a renewal/replacement programme for the condition 1-5 assets.'));
  ev.recommendations.push(recommendation('medium', 'Tighten the maintenance cadence on assets trending toward condition 6 to stop further decline.'));
  a.evaluation = ev;
  return a;
}

function crewUtilization(a, d) {
  const rows = d.rows || [];
  const utils = rows.map((r) => Number(r.utilization) || 0);
  const avg = rows.length ? Math.round(utils.reduce((s, x) => s + x, 0) / rows.length) : 0;
  const overloaded = rows.filter((r) => Number(r.utilization) > 110);
  const idle = rows.filter((r) => Number(r.utilization) < 25);
  a.kpis = [
    { label: 'Crews', value: rows.length },
    { label: 'Average utilisation', value: `${avg}%`, tone: avg >= 60 ? 'ok' : avg >= 35 ? 'warn' : 'bad' },
    { label: 'Over capacity', value: overloaded.length, sub: '> 110% utilisation', tone: overloaded.length ? 'warn' : 'ok' },
    { label: 'Under-utilised', value: idle.length, sub: '< 25% utilisation', tone: idle.length ? 'warn' : 'ok' },
  ];
  if (rows.length) {
    const max = Math.max(120, ...utils);
    a.bars.push({ title: 'Utilisation by crew', max, items: rows.slice(0, 15).map((r) => ({ label: r.name, value: Number(r.utilization) || 0, sub: `${r.completed_tasks}/${r.assigned_tasks} done`, valueText: `${r.utilization}%` })) });
  }
  const ev = newEval();
  if (overloaded.length) ev.findings.push(finding('high', `${overloaded.length} crew(s) exceed 110% utilisation — schedule risk and fatigue exposure.`));
  if (idle.length) ev.findings.push(finding('medium', `${idle.length} crew(s) are below 25% utilisation and could absorb re-sequenced work.`));
  if (!overloaded.length && !idle.length) ev.findings.push(finding('ok', 'Crew utilisation is balanced across the reporting scope.'));
  if (avg < 35) ev.findings.push(finding('medium', `Average utilisation of ${avg}% suggests under-loaded capacity.`));
  if (overloaded.length) ev.recommendations.push(recommendation('high', 'Re-balance work from over-capacity crews to under-utilised crews.'));
  ev.recommendations.push(recommendation('medium', 'Level the dispatch plan so utilisation stays inside the 40-90% band.'));
  a.evaluation = ev;
  return a;
}

function crewReadiness(a, d) {
  const rows = d.rows || [];
  const avgCompletion = rows.length ? Math.round(rows.reduce((s, r) => s + (Number(r.completion_rate) || 0), 0) / rows.length) : 0;
  const avgOnTime = rows.length ? Math.round(rows.reduce((s, r) => s + (Number(r.on_time_rate) || 0), 0) / rows.length) : 0;
  const atRisk = rows.reduce((s, r) => s + (Number(r.at_risk_tasks) || 0), 0);
  const expired = rows.reduce((s, r) => s + (Number(r.expired_certs) || 0), 0);
  a.kpis = [
    { label: 'Crews', value: rows.length },
    { label: 'Avg completion', value: `${avgCompletion}%`, tone: avgCompletion >= 85 ? 'ok' : avgCompletion >= 70 ? 'warn' : 'bad' },
    { label: 'At-risk tasks', value: atRisk, tone: atRisk ? 'warn' : 'ok' },
    { label: 'Expired certs', value: expired, tone: expired ? 'bad' : 'ok' },
  ];
  if (rows.length) {
    a.bars.push({ title: 'At-risk tasks by crew', items: rows.slice(0, 15).map((r) => ({ label: r.crew, value: Number(r.at_risk_tasks) || 0, sub: `${r.members} members` })) });
  }
  const ev = newEval();
  ev.score = Math.round(avgCompletion * 0.5 + (avgOnTime || avgCompletion) * 0.5);
  ev.grade = gradeFor(ev.score);
  if (expired) ev.findings.push(finding('critical', `${expired} expired certification(s) across the reporting crews.`));
  if (atRisk) ev.findings.push(finding('high', `${atRisk} task(s) are at risk of breaching their due dates.`));
  if (avgCompletion < 85) ev.findings.push(finding('medium', `Average crew completion is ${avgCompletion}%, below the 85% target.`));
  if (!expired && !atRisk && avgCompletion >= 85) ev.findings.push(finding('ok', 'Crews are fully certified with no at-risk task load.'));
  if (expired) ev.recommendations.push(recommendation('high', 'Suspend dispatch of uncertified staff and schedule recertification immediately.'));
  if (atRisk) ev.recommendations.push(recommendation('high', 'Re-plan the at-risk task load before the next reporting window.'));
  ev.recommendations.push(recommendation('medium', 'Review certification expiry dates 90 days ahead to avoid lapses.'));
  a.evaluation = ev;
  return a;
}

function personPerformance(a, d) {
  const rows = d.rows || [];
  const avgCompletion = rows.length ? Math.round(rows.reduce((s, r) => s + (Number(r.completion_rate) || 0), 0) / rows.length) : 0;
  const avgOnTime = rows.length ? Math.round(rows.reduce((s, r) => s + (Number(r.on_time_rate) || 0), 0) / rows.length) : 0;
  const findings = rows.reduce((s, r) => s + (Number(r.findings) || 0), 0);
  const violations = rows.reduce((s, r) => s + (Number(r.gps_violations) || 0), 0);
  a.kpis = [
    { label: 'People', value: rows.length },
    { label: 'Avg completion', value: `${avgCompletion}%`, tone: avgCompletion >= 85 ? 'ok' : avgCompletion >= 70 ? 'warn' : 'bad' },
    { label: 'Avg on-time', value: `${avgOnTime}%`, tone: avgOnTime >= 85 ? 'ok' : avgOnTime >= 70 ? 'warn' : 'bad' },
    { label: 'Findings', value: findings, sub: `${violations} GPS violations`, tone: findings || violations ? 'warn' : 'ok' },
  ];
  const ranked = [...rows].filter((r) => r.on_time_rate != null).sort((x, y) => (Number(y.on_time_rate) || 0) - (Number(x.on_time_rate) || 0)).slice(0, 15);
  if (ranked.length) {
    a.bars.push({ title: 'On-time rate by person', max: 100, items: ranked.map((r) => ({ label: r.person, value: Number(r.on_time_rate) || 0, sub: `${r.tasks} tasks`, valueText: `${r.on_time_rate}%` })) });
  }
  const ev = newEval();
  ev.score = Math.round(avgCompletion * 0.5 + avgOnTime * 0.5);
  ev.grade = gradeFor(ev.score);
  const weak = rows.filter((r) => Number(r.on_time_rate) < 60 && Number(r.tasks) >= 3);
  if (weak.length) ev.findings.push(finding('high', `${weak.length} person(s) are below a 60% on-time rate over a meaningful task count.`));
  if (avgOnTime < 80) ev.findings.push(finding('medium', `Average on-time performance is ${avgOnTime}%.`));
  if (violations) ev.findings.push(finding('high', `${violations} GPS validation violation(s) recorded against field staff.`));
  if (findings) ev.findings.push(finding('medium', `${findings} field finding(s) were raised by this group.`));
  if (!weak.length && !violations && avgOnTime >= 80) ev.findings.push(finding('ok', 'Field performance is consistent across the reporting group.'));
  if (weak.length) ev.recommendations.push(recommendation('high', 'Coach or re-brief the lowest on-time performers and pair them with strong crews.'));
  if (violations) ev.recommendations.push(recommendation('high', 'Investigate GPS mismatches for possible dispatch or integrity issues.'));
  a.evaluation = ev;
  return a;
}

function outageIncident(a, d) {
  const t = d.totals || {};
  a.kpis = [
    { label: 'Incidents', value: t.incidents ?? 0 },
    { label: 'Substations out', value: t.substations_out ?? 0, tone: t.substations_out ? 'bad' : 'ok' },
    { label: 'Lines out', value: t.lines_out ?? 0, tone: t.lines_out ? 'bad' : 'ok' },
  ];
  const byType = {};
  for (const i of d.incidents || []) byType[i.task_type] = (byType[i.task_type] || 0) + 1;
  const items = Object.entries(byType).map(([label, value]) => ({ label, value }));
  if (items.length) a.bars.push({ title: 'Incidents by type', items });
  const ev = newEval();
  if (t.substations_out || t.lines_out) {
    ev.findings.push(finding('critical', `${t.substations_out || 0} substation(s) and ${t.lines_out || 0} line(s) are out of service.`));
    ev.recommendations.push(recommendation('high', 'Confirm restoration crews are assigned and give outage assets priority in dispatch.'));
  } else {
    ev.findings.push(finding('ok', 'No substations or lines are currently out of service.'));
  }
  if ((t.incidents || 0) > 0) ev.findings.push(finding('medium', `${t.incidents} emergency/corrective incident(s) were logged in the period.`));
  a.evaluation = ev;
  return a;
}

function complianceAudit(a, d) {
  const comp = String(d.checklist_compliance || 'N/A');
  const gps = String(d.gps_pass_rate || 'N/A');
  const compNum = comp.includes('%') ? Number(comp.replace('%', '')) : null;
  const gpsNum = gps.includes('%') ? Number(gps.replace('%', '')) : null;
  a.kpis = [
    { label: 'Checklist compliance', value: comp, tone: compNum == null ? undefined : compNum >= 90 ? 'ok' : compNum >= 75 ? 'warn' : 'bad' },
    { label: 'GPS pass rate', value: gps, tone: gpsNum == null ? undefined : gpsNum >= 90 ? 'ok' : gpsNum >= 75 ? 'warn' : 'bad' },
    { label: 'Expired certs', value: d.expired_certs ?? 0, sub: `of ${d.total_certs ?? 0}`, tone: d.expired_certs ? 'bad' : 'ok' },
    { label: 'Missed equipment', value: d.missed_equipment_total ?? 0, tone: d.missed_equipment_total ? 'warn' : 'ok' },
  ];
  if ((d.region_cert_status || []).length) {
    a.bars.push({ title: 'Expired certifications by region', items: d.region_cert_status.map((r) => ({ label: r.region, value: Number(r.expired) || 0, sub: `${r.total} total` })) });
  }
  if (d.missed_equipment_by_kind) {
    a.bars.push({ title: 'Missed maintenance by kind', items: [
      { label: 'Assets overdue', value: d.missed_equipment_by_kind.assets || 0 },
      { label: 'Schedules overdue', value: d.missed_equipment_by_kind.schedules || 0 },
    ] });
  }
  const ev = newEval();
  ev.score = compNum;
  ev.grade = gradeFor(compNum);
  if (compNum != null && compNum < 75) ev.findings.push(finding('critical', `Checklist compliance is ${comp}%, materially below the 75% floor.`));
  else if (compNum != null && compNum < 90) ev.findings.push(finding('medium', `Checklist compliance is ${comp}%, short of the 90% target.`));
  if (gpsNum != null && gpsNum < 85) ev.findings.push(finding('high', `GPS validation pass rate is only ${gps}.`));
  if (d.expired_certs) ev.findings.push(finding('critical', `${d.expired_certs} certification(s) have expired, creating a compliance exposure.`));
  if (d.missed_equipment_total) ev.findings.push(finding('high', `${d.missed_equipment_total} asset/schedule maintenance item(s) are overdue.`));
  if (compNum != null && compNum >= 90 && !d.expired_certs && !d.missed_equipment_total) ev.findings.push(finding('ok', 'Compliance indicators are within acceptable limits.'));
  ev.recommendations.push(recommendation('high', 'Clear the overdue maintenance and certification backlog before the next audit.'));
  ev.recommendations.push(recommendation('medium', 'Enforce the checklist and GPS capture steps at submission to protect the compliance rate.'));
  a.evaluation = ev;
  return a;
}

function overdueTask(a, d) {
  a.kpis = [
    { label: 'Total overdue', value: d.total_overdue ?? 0, tone: d.total_overdue ? 'bad' : 'ok' },
    { label: '> 90 days', value: (d.buckets || []).find((b) => String(b.label).includes('90'))?.count || 0, tone: 'bad' },
  ];
  if ((d.buckets || []).length) a.bars.push({ title: 'Aging of overdue tasks', items: d.buckets.map((b) => ({ label: b.label, value: Number(b.count) || 0 })) });
  if (d.by_status) a.bars.push({ title: 'Overdue tasks by status', items: Object.entries(d.by_status).map(([label, value]) => ({ label, value })) });
  const ev = newEval();
  const total = d.total_overdue || 0;
  const ancient = (d.buckets || []).find((b) => String(b.label).includes('90'))?.count || 0;
  if (total === 0) ev.findings.push(finding('ok', 'No tasks are overdue in the reporting scope.'));
  else {
    ev.findings.push(finding(total > 20 ? 'critical' : 'high', `${total} task(s) are past their due date.`));
    if (ancient) ev.findings.push(finding('critical', `${ancient} task(s) are more than 90 days overdue and likely abandoned in the workflow.`));
  }
  if (total) ev.recommendations.push(recommendation('high', 'Triage the > 90-day backlog first: reschedule, reassign or formally cancel each item.'));
  ev.recommendations.push(recommendation('medium', 'Add a weekly overdue review to the dispatch cycle to prevent re-accumulation.'));
  a.evaluation = ev;
  return a;
}

function scheduleAdherence(a, d) {
  const rows = d.rows || [];
  const inactive = rows.filter((r) => !r.is_active).length;
  const overdue = rows.filter((r) => r.next_due && new Date(r.next_due) < new Date()).length;
  a.kpis = [
    { label: 'Schedules', value: rows.length },
    { label: 'Active', value: rows.length - inactive, tone: inactive ? 'warn' : 'ok' },
    { label: 'Inactive', value: inactive, tone: inactive ? 'warn' : 'ok' },
    { label: 'Next due passed', value: overdue, tone: overdue ? 'bad' : 'ok' },
  ];
  if (rows.length) a.bars.push({ title: 'Generated tasks by schedule', items: rows.slice(0, 15).map((r) => ({ label: r.name, value: Number(r.generated) || 0, sub: `${r.open} open` })) });
  const ev = newEval();
  if (overdue) ev.findings.push(finding('high', `${overdue} maintenance schedule(s) have a next-due date already passed.`));
  if (inactive) ev.findings.push(finding('medium', `${inactive} schedule(s) are inactive and will not generate work.`));
  if (!overdue && !inactive) ev.findings.push(finding('ok', 'All maintenance schedules are active and up to date.'));
  if (overdue) ev.recommendations.push(recommendation('high', 'Trigger the overdue schedules and confirm the generated tasks are dispatched.'));
  a.evaluation = ev;
  return a;
}

function gpsCoverage(a, d) {
  const rows = d.by_type || [];
  const totalPass = rows.reduce((s, r) => s + (Number(r.pass) || 0), 0);
  const total = d.total || rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  a.kpis = [
    { label: 'Validations', value: total },
    { label: 'Overall pass rate', value: `${pct(totalPass, total)}%`, tone: pct(totalPass, total) >= 90 ? 'ok' : pct(totalPass, total) >= 75 ? 'warn' : 'bad' },
    { label: 'Target types', value: rows.length },
  ];
  if (rows.length) a.bars.push({ title: 'Pass rate by target type', max: 100, items: rows.map((r) => ({ label: r.target_type, value: Number(String(r.rate || '0').replace('%', '')) || 0, sub: `${r.total} validations`, valueText: r.rate })) });
  const ev = newEval();
  ev.score = pct(totalPass, total);
  ev.grade = gradeFor(ev.score);
  const rate = pct(totalPass, total);
  if (total === 0) ev.findings.push(finding('medium', 'No GPS validations were recorded in the period.'));
  else if (rate < 85) ev.findings.push(finding('high', `GPS validation pass rate is ${rate}%, indicating location mismatches in the field.`));
  else ev.findings.push(finding('ok', `GPS validation pass rate is ${rate}%.`));
  if (total && rate < 85) ev.recommendations.push(recommendation('high', 'Investigate the failing target types and re-validate on site.'));
  a.evaluation = ev;
  return a;
}

function assetValuation(a, d) {
  const f = d.financial || {};
  const code = f.currency && typeof f.currency === 'object' ? f.currency.code : f.currency;
  const haircut = (Number(f.rcn) || 0) - (Number(f.current) || 0);
  a.kpis = [
    { label: 'Population', value: f.count ?? 0 },
    { label: 'Replacement cost (RCN)', value: money(f.rcn, code) },
    { label: 'Condition-adjusted value', value: money(f.current, code), sub: `${money(haircut, code)} condition haircut` },
    { label: 'Unpriced assets', value: f.unpriced_count ?? 0, tone: f.unpriced_count ? 'warn' : 'ok' },
    { label: 'Average condition', value: `${round1(f.avg_condition)} / 10`, tone: f.avg_condition >= 7 ? 'ok' : f.avg_condition >= 5.5 ? 'warn' : 'bad' },
  ];
  const families = [...(f.by_family || [])].sort((x, y) => (Number(y.current) || 0) - (Number(x.current) || 0)).slice(0, 12);
  if (families.length) a.bars.push({ title: 'Current value by family', items: families.map((r) => ({ label: r.family_label || r.family, value: Number(r.current) || 0, sub: `${r.count} assets`, valueText: money(r.current, code) })) });
  const ev = newEval();
  ev.score = f.avg_condition ? Math.round((f.avg_condition / 10) * 100) : null;
  ev.grade = gradeFor(ev.score);
  const dep = f.rcn ? Math.round((haircut / f.rcn) * 100) : 0;
  if (dep > 50) ev.findings.push(finding('high', `Condition depreciation removes ${dep}% of the replacement value (${money(haircut, code)}).`));
  else ev.findings.push(finding('ok', `Condition depreciation is ${dep}% of replacement value.`));
  if (f.unpriced_count) ev.findings.push(finding('medium', `${f.unpriced_count} asset(s) have no catalogue price and are excluded from the valuation.`));
  if (f.avg_condition && f.avg_condition < 6) ev.findings.push(finding('high', `Average condition is ${round1(f.avg_condition)}/10, accelerating value loss.`));
  if (f.unpriced_count) ev.recommendations.push(recommendation('medium', 'Price the unpriced asset types in the catalogue to complete the valuation.'));
  ev.recommendations.push(recommendation('high', 'Target renewal spend at the highest-value, lowest-condition families first.'));
  a.evaluation = ev;
  return a;
}

function maintenanceCost(a, d) {
  const f = d.financial || {};
  const code = f.currency && typeof f.currency === 'object' ? f.currency.code : f.currency;
  const regions = f.by_region || [];
  const top = regions[0];
  const topShare = top && f.totals ? pct(top.spend, f.totals.spend) : 0;
  a.kpis = [
    { label: 'Total spend', value: money(f.totals?.spend, code) },
    { label: 'Events', value: f.totals?.count ?? 0 },
    { label: 'Avg / event', value: money(f.totals?.avg, code) },
    { label: 'Top region share', value: `${topShare}%`, sub: top ? top.region : '—', tone: topShare > 60 ? 'warn' : 'ok' },
  ];
  if (regions.length) a.bars.push({ title: 'Spend by region', items: regions.map((r) => ({ label: r.region, value: Number(r.spend) || 0, sub: `${r.count} events`, valueText: money(r.spend, code) })) });
  if ((f.monthly || []).length) a.bars.push({ title: 'Monthly spend trend', items: f.monthly.map((r) => ({ label: r.month, value: Number(r.spend) || 0, valueText: money(r.spend, code) })) });
  const ev = newEval();
  if (topShare > 60) ev.findings.push(finding('medium', `${topShare}% of maintenance spend is concentrated in one region (${top.region}).`));
  else ev.findings.push(finding('ok', 'Maintenance spend is reasonably distributed across regions.'));
  const avg = f.totals?.avg || 0;
  const high = (f.recent || []).filter((r) => Number(r.cost) > avg * 3);
  if (high.length) ev.findings.push(finding('medium', `${high.length} event(s) cost more than three times the average — review for scope creep.`));
  ev.recommendations.push(recommendation('medium', 'Compare unit costs across regions and standardise the most expensive event types.'));
  a.evaluation = ev;
  return a;
}

function assetDetail(a, data, doc) {
  const asset = doc.asset || {};
  const suggestion = suggestAssetCondition(asset);
  const t = doc.totals || {};
  const rating = asset.condition_rating ?? suggestion?.suggested_rating;
  const health = asset.health_index ?? suggestion?.health_index;
  a.kpis = [
    { label: 'Condition', value: `${rating ?? '—'} / 10`, tone: rating >= 7 ? 'ok' : rating >= 5 ? 'warn' : 'bad' },
    { label: 'Health index', value: health != null ? `${health}%` : '—', tone: health >= 70 ? 'ok' : health >= 50 ? 'warn' : 'bad' },
    { label: 'Remaining life', value: asset.remaining_useful_life_years != null ? `${asset.remaining_useful_life_years} yr` : '—' },
    { label: 'Open tasks', value: t.open_tasks ?? 0, tone: t.open_tasks ? 'warn' : 'ok' },
    { label: 'Findings', value: t.findings ?? 0, tone: t.findings ? 'warn' : 'ok' },
    { label: 'GPS violations', value: t.gps_violations ?? 0, tone: t.gps_violations ? 'bad' : 'ok' },
  ];
  const buckets = { Good: 0, Fair: 0, Poor: 0 };
  a.donuts.push({ title: 'Condition', good: rating >= 8 ? 1 : 0, fair: rating >= 6 && rating < 8 ? 1 : 0, poor: rating < 6 ? 1 : 0, labels: ['Good', 'Fair', 'Poor'] });
  void buckets;
  const byStatus = {};
  for (const task of doc.tasks || []) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  if (Object.keys(byStatus).length) a.bars.push({ title: 'Maintenance history by status', items: Object.entries(byStatus).map(([label, value]) => ({ label, value })) });
  const ev = newEval();
  if (suggestion) {
    ev.score = Math.round((Number(suggestion.suggested_rating) / 10) * 100);
    ev.grade = gradeFor(ev.score);
    const sev = suggestion.suggested_rating <= 4 ? 'critical' : suggestion.suggested_rating <= 6 ? 'high' : 'ok';
    ev.findings.push(finding(sev, `Evidence-based assessment suggests condition ${suggestion.suggested_rating}/10 (currently recorded ${suggestion.current_rating ?? '—'}/10).`));
    for (const r of suggestion.reasons || []) ev.findings.push(finding(sev === 'ok' ? 'low' : 'medium', r));
    ev.recommendations.push(recommendation(suggestion.recommendation === 'REPLACE' ? 'high' : 'medium', suggestion.recommendation_label || suggestion.recommendation));
  }
  if (t.gps_violations) ev.recommendations.push(recommendation('high', 'Re-validate the asset location on site to clear the GPS mismatch.'));
  a.evaluation = ev;
  return a;
}

function crewDetail(a, data, doc) {
  const r = doc.readiness || {};
  const p = r.performance || {};
  const crew = doc.crew || {};
  a.kpis = [
    { label: 'Members', value: r.crew?.member_count ?? 0 },
    { label: 'Valid certs', value: r.cert_status?.valid ?? 0, tone: 'ok' },
    { label: 'Expired certs', value: r.cert_status?.expired ?? 0, tone: r.cert_status?.expired ? 'bad' : 'ok' },
    { label: 'Open tasks', value: (r.open_tasks || []).length, tone: (r.open_tasks || []).length ? 'warn' : 'ok' },
    { label: 'At-risk tasks', value: r.at_risk_tasks ?? 0, tone: r.at_risk_tasks ? 'warn' : 'ok' },
    { label: 'Completion', value: p.completion_rate != null ? `${p.completion_rate}%` : '—' },
  ];
  const byStatus = {};
  for (const task of doc.tasks || []) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  if (Object.keys(byStatus).length) a.bars.push({ title: 'Workload by status', items: Object.entries(byStatus).map(([label, value]) => ({ label, value })) });
  const ev = newEval();
  ev.score = p.completion_rate ?? null;
  ev.grade = gradeFor(ev.score);
  if (r.cert_status?.expired) ev.findings.push(finding('critical', `${r.cert_status.expired} member certification(s) have expired.`));
  if (r.at_risk_tasks) ev.findings.push(finding('high', `${r.at_risk_tasks} task(s) are at risk of missing their due date.`));
  if ((p.completion_rate ?? 100) < 85) ev.findings.push(finding('medium', `Completion rate is ${p.completion_rate}%, below target.`));
  if (!r.cert_status?.expired && !r.at_risk_tasks && (p.completion_rate ?? 100) >= 85) ev.findings.push(finding('ok', `${crew.name || 'Crew'} is fully certified and on top of its workload.`));
  if (r.cert_status?.expired) ev.recommendations.push(recommendation('high', 'Schedule recertification before assigning further work.'));
  if (r.at_risk_tasks) ev.recommendations.push(recommendation('high', 'Re-sequence the at-risk tasks to protect the due dates.'));
  a.evaluation = ev;
  return a;
}

function personDetail(a, data, doc) {
  const p = doc.performance || {};
  const person = doc.person || {};
  a.kpis = [
    { label: 'Tasks', value: p.tasks ?? 0 },
    { label: 'Completed', value: p.completed ?? 0 },
    { label: 'Completion', value: p.completion_rate != null ? `${p.completion_rate}%` : '—', tone: (p.completion_rate ?? 100) >= 85 ? 'ok' : 'warn' },
    { label: 'On-time', value: p.on_time_rate != null ? `${p.on_time_rate}%` : '—', tone: p.on_time_rate == null ? undefined : p.on_time_rate >= 85 ? 'ok' : 'warn' },
    { label: 'Findings', value: p.findings ?? 0, tone: p.findings ? 'warn' : 'ok' },
    { label: 'GPS violations', value: p.gps_violations ?? 0, tone: p.gps_violations ? 'bad' : 'ok' },
  ];
  const byResult = {};
  for (const e of doc.executions || []) { const k = e.result || 'INCOMPLETE'; byResult[k] = (byResult[k] || 0) + 1; }
  if (Object.keys(byResult).length) a.bars.push({ title: 'Checklist executions by result', items: Object.entries(byResult).map(([label, value]) => ({ label, value })) });
  const ev = newEval();
  ev.score = p.completion_rate != null && p.on_time_rate != null ? Math.round((p.completion_rate + p.on_time_rate) / 2) : p.completion_rate ?? null;
  ev.grade = gradeFor(ev.score);
  const name = [person.first_name, person.last_name].filter(Boolean).join(' ') || 'This person';
  if (p.gps_violations) ev.findings.push(finding('high', `${p.gps_violations} GPS validation violation(s) are attributed to ${name}.`));
  if (p.on_time_rate != null && p.on_time_rate < 70) ev.findings.push(finding('medium', `On-time rate is ${p.on_time_rate}%.`));
  if (p.findings) ev.findings.push(finding('low', `${p.findings} field finding(s) were raised.`));
  if (!p.gps_violations && (p.on_time_rate == null || p.on_time_rate >= 85)) ev.findings.push(finding('ok', `${name} has a clean performance record for the period.`));
  if (p.gps_violations) ev.recommendations.push(recommendation('high', 'Review the GPS mismatches with the field team.'));
  a.evaluation = ev;
  return a;
}

function taskDetail(a, data, doc) {
  const s = doc.summary || {};
  const task = doc.task || {};
  const overdue = task.due_date && ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'].includes(task.status) && new Date(task.due_date) < new Date();
  a.kpis = [
    { label: 'Executions', value: s.executions ?? 0 },
    { label: 'Passed', value: s.pass ?? 0, tone: 'ok' },
    { label: 'Failed', value: s.fail ?? 0, tone: s.fail ? 'bad' : 'ok' },
    { label: 'Findings', value: s.findings ?? 0, tone: s.findings ? 'warn' : 'ok' },
    { label: 'GPS validations', value: s.gps_validations ?? 0, sub: `${s.gps_fail ?? 0} failed`, tone: s.gps_fail ? 'bad' : 'ok' },
    { label: 'Status', value: task.status || '—', tone: overdue ? 'bad' : 'ok' },
  ];
  if (s.executions) a.bars.push({ title: 'Execution outcome', max: s.executions, items: [
    { label: 'Pass', value: s.pass ?? 0, color: '#16a34a' },
    { label: 'Fail', value: s.fail ?? 0, color: '#dc2626' },
    { label: 'Other', value: Math.max(0, (s.executions || 0) - (s.pass || 0) - (s.fail || 0)), color: '#d97706' },
  ] });
  const ev = newEval();
  if (overdue) ev.findings.push(finding('high', `This task is past its due date (${String(task.due_date).slice(0, 10)}).`));
  if (s.fail) ev.findings.push(finding('high', `${s.fail} checklist execution(s) failed — the asset condition may be affected.`));
  if (s.gps_fail) ev.findings.push(finding('high', `${s.gps_fail} GPS validation(s) failed for this task.`));
  if (s.findings) ev.findings.push(finding('medium', `${s.findings} field finding(s) were recorded.`));
  if (!overdue && !s.fail && !s.gps_fail && !s.findings) ev.findings.push(finding('ok', 'The task is on track with no adverse findings.'));
  if (!overdue && ['COMPLETED'].includes(task.status)) ev.findings.push(finding('ok', 'Task is completed.'));
  if (s.fail) ev.recommendations.push(recommendation('high', 'Review the failed checklist items and raise corrective work.'));
  if (overdue) ev.recommendations.push(recommendation('high', 'Re-prioritise or reschedule this overdue task.'));
  a.evaluation = ev;
  return a;
}

function lineDetail(a, data, doc) {
  const t = doc.totals || {};
  a.kpis = [
    { label: 'Towers', value: t.towers ?? 0 },
    { label: 'Assets', value: t.assets ?? 0 },
    { label: 'Tasks', value: t.tasks ?? 0, sub: `${t.completed_tasks ?? 0} completed` },
    { label: 'Open tasks', value: t.open_tasks ?? 0, tone: t.open_tasks ? 'warn' : 'ok' },
    { label: 'Overdue', value: t.overdue_tasks ?? 0, tone: t.overdue_tasks ? 'bad' : 'ok' },
    { label: 'Findings', value: t.findings ?? 0, tone: t.findings ? 'warn' : 'ok' },
    { label: 'GPS fails', value: t.gps_fail ?? 0, tone: t.gps_fail ? 'bad' : 'ok' },
  ];
  const byStatus = {};
  for (const task of doc.tasks || []) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  if (Object.keys(byStatus).length) a.bars.push({ title: 'Line tasks by status', items: Object.entries(byStatus).map(([label, value]) => ({ label, value })) });
  const ev = newEval();
  if (t.overdue_tasks) ev.findings.push(finding('high', `${t.overdue_tasks} task(s) on this line are overdue.`));
  if (t.gps_fail) ev.findings.push(finding('high', `${t.gps_fail} GPS validation(s) failed along the line.`));
  if (t.findings) ev.findings.push(finding('medium', `${t.findings} field finding(s) were recorded across the line.`));
  if (!t.overdue_tasks && !t.gps_fail) ev.findings.push(finding('ok', 'No overdue tasks or GPS failures along this line.'));
  if (t.overdue_tasks) ev.recommendations.push(recommendation('high', 'Dispatch crews to clear the overdue line maintenance.'));
  a.evaluation = ev;
  return a;
}

function assetRevaluation(a, d) {
  const t = d.totals || {};
  a.kpis = [
    { label: 'Assets evaluated', value: t.evaluated ?? 0 },
    { label: 'Condition changes', value: t.changed ?? 0 },
    { label: 'Degraded', value: t.degraded ?? 0, tone: t.degraded ? 'bad' : 'ok' },
    { label: 'Improved', value: t.improved ?? 0, tone: 'ok' },
  ];
  if ((d.buckets || []).length) a.bars.push({ title: 'Revaluation direction', items: d.buckets.map((b) => ({ label: b.label, value: Number(b.count) || 0, color: b.label === 'Degraded' ? '#dc2626' : b.label === 'Improved' ? '#16a34a' : '#94a3b8' })) });
  if ((d.by_recommendation || []).length) a.bars.push({ title: 'Recommended action', items: d.by_recommendation.map((r) => ({ label: r.recommendation, value: Number(r.count) || 0 })) });
  if ((d.by_region || []).length) a.bars.push({ title: 'Degraded assets by region', items: d.by_region.map((r) => ({ label: r.label, value: Number(r.value) || 0 })) });
  const ev = newEval();
  const degraded = d.changes || [];
  if (t.degraded) {
    ev.findings.push(finding('high', `${t.degraded} asset(s) show a degraded condition since their last assessment.`));
    for (const c of degraded.filter((x) => x.delta < 0).slice(0, 5)) {
      ev.findings.push(finding(c.to_rating <= 4 ? 'critical' : 'medium', `${c.asset_code} — ${c.asset_name}: suggested condition fell from ${c.from_rating ?? '—'} to ${c.to_rating} (${c.recommendation_label || c.recommendation}).`));
    }
    ev.recommendations.push(recommendation('high', 'Have an evaluator confirm the degraded assets and raise corrective or renewal work.'));
  } else if ((t.changed ?? 0) === 0) {
    ev.findings.push(finding('ok', 'No condition changes were detected in this run.'));
  }
  if (t.improved) ev.findings.push(finding('low', `${t.improved} asset(s) improved following maintenance.`));
  ev.recommendations.push(recommendation('medium', 'Review the revaluation change log at least monthly to catch drift early.'));
  a.evaluation = ev;
  return a;
}

const BUILDERS = {
  MAINTENANCE_COMPLETION: maintenanceCompletion,
  ASSET_CONDITION: assetCondition,
  CREW_UTILIZATION: crewUtilization,
  CREW_READINESS: crewReadiness,
  PERSON_PERFORMANCE: personPerformance,
  OUTAGE_INCIDENT: outageIncident,
  COMPLIANCE_AUDIT: complianceAudit,
  OVERDUE_TASK: overdueTask,
  SCHEDULE_ADHERENCE: scheduleAdherence,
  GPS_COVERAGE: gpsCoverage,
  ASSET_VALUATION: assetValuation,
  MAINTENANCE_COST: maintenanceCost,
  ASSET_DETAIL: assetDetail,
  CREW_DETAIL: crewDetail,
  PERSON_DETAIL: personDetail,
  TASK_DETAIL: taskDetail,
  LINE_DETAIL: lineDetail,
  ASSET_REVALUATION: assetRevaluation,
};

function buildAnalytics(reportType, data) {
  const builder = BUILDERS[reportType];
  if (!builder) return null;
  const a = { kpis: [], bars: [], donuts: [], evaluation: newEval() };
  try {
    builder(a, data, data.document || {});
  } catch (_) {
    return null;
  }
  return a;
}

module.exports = { buildAnalytics, hasImportant };
