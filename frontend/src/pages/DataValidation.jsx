import { useEffect, useState } from 'react';
import { api } from '../api';
import { Page, Loading, ErrorNote } from '../components';
import { KpiTile } from '../components/InfraVisuals';
import { can, getStoredUser } from '../auth';

export default function DataValidation({ embedded }) {
  const canWrite = can(getStoredUser(), 'tower:write') || can(getStoredUser(), 'asset:write');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => { setError(null); return api.get('/infrastructure/validation').then(setData).catch((e) => setError(e.message)); };
  useEffect(() => { load(); }, []);

  async function reconcile() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await api.post('/infrastructure/reconcile', {});
      setNotice(`Reconciled: ${r.substations_fixed} substation(s), ${r.lines_fixed} line(s), ${r.mirrors_created} mirror(s) created, ${r.towers_fixed} tower(s) updated.`);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (error && !data) return <ErrorNote error={error} />;
  if (!data) return embedded ? <Loading /> : <Page title="Data validation"><Loading /></Page>;

  const body = (
    <>
      {error && <ErrorNote error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <div className="grid grid-3 mb">
        <KpiTile label="Issues" value={data.summary.issues} />
        <KpiTile label="Towers" value={data.summary.towers} />
        <KpiTile label="Substations" value={data.summary.substations} />
      </div>
      {canWrite && <div className="mb"><button className="btn btn-primary" disabled={busy} onClick={reconcile}>{busy ? 'Reconciling…' : 'Reconcile counts & mirrors'}</button></div>}

      <div className="card card-pad mb">
        <div className="card-head"><h3 className="card-title">Lines</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Line</th><th>tower_count</th><th>Actual</th><th>Missing mirrors</th><th>Non-standard towers</th></tr></thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td><b>{l.line_id}</b> <span className="muted">{l.name}</span></td>
                  <td>{l.tower_count}</td>
                  <td>{l.actual_tower_count}</td>
                  <td>{l.missing_mirrors}</td>
                  <td>{l.non_standard_towers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad mb">
        <div className="card-head"><h3 className="card-title">Non-standard towers</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Tower</th><th>Type</th><th>Recorded/Standard</th><th>Missing</th><th>Extra</th><th>Qty mismatch</th></tr></thead>
            <tbody>
              {data.towers.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.tower_id}</td>
                  <td>{t.tower_type}</td>
                  <td>{t.recorded_count}/{t.standard_count}</td>
                  <td>{t.missing.join(', ') || '—'}</td>
                  <td>{t.extra.join(', ') || '—'}</td>
                  <td>{t.qty_mismatches.map((m) => `${m.component_type} ${m.actual}≠${m.expected}`).join(', ') || '—'}</td>
                </tr>
              ))}
              {data.towers.length === 0 && <tr><td colSpan="6" className="empty">All towers match their type standard</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-head"><h3 className="card-title">Substation bays</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Substation</th><th>bay_count</th><th>Actual bays</th></tr></thead>
            <tbody>
              {data.substations.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.substation_id}</b> <span className="muted">{s.name}</span></td>
                  <td>{s.bay_count}</td>
                  <td style={{ color: Number(s.bay_count) !== Number(s.actual_bay_count) ? '#b45309' : undefined }}>{s.actual_bay_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  if (embedded) return body;
  return <Page title="Data validation" crumbs="TMMS / Infrastructure">{body}</Page>;
}
