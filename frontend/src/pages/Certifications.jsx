import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, ConfirmButton, PrintButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';

const CERT_TYPES = ['LIVE_LINE', 'HEIGHT_WORK', 'FIRST_AID', 'SWITCHING_AUTHORITY', 'SF6_HANDLING', 'HVDC_QUALIFIED', 'CONFINED_SPACE', 'HV_TESTING', 'TOWER_CLIMBING', 'DIGGER_OPERATOR'];
const STATUSES = ['VALID', 'EXPIRED'];

const blank = { person_id: null, cert_type: 'FIRST_AID', issuing_body: '', issued_at: '', expires_at: '', status: 'VALID' };

function daysUntil(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 864e5);
}

function certPill(c) {
  if (c.status === 'EXPIRED') return <Pill value="EXPIRED" />;
  const days = daysUntil(c.expires_at);
  if (days == null) return <Pill value="NO EXPIRY" />;
  if (days < 0) return <Pill value="EXPIRED" />;
  if (days <= 90) return <Pill value="EXPIRING" />;
  return <Pill value="VALID" />;
}

export default function Certifications() {
  const canWrite = can(getStoredUser(), 'cert:write');
  const [rows, setRows] = useState(null);
  const [people, setPeople] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [sp] = useSearchParams();
  const [personFilter, setPersonFilter] = useState(sp.get('person') || '');
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const { query, setQuery, results } = useSearchFilter(rows);

  const load = () => {
    const q = new URLSearchParams();
    if (statusFilter) q.set('status', statusFilter);
    if (personFilter) q.set('person_id', personFilter);
    const qs = q.toString();
    return api.get(`/certifications${qs ? `?${qs}` : ''}`).then(setRows).catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
    api.get('/people').then(setPeople).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, personFilter]);

  async function save() {
    try {
      if (form.id) await api.put(`/certifications/${form.id}`, form);
      else await api.post('/certifications', form);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(c) {
    try { await api.del(`/certifications/${c.id}`); load(); } catch (e) { setError(e.message); }
  }

  async function checkStatus() {
    setMsg(null);
    try {
      const r = await api.post('/certifications/check-status');
      setMsg(`Status check complete — ${r.updated} of ${r.total} certifications refreshed.`);
      load();
      setTimeout(() => setMsg(null), 4000);
    } catch (e) { setError(e.message); }
  }

  if (!rows && error) return <Page title="Certifications"><ErrorNote error={error} /></Page>;
  if (!rows) return <Page title="Certifications"><Loading /></Page>;

  const personName = (id) => {
    const p = people.find((x) => x.id === id);
    return p ? `${p.first_name} ${p.last_name}` : `Person #${id}`;
  };

  return (
    <Page title="Certifications" crumbs="TMMS / Validation & Compliance"
      actions={<>
        {canWrite && <button className="btn btn-sm" onClick={checkStatus}>⟳ Check &amp; refresh status</button>}
        <PrintButton />
        {canWrite && <button className="btn btn-primary" onClick={() => setForm({ ...blank, person_id: people[0]?.id || null })}>+ Add Certification</button>}
      </>}>
      {error && <ErrorNote error={error} />}
      {msg && <div className="alert alert-success">{msg}</div>}

      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search certifications…" />
        <SearchSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="VALID">VALID</option>
          <option value="EXPIRED">EXPIRED</option>
        </SearchSelect>
        <SearchSelect value={personFilter} onChange={(e) => setPersonFilter(e.target.value)}>
          <option value="">All personnel</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
        </SearchSelect>
        <span className="muted">{results.length} of {rows.length} certifications</span>
      </div>

      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Person</th><th>Certification</th><th>Issuing body</th><th>Issued</th><th>Expires</th><th>Days left</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {results.map((c) => {
                const days = daysUntil(c.expires_at);
                return (
                  <tr key={c.id}>
                    <td>{c.person ? `${c.person.first_name} ${c.person.last_name}` : personName(c.person_id)}</td>
                    <td><b>{c.cert_type}</b></td>
                    <td>{c.issuing_body || '—'}</td>
                    <td className="nowrap">{fmtDate(c.issued_at)}</td>
                    <td className="nowrap">{fmtDate(c.expires_at)}</td>
                    <td className="nowrap">{days == null ? '—' : days < 0 ? <b className="overdue">{days} d</b> : days <= 90 ? <b className="warn">{days} d</b> : days}</td>
                    <td>{certPill(c)}</td>
                    <td className="nowrap">
                      {canWrite && <button className="btn btn-sm" onClick={() => setForm({ ...c })}>Edit</button>}{' '}
                      {canWrite && <ConfirmButton label="Delete" onConfirm={() => remove(c)} title={`Delete ${c.cert_type} for ${personName(c.person_id)}?`} />}
                    </td>
                  </tr>
                );
              })}
              {results.length === 0 && <tr><td colSpan={8} className="muted center">{query ? 'No certifications match your search.' : 'No certifications found.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {form && (
        <Modal title={form.id ? `Edit — ${form.cert_type}` : 'Add Certification'} onClose={() => setForm(null)} printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>{form.id ? 'Save changes' : 'Add'}</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Person</label>
              <SearchSelect value={form.person_id || ''} onChange={(e) => setForm({ ...form, person_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— select —</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name} — {p.role || ''}</option>)}
              </SearchSelect></div>
            <div className="field full"><label>Certification type</label>
              <SearchSelect value={form.cert_type} onChange={(e) => setForm({ ...form, cert_type: e.target.value })}>
                {CERT_TYPES.map((t) => <option key={t}>{t}</option>)}
              </SearchSelect></div>
            <div className="field full"><label>Issuing body</label><input value={form.issuing_body || ''} onChange={(e) => setForm({ ...form, issuing_body: e.target.value })} placeholder="e.g. NERC-Accredited" /></div>
            <div className="field"><label>Issued date</label><input type="date" value={form.issued_at || ''} onChange={(e) => setForm({ ...form, issued_at: e.target.value })} /></div>
            <div className="field"><label>Expires</label><input type="date" value={form.expires_at || ''} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></div>
            <div className="field"><label>Status</label>
              <SearchSelect value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </SearchSelect></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
