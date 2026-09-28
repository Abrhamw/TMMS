import { Page } from '../components';
import { getStoredUser } from '../auth';

const BANDS = [
  { band: 'Corporate HQ / Business Unit', units: 'CEO, Transmission Business Unit, Divisions', role: 'EXECUTIVE', fn: 'Company-wide oversight', bucket: 'Oversight' },
  { band: 'Regional Directorate', units: 'Central 1 … Western Region', role: 'REGION_DIRECTOR', fn: 'Owns the region', bucket: 'Assign + Verify' },
  { band: 'Regional Department', units: 'Substation O&M, Line & OPGW', role: 'REGION_MANAGER', fn: 'Commands the department', bucket: 'Assign + Verify' },
  { band: 'Operational Technology', units: 'OT (SCADA/RTU, protection, metering, DC), Protection & Control, SCADA & Automation, Telecom & Fiber', role: 'OT_MANAGER', fn: 'Commands the OT department', bucket: 'Assign + Verify' },
  { band: 'Substation Unit', units: 'Substation Management', role: 'SUBSTATION_MANAGER', fn: 'Commands the substation', bucket: 'Assign + Verify' },
  { band: 'Field Crew', units: 'O&M crew, line crew, functional crew', role: 'CREW_LEAD / CREW_MEMBER', fn: 'Executes the work', bucket: 'Execute' },
  { band: 'Planning cell', units: 'Maintenance planning', role: 'PLANNER', fn: 'Plans the programme', bucket: 'Schedule' },
  { band: 'Dispatch desk', units: 'Regional dispatch', role: 'DISPATCHER', fn: 'Dispatches work', bucket: 'Assign' },
  { band: 'Audit', units: 'Independent audit', role: 'AUDITOR', fn: 'Independent review', bucket: 'Review evidence' },
];

const BUCKETS = [
  { key: 'execute', label: 'My work — execute', owner: 'Crew lead, Crew member', what: 'Tasks assigned to your crew. Start the work, capture readings, GPS and photos; the crew lead submits.' },
  { key: 'schedule', label: 'To schedule', owner: 'Planner (and managers)', what: 'Draft work waiting to go on the calendar.' },
  { key: 'assign', label: 'To assign', owner: 'Dispatcher, Region/Director, managers', what: 'Planned work with no crew yet. Pick a crew inside your authority.' },
  { key: 'verify', label: 'To verify', owner: 'Manager, Supervisor, Director', what: 'Submitted field work waiting for sign-off. Checklist and GPS gates apply.' },
  { key: 'emergency', label: 'Emergency', owner: 'Managers, Planner/Dispatcher, non-region officers', what: 'Urgent failure raised as an EMERGENCY task; created assigned so it is dispatched at once.' },
  { key: 'oversight', label: 'Oversight', owner: 'Executive, Admin, Viewer', what: 'Exceptions only: critical overdue work, GPS violations, expiring certifications.' },
  { key: 'audit', label: 'Review evidence', owner: 'Auditor', what: 'Pending verifications and evidence. Read-only.' },
];

const STAGES = [
  { stage: 'DRAFT', owner: 'Planner', action: 'schedule', tone: '#6b7280' },
  { stage: 'SCHEDULED', owner: 'Planner', action: 'assign', tone: '#2563eb' },
  { stage: 'ASSIGNED', owner: 'Dispatcher / Manager', action: 'start', tone: '#7c3aed' },
  { stage: 'IN PROGRESS', owner: 'Crew', action: 'capture → submit', tone: '#0891b2' },
  { stage: 'PENDING VERIFICATION', owner: 'Manager / Director', action: 'verify', tone: '#d97706' },
  { stage: 'COMPLETED', owner: 'Manager / Director', action: 'close', tone: '#16a34a' },
];

export default function OperatingModel() {
  const me = getStoredUser();
  return (
    <Page title="Operating model" crumbs="TMMS / Governance">
      <div className="card card-pad mb">
        <b>One function per role, one task bucket per function.</b>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          The organisation, the account roles and the task views follow the same model, so
          scheduling, assignment, execution and verification never appear mixed in one list.
          {me ? ` You are signed in as ${me.role}.` : ''}
        </div>
      </div>

      <h3 className="section-title">1 · Organisation band → role → function</h3>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Organisation band</th><th>Units</th><th>Role</th><th>Function</th><th>Leads with</th></tr></thead>
            <tbody>
              {BANDS.map((b) => (
                <tr key={b.band}>
                  <td><b>{b.band}</b></td>
                  <td className="muted">{b.units}</td>
                  <td><span className="mono">{b.role}</span></td>
                  <td>{b.fn}</td>
                  <td><span className="infra-chip">{b.bucket}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 className="section-title mt">2 · Task buckets (kept separate)</h3>
      <div className="grid grid-3">
        {BUCKETS.map((b) => (
          <div key={b.key} className="card card-pad">
            <div className="spread" style={{ alignItems: 'baseline' }}>
              <b>{b.label}</b>
            </div>
            <div className="muted" style={{ fontSize: 11, margin: '2px 0 6px' }}>Owner: {b.owner}</div>
            <div style={{ fontSize: 12 }}>{b.what}</div>
          </div>
        ))}
      </div>

      <h3 className="section-title mt">3 · Lifecycle and who owns each step</h3>
      <div className="card card-pad">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {STAGES.map((s, i) => (
            <span key={s.stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span style={{ background: s.tone, color: '#fff', borderRadius: 6, padding: '8px 12px', fontSize: 12, minWidth: 120, textAlign: 'center' }}>
                <b>{s.stage}</b>
                <div style={{ opacity: 0.85, fontSize: 11 }}>{s.owner} · {s.action}</div>
              </span>
              {i < STAGES.length - 1 && <span className="muted">→</span>}
            </span>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Hold / resume and reopen loop back into IN PROGRESS. Cancel is available to managers at any open stage.
          An EMERGENCY task is born ASSIGNED and skips DRAFT/SCHEDULED.
        </div>
      </div>
    </Page>
  );
}
