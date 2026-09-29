import { useState, useEffect, Fragment } from 'react';
import { api, fmtDate, fmtDateTime } from '../api';
import { Modal, Loading, ErrorNote, Pill, CondPill, PrintButton } from '../components';
import { formatChecklistResponse } from '../checklistFormat';
import DocumentGeo from './DocumentGeo';

export default function Document({ type, params, title, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.post('/reports/generate', { report_type: type, ...params })
      .then((r) => setData(r.data))
      .catch((e) => setError(e.message));
  }, [type, params]);

  return (
    <Modal title={title || 'Report'} onClose={onClose} wide printable
      footer={<><PrintButton /><button className="btn btn-primary" onClick={onClose}>Close</button></>}>
      {error && <ErrorNote error={error} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="muted mb" style={{ fontSize: 12 }}>{data.subtitle || ''}</div>
          <div className="kv">
            {(data.rows || []).map((r) => (
              <Fragment key={r.label}>
                <span className="k">{r.label}</span>
                <span>{r.value ?? '—'}</span>
              </Fragment>
            ))}
          </div>
          <DocumentGeo document={data.document} />
          <DocumentBody d={data.document} />
        </>
      )}
    </Modal>
  );
}

function Section({ title, children }) {
  return (
    <div className="mt">
      <h4 className="section-title">{title}</h4>
      {children}
    </div>
  );
}

function DocumentBody({ d }) {
  if (!d) return null;
  if (d.entity === 'ASSET') return <AssetDocument d={d} />;
  if (d.entity === 'CREW') return <CrewDocument d={d} />;
  return null;
}

// ---------------------------------------------------------------------------
// Checklist response wording is shared with the printed reports; see
// ../checklistFormat for the true/false -> Pass/Fail mapping.
// ---------------------------------------------------------------------------

function ExecutionList({ executions }) {
  if (!(executions || []).length) {
    return <div className="muted" style={{ fontSize: 12 }}>No checklist executions recorded.</div>;
  }
  return (
    <div>
      {executions.map((e) => (
        <div key={e.id} className="card card-pad mb" style={{ padding: 10 }}>
          <div className="spread" style={{ flexWrap: 'wrap', gap: 8, fontSize: 13 }}>
            <span className="spread" style={{ gap: 8 }}>
              <b className="mono">EX-{String(e.id).padStart(5, '0')}</b>
              <span>{e.template_name || `Checklist #${e.template_id}`}{e.template_version ? ` v${e.template_version}` : ''}</span>
              {e.task_number && <a href={`/tasks/${e.task_id}`} className="link">{e.task_number}</a>}
              {e.asset_name && <span>{e.asset_name}{e.asset_code ? ` (${e.asset_code})` : ''}</span>}
            </span>
            <span className="spread" style={{ gap: 8 }}>
              <span className="muted nowrap">{fmtDateTime(e.submitted_at)}</span>
              <Pill value={e.result || 'INCOMPLETE'} />
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {(e.pass_count ?? 0) + (e.fail_count ?? 0) > 0
              ? `${e.pass_count} passed / ${e.fail_count} failed of ${e.item_count ?? 0} items`
              : `${e.item_count ?? 0} items`}
          </div>
          {e.notes ? <div className="muted" style={{ fontSize: 12 }}>Notes: {e.notes}</div> : null}
          {(e.items || []).length > 0 && (
            <table style={{ marginTop: 6 }}>
              <thead>
                <tr><th>#</th><th>Checklist item</th><th>Type</th><th>Response recorded</th><th>Result</th><th>Crew comment</th></tr>
              </thead>
              <tbody>
                {(e.items || []).map((it) => (
                  <tr key={it.id}>
                    <td>{it.sequence}</td>
                    <td>{it.instruction}</td>
                    <td className="nowrap">{it.response_type}</td>
                    <td><b>{formatChecklistResponse(it)}</b></td>
                    <td><Pill value={it.result || 'INCOMPLETE'} /></td>
                    <td>{it.comment || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function AssetDocument({ d }) {
  return (
    <>
      <Section title="Maintenance history">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Summary</th></tr></thead>
          <tbody>
            {(d.history || []).map((e) => (
              <tr key={e.id}><td className="nowrap">{fmtDate(e.performed_at)}</td><td>{e.event_type}</td><td>{e.work_summary || '—'}</td></tr>
            ))}
            {(d.history || []).length === 0 && <tr><td colSpan={3} className="muted center">No maintenance history.</td></tr>}
          </tbody>
        </table>
      </Section>
      <Section title="Checklist executions (findings)">
        <ExecutionList executions={d.executions} />
      </Section>
      <Section title="GPS validations">
        {(d.gps || []).map((v) => (
          <div key={v.id} style={{ fontSize: 12 }}><Pill value={v.result} /> <span className="muted">{fmtDateTime(v.validated_at)} · {Math.round(v.distance_m)} m from expected (tol {v.tolerance_m} m)</span></div>
        ))}
        {(d.gps || []).length === 0 && <div className="muted" style={{ fontSize: 12 }}>Not validated yet.</div>}
      </Section>
      <Section title="Tasks">
        <table>
          <thead><tr><th>Task</th><th>Status</th><th>Due</th><th>Result</th></tr></thead>
          <tbody>
            {(d.tasks || []).map((t) => (
              <tr key={t.id}>
                <td><a href={`/tasks/${t.id}`} className="link">{t.task_number}</a></td>
                <td><Pill value={t.status} /></td>
                <td className="nowrap">{fmtDate(t.due_date)}</td>
                <td>{t.result || '—'}</td>
              </tr>
            ))}
            {(d.tasks || []).length === 0 && <tr><td colSpan={4} className="muted center">No tasks linked.</td></tr>}
          </tbody>
        </table>
      </Section>
      {d.components?.length > 0 && (
        <Section title="Components">
          <table>
            <thead><tr><th>Part</th><th>Type</th><th>Material</th><th>Qty</th><th>Status</th><th>Condition</th><th>Notes</th></tr></thead>
            <tbody>
              {d.components.map((c) => (
                <tr key={c.id}>
                  <td>{c.name || '—'}</td>
                  <td>{c.component_type}</td>
                  <td>{c.material || '—'}</td>
                  <td>{c.quantity ?? '—'} {c.unit || ''}</td>
                  <td>{c.status ? <Pill value={c.status} /> : '—'}</td>
                  <td>{c.condition_rating != null ? <CondPill rating={c.condition_rating} /> : '—'}</td>
                  <td>{c.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

function CrewDocument({ d }) {
  return (
    <>
      <Section title="Members">
        <table>
          <thead><tr><th>Person</th><th>Title</th><th>Skill</th><th>Active</th></tr></thead>
          <tbody>
            {(d.members || []).map((m) => (
              <tr key={m.id}>
                <td>{m.first_name} {m.last_name}</td>
                <td>{m.title || '—'}</td>
                <td>{m.skill_level}</td>
                <td>{m.active ? 'Yes' : 'No'}</td>
              </tr>
            ))}
            {(d.members || []).length === 0 && <tr><td colSpan={4} className="muted center">No members.</td></tr>}
          </tbody>
        </table>
      </Section>
      <Section title="Certifications">
        <table>
          <thead><tr><th>Person</th><th>Certification</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead>
          <tbody>
            {(d.certs || []).map((c) => {
              const who = [c.first_name, c.last_name].filter(Boolean).join(' ');
              return (
                <tr key={c.id}>
                  <td>{who || `Person #${c.person_id}`}</td>
                  <td>{c.cert_type}</td>
                  <td className="nowrap">{fmtDate(c.issued_at)}</td>
                  <td className="nowrap">{fmtDate(c.expires_at)}</td>
                  <td><Pill value={c.status} /></td>
                </tr>
              );
            })}
            {(d.certs || []).length === 0 && <tr><td colSpan={5} className="muted center">No certifications.</td></tr>}
          </tbody>
        </table>
      </Section>
      <Section title="Tasks">
        <table>
          <thead><tr><th>Task</th><th>Status</th><th>Due</th><th>Completed</th><th>Result</th></tr></thead>
          <tbody>
            {(d.tasks || []).map((t) => (
              <tr key={t.id}>
                <td><a href={`/tasks/${t.id}`} className="link">{t.task_number}</a></td>
                <td><Pill value={t.status} /></td>
                <td className="nowrap">{fmtDate(t.due_date)}</td>
                <td className="nowrap">{fmtDate(t.actual_end)}</td>
                <td>{t.result || '—'}</td>
              </tr>
            ))}
            {(d.tasks || []).length === 0 && <tr><td colSpan={5} className="muted center">No tasks.</td></tr>}
          </tbody>
        </table>
      </Section>
      <Section title="Checklist executions (findings)">
        <ExecutionList executions={d.executions} />
      </Section>
    </>
  );
}
