import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, PrintButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import { formatChecklistResponse, formatChecklistResult, describeTarget, executionTitle } from '../checklistFormat';
import TargetProfile from '../components/TargetProfile';

const RESPONSE_TYPES = ['PASS_FAIL', 'YES_NO', 'SELECT', 'NUMERIC', 'TEXT', 'PHOTO', 'GPS_POINT'];

const blankTpl = { name: '', code: '', category: 'INSPECTION', asset_type: '', task_type: '', version: 1, status: 'ACTIVE', is_mandatory: 0, requires_supervisor_verification: 0, requires_gps_confirmation: 0, estimated_minutes: null, safety_notes: '', materials: '', required_personnel: '' };

export default function Checklists() {
  const canWrite = can(getStoredUser(), 'checklist:write');
  const [rows, setRows] = useState(null);
  const [execs, setExecs] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [execDetail, setExecDetail] = useState(null);
  const [itemForm, setItemForm] = useState(null);
  const [tab, setTab] = useState('templates');
  const { query: qTpl, setQuery: setQTpl, results: tplResults } = useSearchFilter(rows);
  const { query: qExec, setQuery: setQExec, results: execResults } = useSearchFilter(execs);

  const load = () => {
    api.get('/checklists').then(setRows).catch((e) => setError(e.message));
    api.get('/checklist-executions').then(setExecs).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  async function save() {
    try {
      const body = { ...form, asset_type: form.asset_type || null };
      if (form.id) await api.put(`/checklists/${form.id}`, body);
      else await api.post('/checklists', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function deleteTemplate(c) {
    if (!window.confirm(`Delete checklist "${c.name}"? This cannot be undone.`)) return;
    try {
      await api.del(`/checklists/${c.id}`);
      setError(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function activate(c) {
    try { await api.post(`/checklists/${c.id}/activate`); load(); if (detail && detail.id === c.id) openDetail(c); } catch (e) { setError(e.message); }
  }

  async function openDetail(c) {
    try { setDetail(await api.get(`/checklists/${c.id}`)); setItemForm(null); } catch (e) { setError(e.message); }
  }

  async function saveItem() {
    try {
      const body = { ...itemForm, template_id: detail.id };
      if (itemForm.id) await api.put(`/checklists/${detail.id}/items/${itemForm.id}`, body);
      else await api.post(`/checklists/${detail.id}/items`, { ...body, sequence: (detail.items?.length || 0) + 1 });
      setItemForm(null);
      openDetail(detail);
    } catch (e) { setError(e.message); }
  }

  async function deleteItem(it) {
    if (!window.confirm('Delete this checklist step?')) return;
    try {
      await api.del(`/checklists/${detail.id}/items/${it.id}`);
      openDetail(detail);
    } catch (e) { setError(e.message); }
  }

  if (!rows && error) return <Page title="Inspection & Maintenance Checklists"><ErrorNote error={error} /></Page>;
  if (!rows) return <Page title="Inspection & Maintenance Checklists"><Loading /></Page>;

  const execTarget = execDetail ? describeTarget(execDetail.target) : null;

  return (
    <Page title="Inspection & Maintenance Checklists" crumbs="TMMS / Operations"
      actions={canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blankTpl })}>+ Add Template</button> : null}>
      {error && <ErrorNote error={error} />}

      <div className="tabs">
        <button className={'tab' + (tab === 'templates' ? ' active' : '')} onClick={() => setTab('templates')}>Templates ({rows.length})</button>
        <button className={'tab' + (tab === 'executions' ? ' active' : '')} onClick={() => setTab('executions')}>Executions ({execs?.length || 0})</button>
      </div>

      {tab === 'templates' && (
        <div className="card">
          <div className="filters" style={{ margin: 0, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <SearchField value={qTpl} onChange={setQTpl} placeholder="Search checklists…" />
            <span className="muted" style={{ fontSize: 12 }}>{tplResults.length} of {rows.length}</span>
          </div>
          <div className="tbl-wrap">
          <table>
            <thead><tr><th>Checklist</th><th>Category</th><th>Applies To</th><th>Status</th><th>Items</th><th>Used By Tasks</th><th>GPS Req</th><th></th></tr></thead>
            <tbody>
              {tplResults.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b><br /><span className="mono muted">{c.code} · v{c.version}</span></td>
                  <td>{c.category}</td>
                  <td>{c.asset_type || (c.task_type || '—')}</td>
                  <td><Pill value={c.status} /></td>
                  <td>{c.item_count}</td>
                  <td>{c.usage_count}</td>
                  <td>{c.requires_gps_confirmation ? '✓' : '—'}</td>
                  <td className="nowrap">
                    <button className="btn btn-sm" onClick={() => openDetail(c)}>Open</button>{' '}
                    {canWrite && <button className="btn btn-sm" onClick={() => setForm({ ...c, asset_type: c.asset_type || '' })}>Edit</button>}{' '}
                    {c.status !== 'ACTIVE' && canWrite && <button className="btn btn-sm btn-primary" onClick={() => activate(c)}>Activate</button>}{' '}
                    {canWrite && c.usage_count === 0 && <button className="btn btn-sm btn-danger" onClick={() => deleteTemplate(c)}>Delete</button>}
                  </td>
                </tr>
              ))}
              {tplResults.length === 0 && (
                <tr><td colSpan="8" className="muted center">{qTpl ? 'No checklists match your search' : 'No checklists found'}</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {tab === 'executions' && (
        <div className="card">
          <div className="filters" style={{ margin: 0, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <SearchField value={qExec} onChange={setQExec} placeholder="Search executions…" />
            <span className="muted" style={{ fontSize: 12 }}>{execResults.length} of {(execs || []).length}</span>
          </div>
          <div className="tbl-wrap">
          <table>
            <thead><tr><th>Checklist</th><th>Asset / infrastructure</th><th>Done by</th><th>Task</th><th>Submitted</th><th>Pass/Fail</th><th>Result</th><th></th></tr></thead>
            <tbody>
              {execResults.map((e) => {
                const tt = describeTarget(e.target);
                return (
                <tr key={e.id} className="row-link" onClick={() => setExecDetail(e)} title="Click to view the checklist executed on site">
                  <td><b>{e.template?.name || '—'}</b><br /><span className="mono muted">EX-{String(e.id).padStart(5, '0')}{e.template?.code ? ` · ${e.template.code}` : ''}</span></td>
                  <td>{e.asset ? <><span className="mono">{e.asset.asset_id}</span><br /><span className="muted">{e.asset.name}</span></> : <span className="muted">{tt.infrastructure || '—'}</span>}</td>
                  <td>{e.executed_by_name || '—'}<br /><span className="muted">{e.crew?.name || '—'}</span></td>
                  <td>{e.task ? <a href={`/tasks/${e.task.id}`} className="link" onClick={(ev) => ev.stopPropagation()}>{e.task.task_number}</a> : '—'}</td>
                  <td>{fmtDateTime(e.submitted_at)}</td>
                  <td>{e.pass_count} / {e.pass_count + e.fail_count}{e.critical_fail_count ? <b className="bad"> · {e.critical_fail_count} crit</b> : null}</td>
                  <td><Pill value={e.result || 'INCOMPLETE'} /></td>
                  <td className="nowrap"><button className="btn btn-sm" onClick={(ev) => { ev.stopPropagation(); setExecDetail(e); }}>Open</button></td>
                </tr>
                );
              })}
              {execResults.length === 0 && <tr><td colSpan={8} className="empty">{qExec ? 'No executions match your search' : 'No checklist executions recorded yet'}</td></tr>}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {execDetail && (
        <Modal title={executionTitle(execDetail)} onClose={() => setExecDetail(null)} wide printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={() => setExecDetail(null)}>Close</button>
          </>}>
          <div className="kv">
            <span className="k">Checklist</span><span><b>{execDetail.template?.name || '—'}</b>{execDetail.template?.code ? ` · ${execDetail.template.code}` : ''}{execDetail.template_version ? ` · v${execDetail.template_version}` : ''}</span>
            <span className="k">Task</span><span>{execDetail.task ? <><a href={`/tasks/${execDetail.task.id}`} className="link">{execDetail.task.task_number}</a> · {execDetail.task.title}</> : '—'}</span>
            <span className="k">Crew</span><span>{execDetail.crew ? `${execDetail.crew.name}${execDetail.crew.crew_code ? ` (${execDetail.crew.crew_code})` : ''}` : '—'}</span>
            <span className="k">Executed by</span><span>{execDetail.executed_by_name || '—'}</span>
            <span className="k">Started</span><span>{fmtDateTime(execDetail.started_at)}</span>
            <span className="k">Submitted</span><span>{fmtDateTime(execDetail.submitted_at)}</span>
            <span className="k">Result</span><span><Pill value={execDetail.result || 'INCOMPLETE'} /></span>
            <span className="k">Steps passed</span><span>{execDetail.pass_count} of {execDetail.pass_count + execDetail.fail_count}{execDetail.critical_fail_count ? <b className="bad"> · {execDetail.critical_fail_count} critical failed</b> : null}</span>
            <span className="k">Notes</span><span>{execDetail.notes || '—'}</span>
          </div>
          <TargetProfile
            target={execDetail.target}
            readiness={execDetail.readiness}
            workflow={{
              created_by: execDetail.created_by_name,
              assigned_by: execDetail.assigned_by_name,
              executed_by: execDetail.executed_by_name,
              verified_by: execDetail.verified_by_name,
            }}
          />

          <p className="muted mt">
            {execDetail.crew ? `${execDetail.crew.name} ` : ''}executed <b>{execDetail.template?.name || 'this checklist'}</b>
            {execTarget?.asset ? <> on <b>{execTarget.asset}</b></> : execTarget?.infrastructure ? <> on <b>{execTarget.infrastructure}</b></> : null}
            {execTarget?.asset && execTarget?.infrastructure ? <> at <b>{execTarget.infrastructure}</b></> : null}
            {execDetail.executed_by_name ? <> — field worker <b>{execDetail.executed_by_name}</b></> : null}, recording {execDetail.pass_count + execDetail.fail_count} step(s).
            {execDetail.critical_fail_count
              ? ` ${execDetail.critical_fail_count} critical step(s) failed — a corrective follow-up is recommended.`
              : execDetail.fail_count
                ? ' Some non-critical steps failed — verify before closing the task.'
                : ' All recorded steps passed.'}
          </p>

          <div className="card-head mt"><h3 className="card-title">Checklist steps executed on site</h3></div>
          <div className="tbl-wrap">
          <table>
            <thead><tr><th>Seq</th><th>Section</th><th>Step</th><th>Response recorded</th><th>Assessment</th><th>Comment</th></tr></thead>
            <tbody>
              {(execDetail.item_results || []).map((it) => (
                <tr key={it.id}>
                  <td>{it.sequence}</td>
                  <td>{it.section || '—'}</td>
                  <td>{it.critical_step ? <b className="bad">CRIT · </b> : null}{it.instruction}</td>
                  <td><b>{formatChecklistResponse(it)}</b></td>
                  <td>{it.result ? <Pill value={it.result}>{formatChecklistResult(it.result)}</Pill> : '—'}</td>
                  <td>{it.comment || '—'}</td>
                </tr>
              ))}
              {(execDetail.item_results || []).length === 0 && <tr><td colSpan={6} className="empty">No steps recorded for this execution</td></tr>}
            </tbody>
          </table>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.name} — ${detail.code} v${detail.version}`} onClose={() => setDetail(null)} wide printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
            {canWrite && <>
              <button className="btn" onClick={() => setItemForm({ instruction: '', response_type: 'PASS_FAIL', required: 1, critical_step: 0, test_equipment: '' })}>+ Add Step</button>
              {detail.status !== 'ACTIVE' && <button className="btn btn-primary" onClick={() => activate(detail)}>Activate template</button>}
            </>}
          </>}>
          <div className="kv">
            <span className="k">Category</span><span>{detail.category}</span>
            <span className="k">Applies to</span><span>{detail.asset_type || detail.task_type || '—'}</span>
            <span className="k">Status</span><span><Pill value={detail.status} /></span>
            <span className="k">Supervisor verification</span><span>{detail.requires_supervisor_verification ? 'Required' : 'Not required'}</span>
            <span className="k">GPS confirmation</span><span>{detail.requires_gps_confirmation ? 'Required' : 'Not required'}</span>
            <span className="k">Safety notes</span><span>{detail.safety_notes || '—'}</span>
            <span className="k">Materials required</span><span>{detail.materials || '—'}</span>
            <span className="k">Required personnel</span><span>{detail.required_personnel || '—'}</span>
          </div>
          <div className="card-head mt"><h3 className="card-title">Procedure Steps</h3></div>
          <div className="tbl-wrap">
          <table>
            <thead><tr><th>Seq</th><th>Section</th><th>Instruction</th><th>Test equipment</th><th>Response</th><th>Req</th><th>Critical</th><th></th></tr></thead>
            <tbody>
              {(detail.items || []).map((it) => (
                <tr key={it.id}>
                  <td>{it.sequence}</td>
                  <td>{it.section || '—'}</td>
                  <td>{it.instruction}</td>
                  <td>{it.test_equipment || '—'}</td>
                  <td>{it.response_type}</td>
                  <td>{it.required ? '✓' : '—'}</td>
                  <td>{it.critical_step ? <b className="bad">CRIT</b> : '—'}</td>
                  <td className="nowrap">
                    {canWrite && <button className="btn btn-sm" onClick={() => setItemForm({ id: it.id, instruction: it.instruction || '', section: it.section || '', response_type: it.response_type, required: it.required ? 1 : 0, critical_step: it.critical_step ? 1 : 0, pass_criteria: it.pass_criteria || '', test_equipment: it.test_equipment || '' })}>Edit</button>}{' '}
                    {canWrite && <button className="btn btn-sm btn-danger" onClick={() => deleteItem(it)}>Delete</button>}
                  </td>
                </tr>
              ))}
              {(detail.items || []).length === 0 && <tr><td colSpan={8} className="empty">No steps yet — add one</td></tr>}
            </tbody>
          </table>
          </div>
        </Modal>
      )}

      {itemForm && detail && (
        <Modal title={itemForm.id ? 'Edit Checklist Step' : 'Add Checklist Step'} onClose={() => setItemForm(null)}
          footer={<>
            <button className="btn" onClick={() => setItemForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveItem}>{itemForm.id ? 'Save step' : 'Add step'}</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Instruction</label><input value={itemForm.instruction || ''} onChange={(e) => setItemForm({ ...itemForm, instruction: e.target.value })} /></div>
            <div className="field"><label>Section</label><input value={itemForm.section || ''} onChange={(e) => setItemForm({ ...itemForm, section: e.target.value })} placeholder="Visual / Mechanical / Electrical / Testing" /></div>
            <div className="field"><label>Test equipment</label><input value={itemForm.test_equipment || ''} onChange={(e) => setItemForm({ ...itemForm, test_equipment: e.target.value })} placeholder="Instrument / tool used for this step" /></div>
            <div className="field"><label>Response type</label>
              <SearchSelect value={itemForm.response_type} onChange={(e) => setItemForm({ ...itemForm, response_type: e.target.value })}>
                {RESPONSE_TYPES.map((r) => <option key={r}>{r}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Required</label>
              <SearchSelect value={itemForm.required ? 1 : 0} onChange={(e) => setItemForm({ ...itemForm, required: Number(e.target.value) })}>
                <option value={1}>Yes</option><option value={0}>No</option>
              </SearchSelect></div>
            <div className="field"><label>Critical step</label>
              <SearchSelect value={itemForm.critical_step ? 1 : 0} onChange={(e) => setItemForm({ ...itemForm, critical_step: Number(e.target.value) })}>
                <option value={0}>No</option><option value={1}>Yes</option>
              </SearchSelect></div>
            <div className="field full"><label>Pass criteria</label><input value={itemForm.pass_criteria || ''} onChange={(e) => setItemForm({ ...itemForm, pass_criteria: e.target.value })} placeholder="Optional criteria for automatic PASS/FAIL" /></div>
          </div>
        </Modal>
      )}

      {form && (
        <Modal title={form.id ? `Edit Checklist — ${form.name}` : 'Add Template'} onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>{form.id ? 'Save changes' : 'Create'}</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Name</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Code</label><input value={form.code || ''} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
            <div className="field"><label>Category</label>
              <SearchSelect value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {['INSPECTION', 'PREVENTIVE_MAINTENANCE', 'CORRECTIVE', 'EMERGENCY', 'COMMISSIONING', 'DIAGNOSTIC'].map((c) => <option key={c}>{c}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Asset type</label>
              <SearchSelect value={form.asset_type || ''} onChange={(e) => setForm({ ...form, asset_type: e.target.value })}>
                <option value="">— any —</option>
                {['TRANSFORMER', 'CIRCUIT_BREAKER', 'PROTECTION_RELAY', 'SCADA_RTU', 'ARRESTER', 'TOWER', 'BUSBAR', 'INSULATOR_STRING'].map((t) => <option key={t}>{t}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Task type</label>
              <SearchSelect value={form.task_type || ''} onChange={(e) => setForm({ ...form, task_type: e.target.value })}>
                <option value="">— any —</option>
                {['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'].map((t) => <option key={t}>{t}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Est. minutes</label><input type="number" value={form.estimated_minutes || ''} onChange={(e) => setForm({ ...form, estimated_minutes: Number(e.target.value) })} /></div>
            <div className="field"><label>Mandatory</label>
              <SearchSelect value={form.is_mandatory ? 1 : 0} onChange={(e) => setForm({ ...form, is_mandatory: Number(e.target.value) })}>
                <option value={1}>Yes</option><option value={0}>No</option>
              </SearchSelect></div>
            <div className="field"><label>Requires GPS confirmation</label>
              <SearchSelect value={form.requires_gps_confirmation ? 1 : 0} onChange={(e) => setForm({ ...form, requires_gps_confirmation: Number(e.target.value) })}>
                <option value={1}>Yes</option><option value={0}>No</option>
              </SearchSelect></div>
            <div className="field"><label>Supervisor verification</label>
              <SearchSelect value={form.requires_supervisor_verification ? 1 : 0} onChange={(e) => setForm({ ...form, requires_supervisor_verification: Number(e.target.value) })}>
                <option value={1}>Required</option><option value={0}>Not required</option>
              </SearchSelect></div>
            <div className="field full"><label>Safety notes</label><textarea value={form.safety_notes || ''} onChange={(e) => setForm({ ...form, safety_notes: e.target.value })} /></div>
            <div className="field full"><label>Materials required</label><textarea value={form.materials || ''} onChange={(e) => setForm({ ...form, materials: e.target.value })} /></div>
            <div className="field full"><label>Required personnel</label><textarea value={form.required_personnel || ''} onChange={(e) => setForm({ ...form, required_personnel: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
