import { Modal, Pill, PrintButton } from '../components';
import { fmtDateTime } from '../api';
import { formatChecklistResponse, executionTitle } from '../checklistFormat';
import TargetProfile from './TargetProfile';

// The step-by-step record of one field checklist execution: the asset and
// infrastructure it was carried out on with a route map of the location, the
// dispatch notes (missed certifications, equipment to secure) and who ran it,
// then every recorded reading. Shared by the task detail, the crew work panel
// and the checklists page, so the wording and layout cannot drift.
export function ExecutionDetailBody({ exec }) {
  return (
    <>
      <TargetProfile
        target={exec.target}
        readiness={exec.readiness}
        workflow={{
          created_by: exec.created_by_name,
          assigned_by: exec.assigned_by_name,
          executed_by: exec.executed_by_name,
          verified_by: exec.verified_by_name,
        }}
      />
      <div className="muted mb mt" style={{ fontSize: 12 }}>
        Execution EX-{String(exec.id).padStart(5, '0')} · Crew <b>{exec.crew_name || '—'}</b> · Executed by <b>{exec.executed_by_name || '—'}</b> · {fmtDateTime(exec.submitted_at)} · Result <Pill value={exec.result || 'INCOMPLETE'} />
      </div>
      {(exec.items || []).length === 0 && <div className="muted">No steps recorded for this execution.</div>}
      {(exec.items || []).map((it) => (
        <div key={it.id} className="box" style={{ marginTop: 8 }}>
          <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
            <b>{it.sequence}. {it.instruction}{it.critical_step ? <span className="warn" style={{ fontSize: 11, marginLeft: 6 }}>critical</span> : null}</b>
            <Pill value={it.result || 'UNGRADED'} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Response: <b>{formatChecklistResponse(it)}</b></div>
          {it.comment && <div className="muted" style={{ fontSize: 12 }}>Comment: {it.comment}</div>}
        </div>
      ))}
    </>
  );
}

export default function ExecutionDetail({ exec, onClose }) {
  if (!exec) return null;
  return (
    <Modal title={executionTitle(exec)} onClose={onClose} wide printable
      footer={<><PrintButton /><button className="btn btn-primary" onClick={onClose}>Close</button></>}>
      <ExecutionDetailBody exec={exec} />
    </Modal>
  );
}
