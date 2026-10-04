import { useEffect, useState } from 'react';
import { SearchSelect, Page, Empty, ErrorNote, Loading, Modal, Pill } from '../components';
import { api, fmtDateTime } from '../api';
import { t, setLanguage, LOCALES } from '../i18n';
import { can, getStoredUser } from '../auth';
import { peopleInRegion } from '../cascade';

const ROLES = ['ADMIN', 'EXECUTIVE', 'VIEWER', 'AUDITOR', 'REGION_DIRECTOR', 'REGION_MANAGER', 'OT_MANAGER', 'SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER', 'SUPERVISOR', 'PLANNER', 'DISPATCHER', 'CREW_LEAD', 'CREW_MEMBER', 'FIELD_CREW'];
const LEGACY_ROLES = new Set(['SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER']);

export default function Settings() {
  const [tab, setTab] = useState('settings');
  const [cfg, setCfg] = useState(null);
  const [audit, setAudit] = useState([]);
  const [users, setUsers] = useState([]);
  const [regions, setRegions] = useState([]);
  const [people, setPeople] = useState([]);
  const [userForm, setUserForm] = useState(null);
  const [personForm, setPersonForm] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const me = getStoredUser();
  const isAdmin = me?.role === 'ADMIN';
  const canAudit = isAdmin || can(me, 'audit:read');

  function load() {
    setError('');
    api.get('/settings').then(setCfg).catch((e) => setError(e.message));
    if (tab === 'audit') api.get('/audit?limit=100').then(setAudit).catch(() => {});
    if (tab === 'users') {
      api.get('/users').then(setUsers).catch(() => {});
      api.get('/regions').then(setRegions).catch(() => {});
      api.get('/people').then(setPeople).catch(() => {});
    }
    if (tab === 'persons') {
      api.get('/people').then(setPeople).catch(() => {});
      api.get('/regions').then(setRegions).catch(() => {});
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tab]);

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      const updated = await api.put('/settings', cfg);
      setCfg(updated);
      setMsg(t('settingsUpdated'));
      window.location.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));

  function changeLanguage(e) {
    const code = e.target.value;
    const next = { ...cfg, language: code };
    setCfg(next);
    setLanguage(code);
    api.put('/settings', next).catch(() => {}).finally(() => window.location.reload());
  }

  async function saveUser() {
    setError('');
    setMsg('');
    try {
      if (userForm.id) {
        await api.patch(`/users/${userForm.id}`, {
          role: userForm.role,
          region_id: userForm.region_id || null,
          person_id: userForm.person_id || null,
          active: userForm.active ? 1 : 0,
          password: userForm.password || undefined,
        });
        setMsg(t('userSaved'));
      } else {
        if (!userForm.username || !userForm.password || !userForm.role) {
          setError('Username, password and role are required.');
          return;
        }
        await api.post('/users', {
          username: userForm.username.trim(),
          password: userForm.password.trim(),
          role: userForm.role,
          region_id: userForm.region_id || null,
          person_id: userForm.person_id || null,
          active: userForm.active === undefined ? 1 : userForm.active ? 1 : 0,
        });
        setMsg(t('userCreated'));
      }
      setUserForm(null);
      api.get('/users').then(setUsers).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }

  async function toggleUser(u) {
    setMsg('');
    try {
      await api.patch(`/users/${u.id}`, { active: u.active ? 0 : 1 });
      setMsg(u.active ? t('userDeactivated') : t('userActivated'));
      api.get('/users').then(setUsers).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteUser(u) {
    if (!window.confirm(t('confirmDeleteUser'))) return;
    setMsg('');
    try {
      await api.del(`/users/${u.id}`);
      setMsg(t('userDeleted'));
      api.get('/users').then(setUsers).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }

  async function savePerson() {
    setError('');
    setMsg('');
    try {
      if (!personForm.first_name || !personForm.last_name || !personForm.role) {
        setError(t('requiredPerson'));
        return;
      }
      const payload = {
        first_name: personForm.first_name,
        last_name: personForm.last_name,
        role: personForm.role,
        phone: personForm.phone || null,
        email: personForm.email || null,
        title: personForm.title || null,
        active: personForm.active ? 1 : 0,
      };
      if (personForm.region_id) payload.region_id = Number(personForm.region_id);
      if (personForm.id) {
        await api.patch(`/people/${personForm.id}`, payload);
        setMsg(t('personSaved'));
      } else {
        await api.post('/people', payload);
        setMsg(t('personCreated'));
      }
      setPersonForm(null);
      api.get('/people').then(setPeople).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }

  async function togglePerson(p) {
    setMsg('');
    try {
      await api.patch(`/people/${p.id}`, { active: p.active ? 0 : 1 });
      setMsg(p.active ? t('personDeactivated') : t('personActivated'));
      api.get('/people').then(setPeople).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }

  async function deletePerson(p) {
    if (!window.confirm(t('confirmDeletePerson'))) return;
    setMsg('');
    try {
      await api.del(`/people/${p.id}`);
      setMsg(t('personDeleted'));
      api.get('/people').then(setPeople).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }

  const tabs = [
    { id: 'settings', label: t('globalSettings') },
  ];
  if (canAudit) tabs.push({ id: 'audit', label: t('auditLog') });
  if (can(me, 'people:read')) tabs.push({ id: 'persons', label: t('persons') });
  if (isAdmin) tabs.push({ id: 'users', label: t('users') });

  // The linked-person picker narrows to the account's region; a person already
  // attached from another region is kept visible so the edit is not destructive.
  const userFormPeople = peopleInRegion(people, userForm?.region_id);
  const staleUserPerson = userForm?.person_id && !userFormPeople.some((p) => String(p.id) === String(userForm.person_id))
    ? people.find((p) => String(p.id) === String(userForm.person_id))
    : null;

  return (
    <Page title={t('settings')} crumbs="TMMS / System">
      <div className="tabs">
        {tabs.map((x) => (
          <button key={x.id} className={'tab' + (tab === x.id ? ' active' : '')} onClick={() => setTab(x.id)}>{x.label}</button>
        ))}
      </div>
      <ErrorNote error={error} />
      {msg && <div className="alert alert-success">{msg}</div>}

      {tab === 'settings' && !cfg && !error && <Loading />}
      {tab === 'settings' && !cfg && error && <ErrorNote error={error} />}
      {tab === 'settings' && cfg && (
        <div className="card card-pad">
          <div className="grid2">
            <label>{t('language')}
              <SearchSelect value={cfg.language} onChange={changeLanguage}>
                {Object.entries(LOCALES).map(([code, l]) => (
                  <option key={code} value={code}>{l.label}</option>
                ))}
              </SearchSelect>
            </label>
            <label>{t('units')}
              <SearchSelect value={cfg.unit_system} onChange={set('unit_system')}>
                <option value="metric">{t('metric')}</option>
                <option value="imperial">{t('imperial')}</option>
              </SearchSelect>
            </label>
            <label>{t('gridFrequency')}
              <SearchSelect value={cfg.grid_frequency_hz} onChange={set('grid_frequency_hz')}>
                <option value="50">50 Hz</option>
                <option value="60">60 Hz</option>
              </SearchSelect>
            </label>
            <label>{t('currency')}
              <input value={cfg.currency || ''} onChange={set('currency')} />
            </label>
            <label>{t('timezone')}
              <input value={cfg.timezone || ''} onChange={set('timezone')} placeholder="UTC" />
            </label>
            <label>Date locale
              <input value={cfg.date_locale || ''} onChange={set('date_locale')} placeholder="en-US" />
            </label>
          </div>
          <div className="actions mt">
            {isAdmin && <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('loading') : t('save')}</button>}
            {!isAdmin && <span className="muted">Only administrators can change global settings.</span>}
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card card-pad">
          {audit.length === 0 ? <Empty /> : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t('timestamp')}</th><th>{t('actor')}</th><th>{t('action')}</th><th>{t('entity')}</th><th>{t('entityId')}</th></tr></thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{fmtDateTime(a.created_at)}</td>
                      <td>{a.actor}</td>
                      <td>{a.action}</td>
                      <td>{a.entity}</td>
                      <td>{a.entity_id ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'users' && isAdmin && (
        <div>
          <div className="actions mb">
            <button className="btn btn-primary" onClick={() => setUserForm({ username: '', password: '', role: 'VIEWER', region_id: me?.region_id || '', person_id: '', active: true })}>+ {t('addUser')}</button>
          </div>
          <div className="card card-pad">
            {users.length === 0 ? <Empty /> : (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>{t('username')}</th><th>{t('name')}</th><th>{t('role')}</th><th>{t('region')}</th><th>{t('status')}</th><th>{t('createdAt')}</th><th></th></tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td><b>{u.username}</b>{u.id === me?.id && <span className="muted"> (you)</span>}</td>
                        <td>{u.first_name ? `${u.first_name} ${u.last_name}` : '—'}</td>
                        <td>{u.role}</td>
                        <td>{regions.find((r) => r.id === u.region_id)?.name || (u.region_id ? `#${u.region_id}` : t('allRegions'))}</td>
                        <td>{u.active ? <Pill value="ACTIVE">{t('statusActive')}</Pill> : <Pill value="INACTIVE">{t('statusInactive')}</Pill>}</td>
                        <td className="nowrap">{fmtDateTime(u.created_at)}</td>
                        <td className="td-actions">
                          <button className="btn btn-sm" onClick={() => setUserForm({ id: u.id, username: u.username, password: '', role: u.role, region_id: u.region_id || '', person_id: u.person_id || '', active: !!u.active })}>{t('edit')}</button>{' '}
                          <button className="btn btn-sm" onClick={() => toggleUser(u)}>{u.active ? t('deactivate') : t('activate')}</button>{' '}
                          {u.id !== me?.id && <button className="btn btn-sm btn-danger" onClick={() => deleteUser(u)}>{t('delete')}</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {userForm && (
            <Modal title={userForm.id ? `${t('editUser')} — ${userForm.username}` : t('newUser')} onClose={() => setUserForm(null)}
              footer={<>
                <button className="btn" onClick={() => setUserForm(null)}>{t('cancel')}</button>
                <button className="btn btn-primary" onClick={saveUser}>{t('save')}</button>
              </>}>
              <div className="form-grid">
                <div className="field"><label>{t('username')}</label><input disabled={!!userForm.id} value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} /></div>
                <div className="field"><label>{t('password')}{userForm.id && <span className="muted"> — {t('passwordHint')}</span>}</label><input type="password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} /></div>
                <div className="field"><label>{t('role')}</label>
                  <SearchSelect value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>
                    {ROLES.map((r) => <option key={r}>{LEGACY_ROLES.has(r) ? `${r} (legacy)` : r}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>{t('region')}</label>
                  <SearchSelect value={userForm.region_id} onChange={(e) => setUserForm({ ...userForm, region_id: e.target.value, person_id: '' })}>
                    <option value="">{t('allRegions')}</option>
                    {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>{t('linkedPerson')}</label>
                  <SearchSelect value={userForm.person_id} onChange={(e) => setUserForm({ ...userForm, person_id: e.target.value })}>
                    <option value="">— {t('none')} —</option>
                    {userForm.person_id && !userFormPeople.some((p) => String(p.id) === String(userForm.person_id)) && (
                      <option value={userForm.person_id}>{staleUserPerson ? `${staleUserPerson.first_name} ${staleUserPerson.last_name}` : `Person #${userForm.person_id}`}</option>
                    )}
                    {userFormPeople.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>{t('status')}</label>
                  <SearchSelect value={userForm.active ? 1 : 0} onChange={(e) => setUserForm({ ...userForm, active: Number(e.target.value) === 1 })}>
                    <option value={1}>{t('statusActive')}</option>
                    <option value={0}>{t('statusInactive')}</option>
                  </SearchSelect></div>
              </div>
              {userForm.id && <p className="muted mt">{t('passwordHint')}</p>}
            </Modal>
          )}
        </div>
      )}

      {tab === 'persons' && can(me, 'people:read') && (
        <div>
          {can(me, 'people:write') && (
            <div className="actions mb">
              <button className="btn btn-primary" onClick={() => setPersonForm({ first_name: '', last_name: '', role: '', phone: '', email: '', title: '', region_id: '', active: true })}>+ {t('addPerson')}</button>
            </div>
          )}
          <div className="card card-pad">
            {people.length === 0 ? <Empty /> : (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>{t('firstName')}</th><th>{t('lastName')}</th><th>{t('personRole')}</th><th>{t('phone')}</th><th>{t('email')}</th><th>{t('regionAssignment')}</th><th>{t('status')}</th><th></th></tr></thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.id}>
                        <td><b>{p.first_name}</b></td>
                        <td>{p.last_name}</td>
                        <td>{p.role}{p.title && <div className="muted" style={{ fontSize: 11 }}>{p.title}</div>}</td>
                        <td>{p.phone || '—'}</td>
                        <td>{p.email || '—'}</td>
                        <td>{(p.regions || []).map((r) => r.name).join(', ') || '—'}</td>
                        <td>{p.active ? <Pill value="ACTIVE">{t('statusActive')}</Pill> : <Pill value="INACTIVE">{t('statusInactive')}</Pill>}</td>
                        <td className="td-actions">
                          {can(me, 'people:write') && (
                            <>
                              <button className="btn btn-sm" onClick={() => setPersonForm({
                                id: p.id, first_name: p.first_name, last_name: p.last_name, role: p.role,
                                phone: p.phone || '', email: p.email || '', title: p.title || '',
                                region_id: (p.regions || [])[0]?.id || '', active: !!p.active,
                              })}>{t('edit')}</button>{' '}
                              <button className="btn btn-sm" onClick={() => togglePerson(p)}>{p.active ? t('deactivate') : t('activate')}</button>{' '}
                              <button className="btn btn-sm btn-danger" onClick={() => deletePerson(p)}>{t('delete')}</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {personForm && can(me, 'people:write') && (
            <Modal title={personForm.id ? `${t('editPerson')} — ${personForm.first_name} ${personForm.last_name}` : t('newPerson')} onClose={() => setPersonForm(null)}
              footer={<>
                <button className="btn" onClick={() => setPersonForm(null)}>{t('cancel')}</button>
                <button className="btn btn-primary" onClick={savePerson}>{t('save')}</button>
              </>}>
              <div className="form-grid">
                <div className="field"><label>{t('firstName')} *</label><input value={personForm.first_name} onChange={(e) => setPersonForm({ ...personForm, first_name: e.target.value })} /></div>
                <div className="field"><label>{t('lastName')} *</label><input value={personForm.last_name} onChange={(e) => setPersonForm({ ...personForm, last_name: e.target.value })} /></div>
                <div className="field"><label>{t('personRole')} *</label>
                  <SearchSelect value={personForm.role} onChange={(e) => setPersonForm({ ...personForm, role: e.target.value })}>
                    <option value="">—</option>
                    {['MEMBER', 'LEAD', 'TECHNICIAN', 'ENGINEER', 'MANAGER', 'INSPECTOR', 'CREW_LEAD'].map((r) => <option key={r}>{r}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>{t('personTitle')}</label><input value={personForm.title} onChange={(e) => setPersonForm({ ...personForm, title: e.target.value })} /></div>
                <div className="field"><label>{t('phone')}</label><input value={personForm.phone} onChange={(e) => setPersonForm({ ...personForm, phone: e.target.value })} /></div>
                <div className="field"><label>{t('email')}</label><input value={personForm.email} onChange={(e) => setPersonForm({ ...personForm, email: e.target.value })} /></div>
                <div className="field"><label>{t('regionAssignment')}</label>
                  <SearchSelect value={personForm.region_id} onChange={(e) => setPersonForm({ ...personForm, region_id: e.target.value })}>
                    <option value="">— {t('none')} —</option>
                    {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>{t('status')}</label>
                  <SearchSelect value={personForm.active ? 1 : 0} onChange={(e) => setPersonForm({ ...personForm, active: Number(e.target.value) === 1 })}>
                    <option value={1}>{t('statusActive')}</option>
                    <option value={0}>{t('statusInactive')}</option>
                  </SearchSelect></div>
              </div>
            </Modal>
          )}
        </div>
      )}
    </Page>
  );
}
