import { useEffect, useState } from 'react';
import { api, fmtDate, STATUS_COLORS } from '../api';
import { Page, StatCard, Pill, Loading, ErrorNote } from '../components';
import { BarRow } from '../components/InfraVisuals';

const TITLE = 'Operations Dashboard';
const CRUMBS = 'TMMS / Overview';

export default function Overview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/summary').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <Page title={TITLE} crumbs={CRUMBS}><ErrorNote error={error} /></Page>;
  if (!data) return <Page title={TITLE} crumbs={CRUMBS}><Loading /></Page>;

  const { counts, tasks, gps, condition, region_activity, recent_tasks, cert_expiring_90d } = data;

  return (
    <Page title={TITLE} crumbs={CRUMBS}>
      <div className="grid grid-4">
        <StatCard label="Regions" value={counts.regions} />
        <StatCard label="Substations" value={counts.substations} />
        <StatCard label="Transmission Lines" value={counts.lines} sub={`${counts.towers} towers`} />
        <StatCard label="Assets" value={counts.assets} sub={`${counts.crews} field crews`} />
      </div>

      <div className="grid grid-4 mt">
        <StatCard label="Open Tasks" value={tasks.open} sub={`${tasks.overdue} overdue`} color={tasks.overdue ? '#dc2626' : undefined} />
        <StatCard label="Completion Rate" value={`${tasks.completion_rate}%`} sub={`${tasks.completed} completed of ${tasks.total}`} />
        <StatCard label="GPS Validation" value={`${gps.coverage}%`} sub={`${gps.validated_assets} of ${gps.total_assets} assets validated`} />
        <StatCard label="Certs Expiring ≤90d" value={cert_expiring_90d} color={cert_expiring_90d ? '#d97706' : undefined} />
      </div>

      <h3 className="section-title">Open Task Mix</h3>
      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="card-head"><h3 className="card-title">By Status</h3></div>
          <TaskBreakdown rows={Object.entries(tasks.by_status)} />
        </div>
        <div className="card card-pad">
          <div className="card-head"><h3 className="card-title">Open Tasks by Type</h3></div>
          <TaskBreakdown rows={Object.entries(tasks.by_type)} />
        </div>
      </div>

      <h3 className="section-title">Asset Condition (health distribution)</h3>
      <div className="card card-pad">
        <BarRow label="Critical (1–3)" value={condition.critical} max={counts.assets} color="#dc2626" sub={`${Math.round(condition.critical / (counts.assets || 1) * 100)}%`} />
        <BarRow label="Poor (4–5)" value={condition.poor} max={counts.assets} color="#ea580c" sub={`${Math.round(condition.poor / (counts.assets || 1) * 100)}%`} />
        <BarRow label="Fair (6–7)" value={condition.fair} max={counts.assets} color="#d97706" sub={`${Math.round(condition.fair / (counts.assets || 1) * 100)}%`} />
        <BarRow label="Good (8–10)" value={condition.good} max={counts.assets} color="#16a34a" sub={`${Math.round(condition.good / (counts.assets || 1) * 100)}%`} />
      </div>

      <h3 className="section-title">Regional Activity</h3>
      <div className="card">
        <div className="tbl-wrap">
        <table>
          <thead><tr><th>Region</th><th>Open Tasks</th><th>Overdue</th><th>GPS Validations</th><th>GPS Failures</th></tr></thead>
          <tbody>
            {region_activity.map((r) => (
              <tr key={r.code}>
                <td className="mono">{r.name}</td>
                <td>{r.open_tasks}</td>
                <td>{r.overdue > 0 ? <b className="overdue">{r.overdue}</b> : r.overdue}</td>
                <td>{r.gps_validation_count}</td>
                <td>{r.gps_fail_count > 0 ? <b className="overdue">{r.gps_fail_count}</b> : r.gps_fail_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <h3 className="section-title">Recent Tasks</h3>
      <div className="card">
        <div className="tbl-wrap">
        <table>
          <thead><tr><th>Task</th><th>Type</th><th>Status</th><th>Due</th><th>Crew</th></tr></thead>
          <tbody>
            {recent_tasks.map((t) => (
              <tr key={t.id} onClick={() => (window.location.href = `/tasks/${t.id}`)} style={{ cursor: 'pointer' }}>
                <td><span className="mono">{t.task_number}</span><br /><span>{t.title}</span></td>
                <td>{t.task_type}</td>
                <td><Pill value={t.status} /></td>
                <td>{fmtDate(t.due_date)}</td>
                <td>{t.crew?.name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </Page>
  );
}

function TaskBreakdown({ rows }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex space-b">
          <span><Pill value={k} /></span>
          <b>{v}</b>
        </div>
      ))}
    </div>
  );
}
