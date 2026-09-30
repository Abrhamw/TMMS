import { useEffect, useId, useState } from 'react';
import { fmtDate, fmtDateTime, STATUS_COLORS } from '../api';
import { Pill, CondPill, Progress } from '../components';
import { BarRow } from '../components/InfraVisuals';
import { getStoredToken } from '../auth';
import { formatChecklistResponse, formatChecklistResult } from '../checklistFormat';
import DocumentGeo from './DocumentGeo';
import TargetProfile from './TargetProfile';
import AnalyticsBlock from './AnalyticsBlock';

// Detail-document renderer for the entity profiles (ASSET / CREW / TASK / LINE /
// PERSON). Laid out as a single full-width column so a wide table can never
// collide with a neighbouring column (the old two-column grid let report tables
// overflow into each other). A light "on this page" strip jumps between the
// sections, and every checklist execution is listed with its title and result
// while its item detail is shown only when the reader selects it.
export default function DocumentReport({ data, onOpenEntity }) {
  const uid = useId();
  if (!data) return <div className="muted">No data</div>;
  const metricRows = (data.rows || []).filter((r) => r && 'label' in r);
  const document = data.document || {};
  const sid = (key) => `${uid}-${key}`;
  return (
    <div className="profile">
      {data.analytics ? <AnalyticsBlock a={data.analytics} /> : null}
      {metricRows.length > 0 && (
        <div className="tbl-wrap mb">
          <table>
            <thead><tr><th>Metric</th><th>Value</th></tr></thead>
            <tbody>{metricRows.map((r, i) => <tr key={i}><td>{r.label}</td><td><b>{r.value}</b></td></tr>)}</tbody>
          </table>
        </div>
      )}
      {(document.entity === 'ASSET' || document.entity === 'LINE') && (
        <section id={sid('map')} className="card card-pad doc-sec">
          <h4 className="doc-sec-title">Location map</h4>
          <DocumentGeo document={document} showTitle={false} />
        </section>
      )}
      <DocumentSections document={document} onOpenEntity={onOpenEntity} sid={sid} />
    </div>
  );
}

const scrollToSec = (id) => {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Long entity lists (a transmission line can carry dozens of tasks, towers and
// assets) are capped in the printed profile so the document stays readable.
// The analytics header and metric table always carry the full totals.
const LIST_CAP = 25;
function CappedNote({ shown, total, label }) {
  if (!total || total <= shown) return null;
  return <div className="muted mt" style={{ fontSize: 12 }}>Showing {shown} of {total} {label} — the full list is available in the application.</div>;
}

// Renders the ordered section list plus the "on this page" jump strip. Items are
// filtered to the sections that actually carry data for this entity.
function Sections({ items }) {
  const real = items.filter((it) => it && it.body);
  if (!real.length) return null;
  return (
    <>
      {real.length >= 3 && (
        <nav className="doc-toc no-print" aria-label="Document sections">
          <span className="doc-toc-label">On this page</span>
          {real.map((it) => (
            <button key={it.key} type="button" className="doc-toc-link" onClick={() => scrollToSec(it.id)}>{it.title}</button>
          ))}
        </nav>
      )}
      {real.map((it) => (
        <section key={it.key} id={it.id} className="card card-pad doc-sec">
          <h4 className="doc-sec-title">{it.title}{it.hint ? <span className="muted doc-sec-hint">{it.hint}</span> : null}</h4>
          {it.body}
        </section>
      ))}
    </>
  );
}

function PillText({ value }) {
  const color = STATUS_COLORS[value];
  return color ? <span style={{ fontWeight: 700, color }}>{value}</span> : <b>{value}</b>;
}

function DocumentSections({ document, onOpenEntity, sid }) {
  if (!document) return <div className="muted">No document data</div>;
  const totals = document.totals || {};
  if (document.entity === 'ASSET') {
    return (
      <Sections items={[
        { key: 'components', id: sid('components'), title: 'Components / parts', body: (document.components || []).length > 0 && (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Part</th><th>Material</th><th>Qty</th><th>Condition</th></tr></thead>
              <tbody>{document.components.map((c) => (
                <tr key={c.id}><td>{c.component_type} · {c.name}</td><td>{c.material || '—'}</td><td>{c.quantity}</td><td><CondPill rating={c.condition_rating ?? c.corrosion_rating} /></td></tr>
              ))}</tbody>
            </table>
          </div>
        ) },
        { key: 'future', id: sid('future'), title: 'Upcoming work', hint: `${(document.tasks_future || []).length} task(s)`, body: (document.tasks_future || []).length > 0 && <TaskRows tasks={document.tasks_future} onOpenEntity={onOpenEntity} /> },
        { key: 'past', id: sid('past'), title: 'Historical tasks', hint: `${(document.tasks_past || []).length} task(s)`, body: (document.tasks_past || []).length > 0 && <TaskRows tasks={document.tasks_past} onOpenEntity={onOpenEntity} /> },
        { key: 'history', id: sid('history'), title: 'Maintenance history', body: (document.history || []).length > 0 && (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When</th><th>Event</th><th>Crew</th></tr></thead>
              <tbody>{document.history.map((e) => (
                <tr key={e.id}><td>{fmtDateTime(e.performed_at)}</td><td>{e.event_type} {e.task_id ? <span className="muted">#{e.task_id}</span> : null}</td><td>{e.crew_name || e.crew_code || '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        ) },
        { key: 'gps', id: sid('gps'), title: 'GPS violations', hint: `${(document.gps_violations || []).length} event(s)`, body: (document.gps_violations || []).length > 0 && <GpsRows rows={document.gps_violations} /> },
        { key: 'exec', id: sid('exec'), title: 'Checklist executions', hint: `${(document.executions || []).length}`, body: <ExecRows rows={document.executions} /> },
      ]} />
    );
  }
  if (document.entity === 'CREW') {
    return (
      <Sections items={[
        { key: 'members', id: sid('members'), title: 'Members & certifications', hint: `${(document.members || []).length} member(s), ${(document.certs || []).length} cert(s)`, body: (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Member</th><th>Role</th><th>Cert / expiry</th></tr></thead>
              <tbody>
                {(document.members || []).map((m) => (
                  <tr key={m.id}>
                    <td>{[m.first_name, m.last_name].filter(Boolean).join(' ')} <span className="muted">({m.title || '—'})</span></td>
                    <td>{m.role}</td>
                    <td>
                      {(document.certs || []).filter((crt) => crt.person_id === m.person_id).map((crt, i) => (
                        <div key={i}>{crt.cert_type || crt.name} → <PillText value={crt.status} /> <span className="muted">({fmtDate(crt.expires_at)})</span></div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) },
        { key: 'tasks', id: sid('tasks'), title: 'Task history', hint: `${(document.tasks || []).length} task(s)`, body: (document.tasks || []).length > 0 ? <TaskRows tasks={document.tasks} onOpenEntity={onOpenEntity} /> : <div className="muted" style={{ fontSize: 13 }}>None</div> },
        { key: 'readiness', id: sid('readiness'), title: 'Crew readiness', body: document.readiness && <CrewReadiness readiness={document.readiness} onOpenEntity={onOpenEntity} /> },
        { key: 'exec', id: sid('exec'), title: 'Checklist executions', hint: `${(document.executions || []).length}`, body: <ExecRows rows={document.executions} /> },
      ]} />
    );
  }
  if (document.entity === 'TASK') {
    const t = document.task || {};
    const target = document.target || {};
    return (
      <Sections items={[
        { key: 'target', id: sid('target'), title: 'Target profile', body: <TargetProfile target={target} readiness={document.dispatch_audit} workflow={document.workflow} /> },
        { key: 'desc', id: sid('desc'), title: 'Description', body: <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t.description || 'No description.'}</p> },
        {
          key: 'summary', id: sid('summary'), title: 'Outcome summary',
          body: document.summary && (
            <div className="grid grid-4" style={{ gap: 8 }}>
              <Mini label="Executions" v={document.summary.executions} />
              <Mini label="Failures" v={document.summary.fail} warn={document.summary.fail > 0} />
              <Mini label="Findings" v={document.summary.findings} />
              <Mini label="Photos" v={document.summary.attachments} />
            </div>
          ),
        },
        { key: 'audit', id: sid('audit'), title: 'Dispatch readiness', body: document.dispatch_audit && <DispatchAudit audit={document.dispatch_audit} /> },
        { key: 'findings', id: sid('findings'), title: 'Findings', hint: `${(document.findings || []).length}`, body: <FindingsRows findings={document.findings} /> },
        { key: 'attachments', id: sid('attachments'), title: 'Attachments / photos', hint: `${(document.attachments || []).length}`, body: <AttachmentsGrid attachments={document.attachments} taskId={t.id} /> },
        { key: 'gps', id: sid('gps'), title: 'GPS validations', body: (document.gps_validations || []).length > 0 && <GpsRows rows={document.gps_validations} /> },
        { key: 'exec', id: sid('exec'), title: 'Checklist executions', hint: `${(document.executions || []).length}`, body: <ExecRows rows={document.executions} /> },
      ]} />
    );
  }
  if (document.entity === 'LINE') {
    const openStates = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
    const lineTasks = [...(document.tasks || [])].sort((a, b) => {
      const ra = openStates.includes(a.status) ? 0 : 1;
      const rb = openStates.includes(b.status) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return String(a.due_date || '').localeCompare(String(b.due_date || ''));
    });
    const towerList = document.towers || [];
    const assetList = document.assets || [];
    const tasksShown = lineTasks.slice(0, LIST_CAP);
    const towersShown = towerList.slice(0, LIST_CAP);
    const assetsShown = assetList.slice(0, LIST_CAP);
    return (
      <Sections items={[
        { key: 'tasks', id: sid('tasks'), title: 'Related maintenance tasks', hint: `${totals.tasks ?? lineTasks.length} · ${(document.tasks_past || []).length} past / ${(document.tasks_future || []).length} upcoming`, body: (
          <div>
            <TaskRows tasks={tasksShown} onOpenEntity={onOpenEntity} />
            <CappedNote shown={tasksShown.length} total={lineTasks.length} label="tasks" />
          </div>
        ) },
        { key: 'gps', id: sid('gps'), title: 'GPS violations', body: (document.gps_violations || []).length > 0 && <GpsRows rows={document.gps_violations} /> },
        { key: 'towers', id: sid('towers'), title: `Tower fleet (${towerList.length})`, body: (
          <div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Tower</th><th>Type</th><th>km</th><th>Corrosion</th><th>Parts</th></tr></thead>
                <tbody>{towersShown.map((tw) => (
                  <tr key={tw.id}><td className="mono">{tw.tower_id}</td><td>{tw.tower_type}</td><td>{tw.km_marker}</td><td><CondPill rating={tw.corrosion_rating} /></td><td>{tw.component_count ?? 0}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <CappedNote shown={towersShown.length} total={towerList.length} label="towers" />
          </div>
        ) },
        { key: 'assets', id: sid('assets'), title: 'Line assets', hint: `${assetList.length}`, body: (
          <div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Asset</th><th>Type</th><th>Condition</th></tr></thead>
                <tbody>{assetsShown.map((a) => (
                  <tr key={a.id} {...(typeof onOpenEntity === 'function' ? { className: 'row-link', title: 'Click to view asset details', onClick: () => onOpenEntity('ASSET_DETAIL', a.id, a.asset_id) } : {})}>
                    <td className="mono">{a.asset_id}</td><td>{a.asset_type}{a.sub_type ? ` (${a.sub_type})` : ''}</td><td><CondPill rating={a.condition_rating} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <CappedNote shown={assetsShown.length} total={assetList.length} label="assets" />
          </div>
        ) },
        { key: 'exec', id: sid('exec'), title: 'Completed maintenance executions', hint: `${(document.executions || []).length}`, body: (document.executions || []).length > 0 ? <ExecRows rows={document.executions} /> : <div className="muted" style={{ fontSize: 13 }}>None</div> },
      ]} />
    );
  }
  if (document.entity === 'PERSON') {
    const perf = document.performance;
    return (
      <Sections items={[
        {
          key: 'perf', id: sid('perf'), title: 'Performance',
          body: perf && (
            <div className="grid grid-4" style={{ gap: 8 }}>
              <Mini label="Executions" v={perf.tasks} />
              <Mini label="Completed" v={perf.completed} />
              <Mini label="Checklist pass %" v={perf.checklist_pass_rate} />
              <Mini label="Overdue" v={perf.overdue} warn={perf.overdue > 0} />
            </div>
          ),
        },
        { key: 'certs', id: sid('certs'), title: 'Certifications', hint: `${(document.certs || []).length}`, body: (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Cert</th><th>Status</th><th>Expires</th></tr></thead>
              <tbody>
                {(document.certs || []).map((c) => (
                  <tr key={c.id}><td>{c.cert_type}</td><td><Pill value={c.status} /></td><td>{fmtDate(c.expires_at)}</td></tr>
                ))}
                {(document.certs || []).length === 0 && <tr><td colSpan={3} className="muted">No certifications.</td></tr>}
              </tbody>
            </table>
          </div>
        ) },
        { key: 'findings', id: sid('findings'), title: 'Findings raised', hint: `${(document.findings || []).length}`, body: <FindingsRows findings={document.findings} /> },
        { key: 'gps', id: sid('gps'), title: 'GPS validations', body: (document.gps_validations || []).length > 0 && <GpsRows rows={document.gps_validations} /> },
        { key: 'exec', id: sid('exec'), title: 'Checklist executions', hint: `${(document.executions || []).length}`, body: <ExecRows rows={document.executions} /> },
      ]} />
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
// The profile wraps this in its own section header, so no inner title here.
function DispatchAudit({ audit }) {
  const req = audit.requirements;
  const crew = audit.crew;
  if (!req) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>No checklist template is linked, so no capability requirements were derived.</div>
    );
  }
  return (
    <div>
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
    </div>
  );
}

// Crew readiness: roster/certificate coverage, execution KPIs and the
// per-open-task gaps plus the equipment the crew would need to secure.
function CrewReadiness({ readiness, onOpenEntity }) {
  const p = readiness.performance || {};
  const cs = readiness.cert_status || {};
  const clickable = typeof onOpenEntity === 'function';
  return (
    <div>
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
        <div className="tbl-wrap mt">
          <table>
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
        </div>
      )}
    </div>
  );
}

function Mini({ label, v, warn }) {
  return (
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
    <div className="tbl-wrap">
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
    </div>
  );
}

// Every execution is listed with its title and result so the report is complete.
// The checklist item detail is only rendered for executions the reader selects,
// which keeps the default profile compact (and the printout short).
function ExecRows({ rows }) {
  const [selected, setSelected] = useState(() => new Set());
  if (!rows || !rows.length) return <div className="muted" style={{ fontSize: 13 }}>No executions</div>;
  const allSelected = rows.every((e) => selected.has(e.id));
  const toggle = (id) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const passCount = rows.filter((e) => e.result === 'PASS').length;
  const failCount = rows.filter((e) => e.result === 'FAIL').length;
  const otherCount = rows.length - passCount - failCount;
  return (
    <div className="exec-list">
      <div className="exec-outcomes">
        <BarRow label="Passed" value={passCount} max={rows.length} color="#16a34a" />
        <BarRow label="Failed" value={failCount} max={rows.length} color="#dc2626" />
        <BarRow label="Incomplete" value={otherCount} max={rows.length} color="#d97706" />
      </div>
      <div className="exec-tools no-print">
        <span className="muted">All executions are listed with title and result. Select an execution to include its checklist detail in the report.</span>
        <button type="button" className="btn btn-sm" onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map((e) => e.id)))}>
          {allSelected ? 'Hide all details' : 'Show all details'}
        </button>
      </div>
      {rows.map((e) => {
        const show = selected.has(e.id);
        const items = e.items || [];
        const pass = items.filter((i) => i.result === 'PASS').length;
        const fails = items.filter((i) => i.result === 'FAIL');
        return (
          <div key={e.id} className={'exec-card card' + (show ? ' open' : '')}>
            <div className="exec-head">
              <label className="exec-toggle no-print" title="Include checklist detail for this execution">
                <input type="checkbox" checked={show} onChange={() => toggle(e.id)} />
                <span className="sr-only">Include detail</span>
              </label>
              <div className="exec-title">
                <b className="mono">EX-{String(e.id).padStart(5, '0')}</b>
                <span>{e.template_name || `template ${e.template_id}`}</span>
              </div>
              <div className="exec-meta">
                <Pill value={e.result || 'INCOMPLETE'} />
                <span className="muted">{fmtDateTime(e.submitted_at)}</span>
                <span className="muted">{items.length} item(s) · {pass} pass</span>
                <button type="button" className="btn btn-xs no-print" onClick={() => toggle(e.id)}>{show ? 'Hide detail' : 'Show detail'}</button>
              </div>
            </div>
            {e.notes && <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{e.notes}</p>}
            {show && (
              <>
                {items.length > 0 ? (
                  <div className="tbl-wrap">
                    <table style={{ marginTop: 6 }}>
                      <thead><tr><th>#</th><th>Instruction</th><th>Result</th><th>Response recorded</th></tr></thead>
                      <tbody>{items.map((it) => (
                        <tr key={it.id}>
                          <td>{it.sequence}</td>
                          <td>{it.instruction}{it.critical_step ? <span className="bad" style={{ fontSize: 11, marginLeft: 6 }}>critical</span> : null}</td>
                          <td>{it.result === 'FAIL' ? <span style={{ color: '#dc2626', fontWeight: 700 }}>{formatChecklistResult(it.result)}</span> : it.result === 'PASS' ? <span style={{ color: '#15803d', fontWeight: 700 }}>{formatChecklistResult(it.result)}</span> : <span className="muted">{formatChecklistResult(it.result)}</span>}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{formatChecklistResponse(it)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                ) : <div className="muted" style={{ fontSize: 12 }}>No checklist items recorded on this execution.</div>}
                {fails.length > 0 && <div className="alert alert-error mt" style={{ fontSize: 12 }}>{fails.length} failing item(s) on this execution</div>}
              </>
            )}
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
          {(f.asset_name || f.tower_code || f.equipment_name || f.checklist_item_instruction) && (
            <div className="finding-links">
              {f.asset_name && <span className="patch-chip">Asset: {f.asset_name}</span>}
              {f.tower_code && <span className="patch-chip">Tower: {f.tower_code}</span>}
              {f.equipment_name && <span className="patch-chip">Equipment: {f.equipment_name}</span>}
              {f.checklist_item_instruction && <span className="patch-chip" title={f.checklist_item_instruction}>Item: {f.checklist_item_instruction}</span>}
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{f.created_by_name || '—'} · {fmtDateTime(f.captured_at)}{f.lat != null ? ` · ${Number(f.lat).toFixed(5)}, ${Number(f.lng).toFixed(5)}` : ''}</div>
        </div>
      ))}
    </div>
  );
}

function GpsRows({ rows }) {
  return (
    <div className="tbl-wrap">
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
    </div>
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
          <button className="btn btn-sm no-print" onClick={openFile}>Open</button>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{a.file_name} · {Math.round((a.size_bytes || 0) / 1024)} KB</div>
      {err && <div className="muted" style={{ fontSize: 11, color: '#dc2626' }}>{err}</div>}
    </div>
  );
}
