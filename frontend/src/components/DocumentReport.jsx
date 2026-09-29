import { useEffect, useState } from 'react';
import { fmtDate, fmtDateTime, STATUS_COLORS } from '../api';
import { Pill, CondPill, Progress } from '../components';
import { getStoredToken } from '../auth';
import { formatChecklistResponse, formatChecklistResult } from '../checklistFormat';
import DocumentGeo from './DocumentGeo';
import TargetProfile from './TargetProfile';

// Detail-document renderer for the entity reports (ASSET / CREW / TASK / LINE).
// Shows the metric rows produced by the backend plus the structured document
// sections: executions with the articulated checklist, findings, attachments,
// GPS validations, past/future related tasks and (for lines) the tower fleet.
// A task report carries the descriptive target/governance block, with the
// route map beside the work-location detail, so the location and the dispatch
// notes are read first.
export default function DocumentReport({ data, onOpenEntity }) {
  if (!data) return <div className="muted">No data</div>;
  const metricRows = (data.rows || []).filter((r) => r && 'label' in r);
  const document = data.document || {};
  return (
    <div>
      {metricRows.length > 0 && (
        <table className="mb">
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>{metricRows.map((r, i) => <tr key={i}><td>{r.label}</td><td><b>{r.value}</b></td></tr>)}</tbody>
        </table>
      )}
      {document.entity !== 'TASK' && <DocumentGeo document={document} />}
      <DocumentSections document={document} onOpenEntity={onOpenEntity} />
    </div>
  );
}

function Section({ title, children, hint }) {
  return (
    <div className="mt">
      <h4 className="section-title">{title}{hint && <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>{hint}</span>}</h4>
      {children}
    </div>
  );
}

function PillText({ value }) {
  const color = STATUS_COLORS[value];
  return color ? <span style={{ fontWeight: 700, color }}>{value}</span> : <b>{value}</b>;
}

function DocumentSections({ document, onOpenEntity }) {
  if (!document) return <div className="muted">No document data</div>;
  const totals = document.totals || {};
  if (document.entity === 'ASSET') {
    const a = document.asset || {};
    return (
      <div className="grid grid-2">
        <div className="card card-pad">
          <b>{document.entity_name}</b>
          <div className="kv mt" style={{ gridTemplateColumns: '130px 1fr', fontSize: 13 }}>
            <span className="k">Asset ID</span><span className="mono">{a.asset_id}</span>
            <span className="k">Condition</span><span><CondPill rating={a.condition_rating} /></span>
            <span className="k">Health / RUL</span><span>{a.health_index != null ? `${a.health_index}%` : '—'} / {a.remaining_useful_life_years ?? '—'} yr</span>
            <span className="k">Lifecycle</span><span>{a.lifecycle_status}</span>
            <span className="k">Operational</span><span>{a.operational_status}</span>
            <span className="k">Criticality</span><span>{a.criticality}</span>
          </div>
          {(document.tasks_future || []).length > 0 && (
            <Section title="Upcoming work" hint={`${(document.tasks_future || []).length} task(s)`}>
              <TaskRows tasks={document.tasks_future} onOpenEntity={onOpenEntity} />
            </Section>
          )}
          {(document.tasks_past || []).length > 0 && (
            <Section title="Historical tasks" hint={`${(document.tasks_past || []).length} task(s)`}>
              <TaskRows tasks={document.tasks_past} onOpenEntity={onOpenEntity} />
            </Section>
          )}
          {(document.gps_violations || []).length > 0 && (
            <Section title="GPS violations" hint={`${(document.gps_violations || []).length} event(s)`}>
              <GpsRows rows={document.gps_violations} />
            </Section>
          )}
          {(document.components || []).length > 0 && (
            <Section title="Components / parts">
              <table>
                <thead><tr><th>Part</th><th>Material</th><th>Qty</th><th>Condition</th></tr></thead>
                <tbody>{document.components.map((c) => (
                  <tr key={c.id}><td>{c.component_type} · {c.name}</td><td>{c.material || '—'}</td><td>{c.quantity}</td><td><CondPill rating={c.condition_rating ?? c.corrosion_rating} /></td></tr>
                ))}</tbody>
              </table>
            </Section>
          )}
          {(document.history || []).length > 0 && (
            <Section title="Maintenance history">
              <table>
                <thead><tr><th>When</th><th>Event</th><th>Crew</th></tr></thead>
                <tbody>{document.history.map((e) => (
                  <tr key={e.id}><td>{fmtDateTime(e.performed_at)}</td><td>{e.event_type} {e.task_id ? <span className="muted">#{e.task_id}</span> : null}</td><td>{e.crew_id || '—'}</td></tr>
                ))}</tbody>
              </table>
            </Section>
          )}
        </div>
        <div>
          <Section title="Checklist executions" hint={`${(document.executions || []).length} · ${totals.completed_tasks ?? '—'} completed task(s)`}>
            <ExecRows rows={document.executions} />
          </Section>
        </div>
      </div>
    );
  }
  if (document.entity === 'CREW') {
    const c = document.crew || {};
    return (
      <div className="grid grid-2">
        <div className="card card-pad">
          <b>{document.entity_name}</b>
          <div className="kv mt" style={{ gridTemplateColumns: '130px 1fr', fontSize: 13 }}>
            <span className="k">Code</span><span className="mono">{c.crew_code}</span>
            <span className="k">Type</span><span>{c.crew_type}</span>
            <span className="k">Leader</span><span>{document.members?.find((m) => m.role === 'CREW_LEADER') ? 'member roster below' : '—'}</span>
          </div>
          <Section title="Members & certifications" hint={`${(document.members || []).length} member(s), ${(document.certs || []).length} cert(s)`}>            <table>
              <thead><tr><th>Member</th><th>Role</th><th>Cert / expiry</th></tr></thead>
              <tbody>
                {(document.members || []).map((m) => (
                  <tr key={m.id}>
                    <td>{[m.first_name, m.last_name].filter(Boolean).join(' ')} <span className="muted">({m.title || '—'})</span></td>
                    <td>{m.role}</td>
                    <td>
                      {(document.certs || []).filter((crt) => crt.person_id === m.person_id).map((crt, i) => (
                        <div key={i}>{crt.cert_type || crt.name} → <PillText value={crt.status} /> <span className="muted">({fmtDate(crt.expires_at)})</span></div>
                      )) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Task history" hint={`${(document.tasks || []).length} task(s)`}>
            <TaskRows tasks={document.tasks} onOpenEntity={onOpenEntity} />
          </Section>
          {document.readiness && <CrewReadiness readiness={document.readiness} onOpenEntity={onOpenEntity} />}
        </div>
        <div>
          <Section title="Checklist executions" hint={`${(document.executions || []).length}`}>
            <ExecRows rows={document.executions} />
          </Section>
        </div>
      </div>
    );
  }
  if (document.entity === 'TASK') {
    const t = document.task || {};
    const target = document.target || {};
    const crew = document.crew;
    return (
      <div className="grid grid-2">
        <div className="card card-pad">
          <b>{document.entity_name}</b>
          <div className="kv mt" style={{ gridTemplateColumns: '130px 1fr', fontSize: 13 }}>
            <span className="k">Type</span><span>{t.task_type}</span>
            <span className="k">Priority</span><span style={{ fontWeight: 700 }}>{t.priority}</span>
            <span className="k">Status</span><span><Pill value={t.status} /></span>
            <span className="k">Result</span><span>{t.result || '—'}</span>
            <span className="k">Crew</span><span>{crew ? `${crew.name} (${crew.crew_code})` : '—'}</span>
            <span className="k">Checklist</span><span>{document.template?.name || '—'}</span>
            <span className="k">Due</span><span>{fmtDateTime(t.due_date)}</span>
            <span className="k">Target</span><span>{target.substation?.name || (target.tower ? `${target.line?.name} · ${target.tower.tower_id}` : target.line?.name) || target.asset?.name || '—'}</span>
            <span className="k">Created</span><span>{fmtDateTime(t.created_at)}</span>
            {t.cancel_reason && <>
              <span className="k">Cancellation record</span>
              <span>{t.cancel_reason} · {t.cancelled_by_name || 'Unknown user'} · {fmtDateTime(t.cancelled_at)}</span>
            </>}
          </div>
          <TargetProfile target={target} readiness={document.dispatch_audit} workflow={document.workflow} />
          <p className="muted mt" style={{ fontSize: 13 }}>{t.description || 'No description.'}</p>
          {document.summary && (
            <div className="grid grid-4 mt" style={{ gap: 8 }}>
              <Mini label="Executions" v={document.summary.executions} />
              <Mini label="Failures" v={document.summary.fail} warn={document.summary.fail > 0} />
              <Mini label="Findings" v={document.summary.findings} />
              <Mini label="Photos" v={document.summary.attachments} />
            </div>
          )}
          {document.dispatch_audit && <DispatchAudit audit={document.dispatch_audit} />}
          <Section title="Findings" hint={`${(document.findings || []).length}`}>
            <FindingsRows findings={document.findings} />
          </Section>
          <Section title="Attachments / photos" hint={`${(document.attachments || []).length}`}>
            <AttachmentsGrid attachments={document.attachments} taskId={t.id} />
          </Section>
          {(document.gps_validations || []).length > 0 && (
            <Section title="GPS validations">
              <GpsRows rows={document.gps_validations} />
            </Section>
          )}
        </div>
        <div>
          <Section title="Checklist executions" hint={`${(document.executions || []).length}`}>
            <ExecRows rows={document.executions} />
          </Section>
        </div>
      </div>
    );
  }
  if (document.entity === 'LINE') {
    const l = document.line || {};
    return (
      <div className="grid grid-2">
        <div className="card card-pad">
          <b>{document.entity_name}</b>
          <div className="kv mt" style={{ gridTemplateColumns: '130px 1fr', fontSize: 13 }}>
            <span className="k">Route</span><span>{document.from_substation?.name} → {document.to_substation?.name}</span>
            <span className="k">Voltage</span><span>{l.voltage_kv} kV</span>
            <span className="k">Length</span><span>{l.length_km} km</span>
            <span className="k">Status</span><span><Pill value={l.operational_status} /></span>
          </div>
          {totals.towers != null && (
            <div className="grid grid-4 mt" style={{ gap: 8 }}>
              <Mini label="Towers" v={totals.towers} />
              <Mini label="Assets" v={totals.assets} />
              <Mini label="Open tasks" v={totals.open_tasks} />
              <Mini label="Overdue" v={totals.overdue_tasks} warn={totals.overdue_tasks > 0} />
            </div>
          )}
          <Section title="Related maintenance tasks" hint={`${totals.tasks ?? (document.tasks || []).length} · ${(document.tasks_past || []).length} past / ${(document.tasks_future || []).length} upcoming`}>
            <TaskRows tasks={document.tasks} onOpenEntity={onOpenEntity} />
          </Section>
          {(document.gps_violations || []).length > 0 && (
            <Section title="GPS violations">
              <GpsRows rows={document.gps_violations} />
            </Section>
          )}
        </div>
        <div>
          <Section title={`Tower fleet (${(document.towers || []).length})`}>
            <table>
              <thead><tr><th>Tower</th><th>Type</th><th>km</th><th>Corrosion</th><th>Parts</th></tr></thead>
              <tbody>{(document.towers || []).map((tw) => (
                <tr key={tw.id}><td className="mono">{tw.tower_id}</td><td>{tw.tower_type}</td><td>{tw.km_marker}</td><td><CondPill rating={tw.corrosion_rating} /></td><td>{tw.component_count ?? 0}</td></tr>
              ))}</tbody>
            </table>
          </Section>
          <Section title="Line assets" hint={`${(document.assets || []).length}`}>
            <table>
              <thead><tr><th>Asset</th><th>Type</th><th>Condition</th></tr></thead>
              <tbody>{(document.assets || []).map((a) => (
                <tr key={a.id} {...(typeof onOpenEntity === 'function' ? { className: 'row-link', title: 'Click to view asset details', onClick: () => onOpenEntity('ASSET_DETAIL', a.id, a.asset_id) } : {})}>
                  <td className="mono">{a.asset_id}</td><td>{a.asset_type}{a.sub_type ? ` (${a.sub_type})` : ''}</td><td><CondPill rating={a.condition_rating} /></td>
                </tr>
              ))}</tbody>
            </table>
          </Section>
          {(document.executions || []).length > 0 && (
            <Section title="Completed maintenance executions">
              <ExecRows rows={document.executions} />
            </Section>
          )}
        </div>
      </div>
    );
  }
  if (document.entity === 'PERSON') {
    const p = document.person || {};
    const perf = document.performance;
    return (
      <div className="grid grid-2">
        <div className="card card-pad">
          <b>{document.entity_name}</b>
          <div className="kv mt" style={{ gridTemplateColumns: '130px 1fr', fontSize: 13 }}>
            <span className="k">Role</span><span>{p.role || '—'}</span>
            <span className="k">Title</span><span>{p.title || '—'}</span>
            <span className="k">Crews</span><span>{(document.crews || []).map((c) => `${c.name} (${c.crew_code})`).join(', ') || '—'}</span>
            <span className="k">Leads</span><span>{(document.led_crews || []).map((c) => c.name).join(', ') || '—'}</span>
          </div>
          {perf && (
            <div className="grid grid-4 mt" style={{ gap: 8 }}>
              <Mini label="Executions" v={perf.tasks} />
              <Mini label="Completed" v={perf.completed} />
              <Mini label="Checklist pass %" v={perf.checklist_pass_rate} />
              <Mini label="Overdue" v={perf.overdue} warn={perf.overdue > 0} />
            </div>
          )}
          <Section title="Certifications" hint={`${(document.certs || []).length}`}>
            <table>
              <thead><tr><th>Cert</th><th>Status</th><th>Expires</th></tr></thead>
              <tbody>
                {(document.certs || []).map((c) => (
                  <tr key={c.id}><td>{c.cert_type}</td><td><Pill value={c.status} /></td><td>{fmtDate(c.expires_at)}</td></tr>
                ))}
                {(document.certs || []).length === 0 && <tr><td colSpan={3} className="muted">No certifications.</td></tr>}
              </tbody>
            </table>
          </Section>
          <Section title="Findings raised" hint={`${(document.findings || []).length}`}>
            <FindingsRows findings={document.findings} />
          </Section>
          {(document.gps_validations || []).length > 0 && (
            <Section title="GPS validations">
              <GpsRows rows={document.gps_validations} />
            </Section>
          )}
        </div>
        <div>
          <Section title="Checklist executions" hint={`${(document.executions || []).length}`}>
            <ExecRows rows={document.executions} />
          </Section>
        </div>
      </div>
    );
  }
  return <pre className="muted" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(document, null, 2)}</pre>;
}

function Warnings({ items }) {
  if (!items || !items.length) return null;
  return (
    <div className="alert mt" style={{ fontSize: 12, background: '#fffbeb' }}>
      {items.map((w, i) => <div key={i}>{w}</div>)}
    </div>
  );
}

// Dispatch readiness for a task: the checklist's derived team / skill / cert
// requirements, the resolved crew's coverage and the advisory equipment list.
function DispatchAudit({ audit }) {
  const req = audit.requirements;
  const crew = audit.crew;
  if (!req) {
    return (
      <Section title="Dispatch readiness">
        <div className="muted" style={{ fontSize: 13 }}>No checklist template is linked, so no capability requirements were derived.</div>
      </Section>
    );
  }
  return (
    <Section title="Dispatch readiness" hint={req.skills.join(', ') || '—'}>
      <div className="grid grid-2 mt" style={{ gap: 8 }}>
        <Mini label="Team size" v={req.min_team_size || '—'} />
        <Mini label="Required certs" v={(req.required_certs || []).length} warn={audit.eligible === false} />
      </div>
      <div className="kv mt" style={{ gridTemplateColumns: '150px 1fr', fontSize: 13 }}>
        <span className="k">Crew</span><span>{crew ? `${crew.name} (${crew.crew_code})` : '—'}</span>
        <span className="k">Resolved via</span><span>{crew ? crew.resolved_via : '—'}</span>
        <span className="k">Team called for</span><span>{req.team.join('; ') || '—'}</span>
        <span className="k">Skills required</span><span>{req.skills.join(', ') || '—'}</span>
        <span className="k">Required certs</span><span>{req.required_certs.join(', ') || '—'}</span>
        <span className="k">Recommended</span><span>{req.recommended_certs.join(', ') || '—'}</span>
      </div>
      {crew ? (
        <p className="mt" style={{ fontSize: 13 }}>
          {audit.eligible === true ? <span className="ok">Capability matched</span> : <span className="warn">Warnings — review before dispatch</span>}
        </p>
      ) : <p className="muted mt" style={{ fontSize: 13 }}>No crew is resolved for this task yet.</p>}
      {(audit.missing_skills || []).length > 0 && <div style={{ fontSize: 13 }}>Missing skills: {audit.missing_skills.join(', ')}</div>}
      {audit.team_shortfall > 0 && <div style={{ fontSize: 13 }}>Team short by {audit.team_shortfall}</div>}
      <Warnings items={audit.warnings} />
    </Section>
  );
}

// Crew readiness: roster/certificate coverage, execution KPIs and the
// per-open-task gaps plus the equipment the crew would need to secure.
function CrewReadiness({ readiness, onOpenEntity }) {
  const p = readiness.performance || {};
  const cs = readiness.cert_status || {};
  const clickable = typeof onOpenEntity === 'function';
  return (
    <Section title="Crew readiness" hint={`${cs.valid ?? 0}/${cs.total ?? 0} cert(s) valid`}>
      <div className="grid grid-4 mt" style={{ gap: 8 }}>
        <Mini label="Members" v={readiness.crew?.member_count ?? 0} />
        <Mini label="Valid certs" v={cs.valid ?? 0} />
        <Mini label="Expired certs" v={cs.expired ?? 0} warn={(cs.expired ?? 0) > 0} />
        <Mini label="At-risk tasks" v={readiness.at_risk_tasks ?? 0} warn={(readiness.at_risk_tasks ?? 0) > 0} />
      </div>
      <div className="kv mt" style={{ gridTemplateColumns: '150px 1fr', fontSize: 13 }}>
        <span className="k">Completion rate</span><span>{p.completion_rate ?? 0}% ({p.completed ?? 0}/{p.tasks ?? 0})</span>
        <span className="k">On-time rate</span><span>{p.on_time_rate ?? 0}% ({p.on_time ?? 0})</span>
        <span className="k">Findings / GPS</span><span>{p.findings ?? 0} / {p.gps_violations ?? 0}</span>
        <span className="k">Roles</span><span>{(readiness.roles || []).join(', ') || '—'}</span>
        <span className="k">Equipment to secure</span><span>{(readiness.equipment_to_secure || []).join(', ') || '—'}</span>
      </div>
      <Warnings items={readiness.warnings} />
      {(readiness.open_tasks || []).length > 0 && (
        <table className="mt">
          <thead><tr><th>Open task</th><th>Status</th><th>Ready</th><th>Gaps</th></tr></thead>
          <tbody>{readiness.open_tasks.map((a) => {
            const gaps = [
              ...(a.missing_skills || []).map((s) => `skill: ${s}`),
              ...(a.missing_certs || []).map((c) => `cert: ${c}`),
              ...((a.equipment_to_secure || []).length ? [`equipment: ${a.equipment_to_secure.join(', ')}`] : []),
            ];
            return (
              <tr key={a.task_id} {...(clickable ? { className: 'row-link', title: 'Click to view task details', onClick: () => onOpenEntity('TASK_DETAIL', a.task_id, a.task_number) } : {})}>
                <td><b>{a.task_number}</b><br /><span className="muted">{a.title}</span></td>
                <td><Pill value={a.status} /></td>
                <td>{a.eligible === true ? <span className="ok">Ready</span> : a.eligible === false ? <span className="warn">Warnings</span> : <span className="muted">—</span>}</td>
                <td className="muted" style={{ fontSize: 12 }}>{gaps.join('; ') || '—'}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </Section>
  );
}

function Mini({ label, v, warn }) {  return (
    <div className="card card-pad" style={{ padding: '8px 10px', textAlign: 'center', borderColor: warn ? '#fca5a5' : undefined }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: warn ? '#dc2626' : 'inherit' }}>{v ?? 0}</div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
    </div>
  );
}

function TaskRows({ tasks, onOpenEntity }) {
  if (!tasks || !tasks.length) return <div className="muted" style={{ fontSize: 13 }}>None</div>;
  const clickable = typeof onOpenEntity === 'function';
  return (
    <table>
      <thead><tr><th>Task</th><th>Status</th><th>Progress</th><th>Result</th><th>Due</th><th>Crew</th><th>Findings</th></tr></thead>
      <tbody>{tasks.map((t) => (
        <tr key={t.id} {...(clickable ? { className: 'row-link', title: 'Click to view task details', onClick: () => onOpenEntity('TASK_DETAIL', t.id, t.task_number) } : {})}>
          <td><b>{t.task_number}</b><br /><span className="muted">{t.title}</span></td>
          <td><Pill value={t.status} /></td>
          <td>{t.progress_graded > 0 ? <Progress pct={t.progress_pct} graded={t.progress_graded} passed={t.progress_passed} /> : <span className="muted">—</span>}</td>
          <td>{t.result || '—'}</td>
          <td>{fmtDate(t.due_date)}</td>
          <td>{t.crew ? t.crew.crew_code : '—'}</td>
          <td>{t.findings_count || 0}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function ExecRows({ rows }) {
  if (!rows || !rows.length) return <div className="muted" style={{ fontSize: 13 }}>No executions</div>;
  return (
    <div>
      {rows.map((e) => {
        const fails = (e.items || []).filter((i) => i.result === 'FAIL');
        return (
          <div key={e.id} className="card card-pad" style={{ padding: 10, marginBottom: 8 }}>
            <div className="spread" style={{ flexWrap: 'wrap', gap: '4px 10px' }}>
              <b className="mono">EX-{String(e.id).padStart(5, '0')}</b>
              <span className="muted">{e.template_name || `template ${e.template_id}`}</span>
              <Pill value={e.result || 'INCOMPLETE'} />
              <span className="muted">{fmtDateTime(e.submitted_at)}</span>
              <span className="muted">{(e.items || []).length} item(s) · {(e.items || []).filter((i) => i.result === 'PASS').length} pass</span>
            </div>
            {e.notes && <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{e.notes}</p>}
            {(e.items || []).length > 0 && (
              <table style={{ marginTop: 6 }}>
                <thead><tr><th>#</th><th>Instruction</th><th>Result</th><th>Response recorded</th></tr></thead>
                <tbody>{(e.items || []).map((it) => (
                  <tr key={it.id}>
                    <td>{it.sequence}</td>
                    <td>{it.instruction}{it.critical_step ? <span className="bad" style={{ fontSize: 11, marginLeft: 6 }}>critical</span> : null}</td>
                    <td>{it.result === 'FAIL' ? <span style={{ color: '#dc2626', fontWeight: 700 }}>{formatChecklistResult(it.result)}</span> : it.result === 'PASS' ? <span style={{ color: '#15803d', fontWeight: 700 }}>{formatChecklistResult(it.result)}</span> : <span className="muted">{formatChecklistResult(it.result)}</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{formatChecklistResponse(it)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {fails.length > 0 && <div className="alert alert-error mt" style={{ fontSize: 12 }}>{fails.length} failing item(s) on this execution</div>}
          </div>
        );
      })}
    </div>
  );
}

function FindingsRows({ findings }) {
  if (!findings || !findings.length) return <div className="muted" style={{ fontSize: 13 }}>No findings recorded</div>;
  const sevColor = { INFO: '#64748b', LOW: '#22c55e', MEDIUM: '#f59e0b', HIGH: '#f97316', CRITICAL: '#dc2626' };
  return (
    <div>
      {findings.map((f) => (
        <div key={f.id} className="card card-pad" style={{ padding: 10, marginBottom: 8, borderLeft: `4px solid ${sevColor[f.severity] || '#64748b'}` }}>
          <div className="spread" style={{ flexWrap: 'wrap', gap: '4px 10px' }}>
            <b>{f.title}</b>
            <span className="pill" style={{ background: '#f1f5f9', color: sevColor[f.severity], fontWeight: 700 }}>{f.severity}</span>
          </div>
          {f.detail && <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{f.detail}</p>}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{f.created_by_name || '—'} · {fmtDateTime(f.captured_at)}{f.lat != null ? ` · ${Number(f.lat).toFixed(5)}, ${Number(f.lng).toFixed(5)}` : ''}</div>
        </div>
      ))}
    </div>
  );
}

function GpsRows({ rows }) {
  return (
    <table>
      <thead><tr><th>Result</th><th>Measured</th><th>Distance</th><th>Tolerance</th><th>When</th></tr></thead>
      <tbody>{rows.map((g, i) => (
        <tr key={i}>
          <td><b style={{ color: g.result === 'PASS' ? '#15803d' : g.result === 'FAIL' ? '#dc2626' : '#92400e' }}>{g.result}</b></td>
          <td className="mono">{g.measured_lat != null ? `${Number(g.measured_lat).toFixed(6)}, ${Number(g.measured_lng).toFixed(6)}` : '—'}</td>
          <td>{g.distance_m != null ? `${Math.round(g.distance_m)} m` : '—'}</td>
          <td>{g.tolerance_m != null ? `${g.tolerance_m} m` : '—'}</td>
          <td>{fmtDateTime(g.validated_at)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function AttachmentsGrid({ attachments, taskId }) {
  if (!attachments || !attachments.length) return <div className="muted" style={{ fontSize: 13 }}>No photos / files</div>;
  return (
    <div className="grid grid-3" style={{ gap: 8 }}>
      {attachments.map((a) => (
        <Thumb key={a.id} a={a} taskId={taskId} />
      ))}
    </div>
  );
}

function Thumb({ a, taskId }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);
  const isImg = String(a.mime || '').startsWith('image/');
  useEffect(() => {
    if (!isImg) return;
    let revoke;
    fetch(`/api/tasks/${taskId}/attachments/${a.id}/file`, { headers: { Authorization: `Bearer ${getStoredToken()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      })
      .catch((e) => setErr(e.message));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, isImg]);
  const openFile = async () => {
    try {
      const r = await fetch(`/api/tasks/${taskId}/attachments/${a.id}/file`, { headers: { Authorization: `Bearer ${getStoredToken()}` } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      window.open(u, '_blank');
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="card" style={{ padding: 6 }}>
      {isImg ? (
        url ? <img src={url} alt={a.file_name} style={{ width: '100%', height: 80, objectFit: 'cover', borderRadius: 6 }} onClick={openFile} /> : <div className="muted" style={{ fontSize: 11 }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span className="pill" style={{ background: '#e0f2fe', color: '#0369a1' }}>{a.mime || 'FILE'}</span>
          <button className="btn btn-sm" onClick={openFile}>View</button>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{a.file_name} · {Math.round((a.size_bytes || 0) / 1024)} KB</div>
      {err && <div className="muted" style={{ fontSize: 11, color: '#dc2626' }}>{err}</div>}
    </div>
  );
}
