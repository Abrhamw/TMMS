import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, PrintButton, Progress, ConfirmButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import { peopleInRegion } from '../cascade';
import Document from '../components/Document';
import ViewMap from '../components/ViewMap';

const CREW_ROLES = ['CREW_LEADER', 'LINEMAN', 'TECHNICIAN', 'SAFETY_OFFICER', 'INSPECTOR', 'APPRENTICE'];
const CREW_SKILLS = ['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'MASTER'];

const blank = { name: '', crew_code: '', crew_type: 'MAINTENANCE', region_id: null, org_unit_id: null, leader_person_id: null, home_base: '', status_override: null, members: [] };

export default function Crews() {
  const canWrite = can(getStoredUser(), 'crew:write');
  const canReport = can(getStoredUser(), 'report:write');
  const me = getStoredUser();
  const [rows, setRows] = useState(null);
  const [regions, setRegions] = useState([]);
  const [units, setUnits] = useState([]);
  const [people, setPeople] = useState([]);
  const [eligibility, setEligibility] = useState(null);
  const [checklists, setChecklists] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [eligRegion, setEligRegion] = useState('');
  const [eligType, setEligType] = useState('EMERGENCY');
  const [eligChecklist, setEligChecklist] = useState('');
  const [eligTask, setEligTask] = useState('');
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [certs, setCerts] = useState(null);
  const [document, setDocument] = useState(null);
  const [pick, setPick] = useState('');
  const { query, setQuery, results } = useSearchFilter(rows);

  const load = () => api.get('/crews').then(setRows).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/org-units').then(setUnits).catch(() => {});
    api.get('/people').then(setPeople).catch(() => {});
    api.get('/certifications').then(setCerts).catch(() => {});
    api.get('/checklists').then(setChecklists).catch(() => {});
    api.get('/tasks').then(setTasks).catch(() => {});
  }, []);

  async function checkEligibility(regionId, taskType, checklistId, taskId) {
    try {
      const q = [`region_id=${regionId}`, `task_type=${taskType}`];
      if (checklistId) q.push(`checklist_template_id=${checklistId}`);
      if (taskId) q.push(`task_id=${taskId}`);
      setEligibility(await api.get(`/crews/eligibility?${q.join('&')}`));
    } catch (e) { setError(e.message); }
  }

  const personLabel = (p) => (p && p.first_name ? `${p.first_name} ${p.last_name}` : `Person #${p.id}`);

  function promoteLeader(personId) {
    const members = form.members.map((m) => ({
      ...m,
      role: m.person_id === personId ? 'CREW_LEADER' : m.role === 'CREW_LEADER' ? 'LINEMAN' : m.role,
    }));
    if (personId && !members.some((m) => m.person_id === personId)) {
      const p = people.find((x) => x.id === personId);
      if (p) members.unshift({ _k: Date.now() + Math.random(), person_id: personId, name: personLabel(p), title: p.title || p.role || '', role: 'CREW_LEADER', skill_level: 'SENIOR' });
    }
    setForm({ ...form, leader_person_id: personId || null, members });
  }

  function addMember(pid) {
    const p = people.find((x) => x.id === pid);
    if (!p) return;
    const isLeader = form.leader_person_id === pid;
    const members = [...form.members, { _k: Date.now() + Math.random(), person_id: pid, name: personLabel(p), title: p.title || p.role || '', role: isLeader ? 'CREW_LEADER' : 'LINEMAN', skill_level: isLeader ? 'SENIOR' : 'JUNIOR' }];
    setForm({ ...form, members });
    setPick('');
  }

  function moveMember(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= form.members.length) return;
    const members = [...form.members];
    [members[i], members[j]] = [members[j], members[i]];
    setForm({ ...form, members });
  }

  function updateMember(i, patch) {
    const members = [...form.members];
    members[i] = { ...members[i], ...patch };
    setForm({ ...form, members });
  }

  function changeRole(i, role) {
    if (role === 'CREW_LEADER') {
      promoteLeader(form.members[i].person_id);
      return;
    }
    const members = [...form.members];
    members[i] = { ...members[i], role };
    const leader = members[i].person_id === form.leader_person_id ? null : form.leader_person_id;
    setForm({ ...form, members, leader_person_id: leader });
  }

  function removeMember(i) {
    const members = [...form.members];
    const [removed] = members.splice(i, 1);
    const leader = form.leader_person_id === removed.person_id ? null : form.leader_person_id;
    setForm({ ...form, members, leader_person_id: leader });
  }

  async function save() {
    try {
      const { members, ...base } = form;
      const payload = { ...base, members: members.map((m) => ({ person_id: m.person_id, role: m.role, skill_level: m.skill_level })) };
      if (form.id) await api.put(`/crews/${form.id}`, payload);
      else await api.post('/crews', payload);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function openDetail(c) {
    try { setDetail(await api.get(`/crews/${c.id}`)); } catch (e) { setError(e.message); }
  }

  async function setOverride(value) {
    try {
      await api.put(`/crews/${detail.id}`, { status_override: value === '' ? null : value });
      await openDetail({ id: detail.id });
      load();
    } catch (e) { setError(e.message); }
  }

  async function editCrew(c) {
    try {
      const d = await api.get(`/crews/${c.id}`);
      setForm({
        ...c,
        members: (d.members || []).map((m) => ({
          _k: `m${m.id}`,
          person_id: m.person_id,
          name: m.person ? `${m.person.first_name} ${m.person.last_name}` : `Person #${m.person_id}`,
          title: m.person ? (m.person.title || m.person.role || '') : '',
          role: m.role,
          skill_level: m.skill_level,
        })),
      });
    } catch (e) { setError(e.message); }
  }

  if (!rows) return <Page title="Field Crews"><Loading /></Page>;

  const available = (form ? people.filter((p) => p.active !== 0 && !form.members.some((m) => m.person_id === p.id)) : []);
  const eligRegionId = eligRegion || regions[0]?.id || '';

  return (
    <Page title="Field Crews" crumbs="TMMS / Operations"
      actions={canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blank, region_id: me?.region_id || regions[0]?.id })}>+ Add Crew</button> : null}>
      {error && <ErrorNote error={error} />}

      <div className="grid grid-2">
        <div>
          <h3 className="section-title">Crew Roster</h3>
          <div className="card">
            <div className="filters" style={{ margin: 0, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <SearchField value={query} onChange={setQuery} placeholder="Search crews…" />
              <span className="muted" style={{ fontSize: 12 }}>{results.length} of {rows.length}</span>
            </div>
            <div className="tbl-wrap">
            <table>
              <thead><tr><th>Crew</th><th>Type</th><th>Status</th><th>Members</th><th>Open Tasks</th><th></th></tr></thead>
              <tbody>
                {results.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.name}</b><br /><span className="mono muted">{c.crew_code}</span><br /><span className="muted" style={{ fontSize: 12 }}>{c.org_unit ? c.org_unit.name : 'Unassigned'}</span></td>
                    <td>{c.crew_type}</td>
                    <td>
                      <Pill value={c.status} />
                      {c.open_task_count > 0 && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{c.open_task_count} active</span>}
                    </td>
                    <td>{c.member_count}</td>
                    <td>{c.open_task_count}</td>
                    <td className="nowrap">
                      <button className="btn btn-sm" onClick={() => openDetail(c)}>View</button>{' '}
                      {canWrite && <button className="btn btn-sm" onClick={() => editCrew(c)}>Edit</button>}
                    </td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr><td colSpan="6" className="muted center">{query ? 'No crews match your search' : 'No crews found'}</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </div>
        <div>
          <h3 className="section-title">Dispatch Eligibility Check</h3>
          <div className="card card-pad">
            <div className="flex mb" style={{ flexWrap: 'wrap', gap: 8 }}>
              <SearchSelect value={eligRegion || (regions[0]?.id ?? '')} onChange={(e) => { setEligRegion(e.target.value); setEligTask(''); }}>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </SearchSelect>
              <SearchSelect value={eligType} onChange={(e) => setEligType(e.target.value)}>
                {['EMERGENCY', 'PREVENTIVE', 'INSPECTION'].map((t) => <option key={t}>{t}</option>)}
              </SearchSelect>
              <SearchSelect value={eligChecklist} onChange={(e) => setEligChecklist(e.target.value)}>
                <option value="">No checklist (task type only)</option>
                {checklists.filter((c) => c.status === 'ACTIVE').map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </SearchSelect>
              <SearchSelect value={eligTask} onChange={(e) => setEligTask(e.target.value)}>
                <option value="">No specific task</option>
                {tasks.filter((t) => ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(t.status) && (!eligRegionId || String(t.region_id) === String(eligRegionId))).map((t) => (
                  <option key={t.id} value={t.id}>{t.task_number} · {t.title}</option>
                ))}
              </SearchSelect>
              <button className="btn btn-primary" onClick={() => checkEligibility(eligRegion || regions[0]?.id, eligType, eligChecklist, eligTask)}>Check</button>
            </div>
            {eligibility && eligibility[0]?.dispatch_requirements && (
              <div className="card" style={{ padding: 10, marginBottom: 10, background: '#f8fafc' }}>
                <b>{eligibility[0].dispatch_requirements.template_name}</b>
                {eligibility[0].resolved_via && (
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                    · checking the {eligibility[0].resolved_via === 'ASSIGNED' ? 'assigned' : 'target default'} crew only
                  </span>
                )}
                <div className="muted" style={{ fontSize: 12 }}>
                  Team: {eligibility[0].dispatch_requirements.team.join('; ') || '—'} · Requires skill: {eligibility[0].dispatch_requirements.skills.join(', ') || '—'}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Equipment to secure: {eligibility[0].dispatch_requirements.equipment_to_secure.join(', ') || '—'}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Required certs: {eligibility[0].dispatch_requirements.required_certs.join(', ') || '—'}
                  {eligibility[0].dispatch_requirements.recommended_certs?.length
                    ? ` · Recommended: ${eligibility[0].dispatch_requirements.recommended_certs.join(', ')}`
                    : ''}
                </div>
              </div>
            )}
            {eligibility && (
              <div className="tbl-wrap">
              <table>
                <thead><tr><th>Crew</th><th>Status</th><th>Active</th><th>Eligible</th><th>Score</th><th>Missing skills</th><th>Missing certs</th><th>Certs to obtain</th><th>Equipment to secure</th></tr></thead>
                <tbody>
                  {eligibility.map((c) => (
                    <tr key={c.id} style={c.selectable === false ? { opacity: 0.55 } : undefined}>
                      <td>{c.name}</td>
                      <td><Pill value={c.status} />{c.busy ? <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>busy</span> : null}</td>
                      <td>{c.open_task_count}</td>
                      <td>{c.eligible ? <span className="ok">✓</span> : <span className="bad">✗</span>}
                        {c.team_shortfall ? <span className="muted" style={{ marginLeft: 4, fontSize: 12 }} title="Checklist team size vs crew members">-{c.team_shortfall}</span> : null}
                      </td>
                      <td>{c.score}</td>
                      <td>{(c.missing_skills || []).join(', ') || '—'}</td>
                      <td>{(c.missing_certs || []).join(', ') || '—'}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {(c.certs_to_obtain || []).map((x) => `${x.cert} (${x.required ? 'required' : 'recommended'})`).join(', ') || '—'}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{(c.equipment_to_secure || []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            {!eligibility && <div className="muted">Pick a task to check its related crew, or a checklist to check the crews whose type the checklist requires. A bare region/task-type check keeps all crews.</div>}
          </div>
          <h3 className="section-title mt">Certifications Expiring / Expired</h3>
          <div className="card">
            <div className="tbl-wrap">
            <table>
              <thead><tr><th>Person</th><th>Cert</th><th>Expires</th><th>Status</th></tr></thead>
              <tbody>
                {(certs || []).filter((c) => new Date(c.expires_at) <= new Date(Date.now() + 90 * 864e5)).slice(0, 12).map((c) => (
                  <tr key={c.id}>
                    <td>{c.person?.first_name} {c.person?.last_name}</td>
                    <td>{c.cert_type}</td>
                    <td>{fmtDate(c.expires_at)}</td>
                    <td><Pill value={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>

      {detail && (
        <Modal title={`${detail.name} (${detail.crew_code})`} onClose={() => setDetail(null)} wide printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
            {canReport && <button className="btn btn-primary" onClick={() => setDocument({ crew_id: detail.id })}>Generate document</button>}
          </>}>
          {detail.region?.center_lat != null && (
            <ViewMap
              height={200}
              center={{ lat: detail.region.center_lat, lng: detail.region.center_lng }}
              markers={[
                { lat: detail.region.center_lat, lng: detail.region.center_lng, label: detail.region.name, sub: `${detail.name} (home region)`, color: '#14532d' },
                ...(detail.members || []).filter((m) => m.person?.latitude != null).map((m) => ({ lat: m.person.latitude, lng: m.person.longitude, label: `${m.person.first_name} ${m.person.last_name}`, color: '#2563eb', radius: 4 })),
              ]}
            />
          )}
          <div className="grid grid-2 mt">
            <div>
              <div className="kv">
                <span className="k">Type</span><span>{detail.crew_type}</span>
                <span className="k">Status</span>
                <span>
                  <Pill value={detail.status} />
                  {detail.status_override && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>auto: {detail.derived_status}</span>}
                  {canWrite && (
                    <SearchSelect value={detail.status_override || ''} style={{ marginLeft: 8 }} onChange={(e) => setOverride(e.target.value)}>
                      <option value="">Auto</option>
                      <option value="AVAILABLE">AVAILABLE</option>
                      <option value="OFF_DUTY">OFF_DUTY</option>
                      <option value="UNAVAILABLE">UNAVAILABLE</option>
                    </SearchSelect>
                  )}
                </span>
                <span className="k">Region</span><span>{detail.region?.name}</span>
                <span className="k">Department</span><span>{detail.org_unit ? `${detail.org_unit.name} (${detail.org_unit.unit_code})` : <span className="muted">Unassigned</span>}</span>
                <span className="k">Leader</span><span>{detail.leader?.first_name} {detail.leader?.last_name}</span>
                <span className="k">Home base</span><span>{detail.home_base || '—'}</span>
              </div>
              <div className="card-head mt"><h3 className="card-title">Members</h3></div>
              <div className="tbl-wrap">
              <table>
                <thead><tr><th>#</th><th>Name</th><th>Role</th><th>Skill</th></tr></thead>
                <tbody>
                  {detail.members.map((m, i) => (
                    <tr key={m.id}><td>{i + 1}</td><td>{m.person?.first_name} {m.person?.last_name}{detail.leader_person_id === m.person_id ? ' (Leader)' : ''}</td><td>{m.role}</td><td>{m.skill_level}</td></tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            <div>
              <div className="card-head"><h3 className="card-title">Certifications</h3></div>
              <div className="tbl-wrap">
              <table>
                <thead><tr><th>Person</th><th>Cert</th><th>Expires</th><th>Status</th></tr></thead>
                <tbody>
                  {detail.certifications.map((c) => (
                    <tr key={c.id}><td>{c.person_name}</td><td>{c.cert_type}</td><td>{fmtDate(c.expires_at)}</td><td><Pill value={c.status} /></td></tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="card-head mt"><h3 className="card-title">Tasks</h3></div>
              <div className="tbl-wrap">
              <table>
                <thead><tr><th>Task</th><th>Status</th><th>Progress</th></tr></thead>
                <tbody>
                  {detail.tasks.map((t) => (
                    <tr key={t.id}><td className="mono"><a href={`/tasks/${t.id}`} className="link">{t.task_number}</a></td><td><Pill value={t.status} /></td><td><Progress pct={t.progress_pct} graded={t.progress_graded} passed={t.progress_passed} /></td></tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {document && <Document type="CREW_DETAIL" params={document} title="Crew Detail Document" onClose={() => setDocument(null)} />}

      {form && (
        <Modal title={form.id ? `Edit — ${form.name}` : 'Add Crew'} onClose={() => setForm(null)} wide
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={!canWrite}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Crew name</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Crew code</label><input value={form.crew_code || ''} onChange={(e) => setForm({ ...form, crew_code: e.target.value })} /></div>
            <div className="field"><label>Type</label>
              <SearchSelect value={form.crew_type} onChange={(e) => setForm({ ...form, crew_type: e.target.value })}>
                {['MAINTENANCE', 'INSPECTION', 'EMERGENCY_RESPONSE', 'CONSTRUCTION', 'RELAY_AND_PROTECTION', 'SUBSTATION', 'LINE'].map((t) => <option key={t}>{t}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Region</label>
              <SearchSelect value={form.region_id || ''} onChange={(e) => setForm({ ...form, region_id: Number(e.target.value) || null, org_unit_id: null })}>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Department</label>
              <SearchSelect value={form.org_unit_id || ''} onChange={(e) => setForm({ ...form, org_unit_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— unassigned —</option>
                {form.org_unit_id && !units.some((u) => u.id === form.org_unit_id) && form.org_unit && (
                  <option value={form.org_unit_id}>{form.org_unit.name}</option>
                )}
                {units.filter((u) => !form.region_id || u.region_id === form.region_id).map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.unit_code})</option>
                ))}
              </SearchSelect></div>
            <div className="field"><label>Crew leader</label>
              <SearchSelect value={form.leader_person_id || ''} onChange={(e) => promoteLeader(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— none —</option>
                {form.leader_person_id && !peopleInRegion(people, form.region_id).some((p) => p.id === form.leader_person_id) && (
                  <option value={form.leader_person_id}>{personLabel(people.find((p) => p.id === form.leader_person_id) || { id: form.leader_person_id })}</option>
                )}
                {peopleInRegion(people, form.region_id).map((p) => <option key={p.id} value={p.id}>{personLabel(p)}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Home base</label><input value={form.home_base || ''} onChange={(e) => setForm({ ...form, home_base: e.target.value })} /></div>
            <div className="field"><label>Status override</label>
              <SearchSelect value={form.status_override || ''} onChange={(e) => setForm({ ...form, status_override: e.target.value || null })}>
                <option value="">Auto</option>
                <option value="AVAILABLE">AVAILABLE</option>
                <option value="OFF_DUTY">OFF_DUTY</option>
                <option value="UNAVAILABLE">UNAVAILABLE</option>
              </SearchSelect></div>
          </div>

          <h4 className="mt">Crew members</h4>
          <div className="muted mb" style={{ fontSize: 12 }}>Set each member's role and skill level, then use the arrows to arrange their order. The member marked CREW_LEADER is the crew leader. # 1 is displayed first.</div>
          {form.members.length === 0 && <div className="muted mb">No members yet — pick people below and click Add.</div>}
          {form.members.map((m, i) => (
            <div key={m._k} className="flex" style={{ padding: '4px 0', borderTop: i === 0 ? '1px solid #e2e8f0' : 'none' }}>
              <span className="muted" style={{ width: 24, fontWeight: 700 }}>{i + 1}</span>
              <div style={{ flex: 2, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{m.name}{form.leader_person_id === m.person_id && <span className="pill" style={{ background: '#14532d', color: '#fff', marginLeft: 6 }}>Leader</span>}</div>
                {m.title && <div className="muted" style={{ fontSize: 12 }}>{m.title}</div>}
              </div>
              <SearchSelect title="Role" value={m.role} onChange={(e) => changeRole(i, e.target.value)} style={{ width: 150 }} disabled={!canWrite}>
                {!CREW_ROLES.includes(m.role) && <option value={m.role}>{m.role}</option>}
                {CREW_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </SearchSelect>
              <SearchSelect title="Skill level" value={m.skill_level} onChange={(e) => updateMember(i, { skill_level: e.target.value })} style={{ width: 120 }} disabled={!canWrite}>
                {!CREW_SKILLS.includes(m.skill_level) && <option value={m.skill_level}>{m.skill_level}</option>}
                {CREW_SKILLS.map((s) => <option key={s} value={s}>{s}</option>)}
              </SearchSelect>
              <button className="btn btn-sm" onClick={() => moveMember(i, -1)} disabled={i === 0}>↑</button>
              <button className="btn btn-sm" onClick={() => moveMember(i, 1)} disabled={i === form.members.length - 1}>↓</button>
              <ConfirmButton label="Delete" title={`Remove ${m.name}?`} onConfirm={() => removeMember(i)} />
            </div>
          ))}
          <div className="mt" style={{ display: 'flex', gap: 8 }}>
            <SearchSelect value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1 }}>
              <option value="">— select person to add —</option>
              {peopleInRegion(available, form.region_id).map((p) => <option key={p.id} value={p.id}>{personLabel(p)}{p.title ? ` — ${p.title}` : ''}</option>)}
            </SearchSelect>
            <button className="btn" disabled={!canWrite || !pick} onClick={() => { if (pick) addMember(Number(pick)); }}>+ Add</button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
