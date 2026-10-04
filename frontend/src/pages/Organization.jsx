import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { SearchSelect, Page, Modal, ErrorNote, Loading, ConfirmButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import { peopleInRegion } from '../cascade';

const UNIT_TYPE_LABEL = {
  CORPORATE: 'Corporate HQ',
  BUSINESS_UNIT: 'Business Unit',
  DIVISION: 'Division',
  REGION_DIRECTORATE: 'Regional Directorate',
  DEPARTMENT: 'Department',
  SUBSTATION_UNIT: 'Substation Unit',
  SUBSTATION_MAINTENANCE: 'Substation O&M Department',
  TRANSMISSION_MAINTENANCE: 'Transmission Line & OPGW Department',
  RELAY_SCADA_TELECOM: 'RTU / Telecom / SCADA & Protection',
  OPERATIONAL_TECHNOLOGY: 'Operational Technology',
  OT_PROTECTION_CONTROL: 'Protection & Control',
  OT_SCADA_AUTOMATION: 'SCADA & Automation',
  OT_TELECOM_FIBER: 'Telecom & Fiber',
};

// The single function each org unit band owns in the task workflow, mirroring
// backend/operatingModel.js. Keeps the org tree and the task buckets aligned.
const UNIT_FUNCTION = {
  CORPORATE: 'Executive oversight',
  BUSINESS_UNIT: 'Executive oversight',
  DIVISION: 'Executive oversight',
  REGION_DIRECTORATE: 'Owns the region · assign + verify',
  DEPARTMENT: 'Commands the department · assign + verify',
  SUBSTATION_MAINTENANCE: 'Substation O&M command · assign + verify',
  TRANSMISSION_MAINTENANCE: 'Line & OPGW command · assign + verify',
  RELAY_SCADA_TELECOM: 'RTU / SCADA command · assign + verify',
  OPERATIONAL_TECHNOLOGY: 'OT command · assign + verify',
  OT_PROTECTION_CONTROL: 'Protection & control · assign + verify',
  OT_SCADA_AUTOMATION: 'SCADA & automation · assign + verify',
  OT_TELECOM_FIBER: 'Telecom & fiber · assign + verify',
  SUBSTATION_UNIT: 'Substation command · assign + verify',
};

const blank = {
  unit_code: '', name: '', unit_type: 'DEPARTMENT', parent_id: null, region_id: null,
  manager_person_id: null, sort_order: 0, notes: '',
};

export default function Organization() {
  const nav = useNavigate();
  const canWrite = can(getStoredUser(), 'settings:write');
  const [tree, setTree] = useState(null);
  const [flat, setFlat] = useState(null);
  const [regions, setRegions] = useState([]);
  const [people, setPeople] = useState([]);
  const [units, setUnits] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const { query, setQuery, results: unitRows } = useSearchFilter(flat);

  // Region narrows the parent-unit picker (units with no region stay selectable).
  const parentUnits = useMemo(() => {
    const base = (units || []).filter((u) => u.id !== form?.id);
    if (!form?.region_id) return base;
    return base.filter((u) => u.region_id == null || String(u.region_id) === String(form.region_id));
  }, [units, form?.id, form?.region_id]);

  const load = () => {
    Promise.all([
      api.get('/org-tree').then(setTree),
      api.get('/org-units').then(setFlat),
      api.get('/regions').then(setRegions).catch(() => {}),
      api.get('/people').then(setPeople).catch(() => {}),
      api.get('/org-units').then(setUnits).catch(() => {}),
    ]).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    if (!flat) return null;
    return {
      units: flat.length,
      directorates: flat.filter((u) => u.unit_type === 'REGION_DIRECTORATE').length,
      departments: flat.filter((u) => ['DEPARTMENT', 'SUBSTATION_MAINTENANCE', 'TRANSMISSION_MAINTENANCE', 'RELAY_SCADA_TELECOM', 'OPERATIONAL_TECHNOLOGY', 'OT_PROTECTION_CONTROL', 'OT_SCADA_AUTOMATION', 'OT_TELECOM_FIBER'].includes(u.unit_type)).length,
      substationUnits: flat.filter((u) => u.unit_type === 'SUBSTATION_UNIT').length,
      managed: flat.filter((u) => u.manager).length,
      crews: flat.reduce((n, u) => n + (u.crews || []).length, 0),
    };
  }, [flat]);

  const toggle = (id) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  function renderNode(n, depth = 0) {
    const isOpen = expanded.has(n.id);
    const hasChildren = n.children && n.children.length > 0;
    const crews = n.crews || [];
    return (
      <div key={n.id} className="org-node" style={{ marginLeft: depth * 22 }}>
        <div className="org-row">
          {hasChildren ? (
            <button className="btn btn-ghost btn-sm org-toggle" onClick={() => toggle(n.id)}>{isOpen ? '▾' : '▸'}</button>
          ) : <span className="org-toggle" />}
          <div className={`org-badge unit-${n.unit_type.toLowerCase()}`} />
          <b>{n.name}</b>
          <span className="infra-chip">{UNIT_TYPE_LABEL[n.unit_type] || n.unit_type}</span>
          {UNIT_FUNCTION[n.unit_type] && <span className="infra-chip" title="Task function of this unit">{UNIT_FUNCTION[n.unit_type]}</span>}
          {n.region && <span className="infra-chip org-chip-region">{n.region.code}</span>}
          {n.manager && <span className="muted org-manager">— {n.manager.first_name} {n.manager.last_name}</span>}
          {canWrite && (
            <span className="grow" />
          )}
          {canWrite && (
            <span className="org-actions">
              <button className="btn btn-sm" onClick={() => setForm({ ...n, manager_person_id: n.manager_person_id, parent_id: n.parent_id, sort_order: n.sort_order || 0 })}>Edit</button>{' '}
              <button className="btn btn-sm" onClick={() => setForm({ ...blank, parent_id: n.id, region_id: n.region_id })}>+ Add Subunit</button>{' '}
              <ConfirmButton label="Delete" onConfirm={() => removeUnit(n)} title={`Delete ${n.name}?`} />
            </span>
          )}
        </div>
        {crews.length > 0 && (
          <div className="org-crews" style={{ marginLeft: 22 }}>
            {crews.map((c) => (
              <span key={c.id} className="infra-chip org-chip-crew" title={c.crew_type}>
                {c.name}
              </span>
            ))}
          </div>
        )}
        {isOpen && hasChildren && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  async function openDetail(u) {
    try { setDetail(await api.get(`/org-units/${u.id}`)); } catch (e) { setError(e.message); }
  }

  async function save() {
    try {
      const body = {
        ...form,
        parent_id: form.parent_id ? Number(form.parent_id) : null,
        region_id: form.region_id ? Number(form.region_id) : null,
        manager_person_id: form.manager_person_id ? Number(form.manager_person_id) : null,
      };
      if (form.id) await api.put(`/org-units/${form.id}`, body);
      else await api.post('/org-units', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function removeUnit(u) {
    try { await api.del(`/org-units/${u.id}`); load(); } catch (e) { setError(e.message); }
  }

  if (!tree || !counts) return error
    ? <Page title="Organization"><ErrorNote error={error} /></Page>
    : <Page title="Organization"><Loading /></Page>;

  return (
    <Page title="Organization" crumbs="TMMS / Governance"
      actions={<>
        <button className="btn btn-sm" onClick={() => nav('/model')}>System map</button>
        {canWrite && <button className="btn btn-primary" onClick={() => setForm({ ...blank, sort_order: 0 })}>+ Add Unit</button>}
      </>}>
      {error && <ErrorNote error={error} />}

      <div className="card card-pad mb" style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
        <div style={{ minWidth: 200 }}>
          <b>How the organisation maps to the system</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Each band has one function. A unit heads the work its role commands; it never mixes
            scheduling, assignment, execution and verification in one list.
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          <div><b>Corporate / Business Unit</b> · Executive — oversight</div>
          <div><b>Regional Directorate</b> · Region Director — owns the region</div>
          <div><b>Department</b> · Department Manager — assigns &amp; verifies</div>
          <div><b>Substation Unit</b> · Substation Manager — assigns &amp; verifies</div>
          <div><b>Field Crew</b> · Crew Lead / Member — executes</div>
          <div><b>Planning cell / Dispatch desk</b> · Planner / Dispatcher — schedules / assigns</div>
        </div>
      </div>

      <div className="grid grid-4 mb">
        <div className="card stat"><div className="label">Org units</div><div className="value">{counts.units}</div></div>
        <div className="card stat"><div className="label">Directorates</div><div className="value">{counts.directorates}</div></div>
        <div className="card stat"><div className="label">Managed units</div><div className="value">{counts.managed}</div><div className="sub">with an assigned manager</div></div>
        <div className="card stat"><div className="label">Field crews</div><div className="value">{counts.crews}</div><div className="sub">assigned to units</div></div>
      </div>

      <div className="grid grid-2">
        <div>
          <h3 className="section-title">Hierarchy (CEO → TBU → Divisions → Directorates → Departments)</h3>
          <div className="card card-pad org-tree">
            {tree.map((r) => renderNode(r))}
          </div>
        </div>
        <div>
          <h3 className="section-title">All Units</h3>
          <div className="card">
            <div className="filters" style={{ margin: 0, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <SearchField value={query} onChange={setQuery} placeholder="Search units…" />
              <span className="muted" style={{ fontSize: 12 }}>{unitRows.length} of {(flat || []).length}</span>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Function</th><th>Region</th><th>Manager</th><th># Crews</th><th></th></tr></thead>
                <tbody>
                  {unitRows.map((u) => (
                    <tr key={u.id}>
                      <td className="mono">{u.unit_code}</td>
                      <td>{u.name}</td>
                      <td>{UNIT_TYPE_LABEL[u.unit_type] || u.unit_type}</td>
                      <td className="muted">{UNIT_FUNCTION[u.unit_type] || '—'}</td>
                      <td>{u.region?.code || '—'}</td>
                      <td>{u.manager ? `${u.manager.first_name} ${u.manager.last_name}` : '—'}</td>
                      <td>{(u.crews || []).length}</td>
                      <td className="nowrap"><button className="btn btn-sm" onClick={() => openDetail(u)}>View</button></td>
                    </tr>
                  ))}
                  {unitRows.length === 0 && (
                    <tr><td colSpan="8" className="muted center">{query ? 'No units match your search' : 'No units found'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {detail && (
        <Modal title={`${detail.name} (${detail.unit_code})`} onClose={() => setDetail(null)} wide>
          <div className="grid grid-2">
            <div>
              <div className="kv">
                <span className="k">Type</span><span>{UNIT_TYPE_LABEL[detail.unit_type] || detail.unit_type}</span>
                <span className="k">Region</span><span>{detail.region?.name || '—'}</span>
                <span className="k">Parent</span><span>{detail.parent?.name || '—'}</span>
                <span className="k">Manager</span><span>{detail.manager ? `${detail.manager.first_name} ${detail.manager.last_name}` : '—'}</span>
                <span className="k">Notes</span><span>{detail.notes || '—'}</span>
              </div>
              <div className="card-head"><h3 className="card-title">Crews</h3></div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Type</th><th>Status</th></tr></thead>
                  <tbody>
                    {(detail.crews || []).map((c) => (
                      <tr key={c.id}><td>{c.name}</td><td>{c.crew_type}</td><td>{c.status}</td></tr>
                    ))}
                    {(detail.crews || []).length === 0 && <tr><td colSpan="3" className="muted center">No crews</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="card-head"><h3 className="card-title">Personnel</h3></div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Title</th><th>Role</th></tr></thead>
                  <tbody>
                    {(detail.personnel || []).map((p) => (
                      <tr key={p.id}><td>{p.first_name} {p.last_name}</td><td>{p.title || '—'}</td><td>{p.role || '—'}</td></tr>
                    ))}
                    {(detail.personnel || []).length === 0 && <tr><td colSpan="3" className="muted center">No personnel</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="card-head"><h3 className="card-title">Child units</h3></div>
              {(detail.children || []).map((c) => <div key={c.id} className="mb" style={{ fontSize: 13 }}>• {c.name}</div>)}
            </div>
          </div>
        </Modal>
      )}

      {form && (
        <Modal title={form.id ? `Edit — ${form.name}` : 'Add Org Unit'} onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Unit code</label><input value={form.unit_code || ''} onChange={(e) => setForm({ ...form, unit_code: e.target.value })} /></div>
            <div className="field"><label>Name</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Type</label>
              <SearchSelect value={form.unit_type} onChange={(e) => setForm({ ...form, unit_type: e.target.value })}>
                {Object.entries(UNIT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Parent unit</label>
              <SearchSelect value={form.parent_id || ''} onChange={(e) => setForm({ ...form, parent_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— top level —</option>
                {parentUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Region</label>
              <SearchSelect value={form.region_id || ''} onChange={(e) => setForm({ ...form, region_id: e.target.value ? Number(e.target.value) : null, parent_id: null, manager_person_id: null })}>
                <option value="">— none —</option>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Manager</label>
              <SearchSelect value={form.manager_person_id || ''} onChange={(e) => setForm({ ...form, manager_person_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {peopleInRegion(people, form.region_id).map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Sort order</label><input type="number" value={form.sort_order ?? 0} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} /></div>
            <div className="field full"><label>Notes</label><input value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
