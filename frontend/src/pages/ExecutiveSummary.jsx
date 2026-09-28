import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtDate, fmtDateTime } from '../api';
import { ErrorNote, Loading, Page, Pill } from '../components';
import { BarRow, KpiTile } from '../components/InfraVisuals';

const SECTIONS = [
  ['portfolio', 'Portfolio'], ['assets', 'Asset mix & value'], ['execution', 'Execution & cost'], ['people', 'People & readiness'],
];

export default function ExecutiveSummary() {
  const [summary, setSummary] = useState(null);
  const [tab, setTab] = useState('portfolio');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/executive/summary').then(setSummary).catch((e) => setError(e.message));
  }, []);

  if (error) return <Page title="Executive Summary" crumbs="TMMS / Executive"><ErrorNote error={error} /></Page>;
  if (!summary) return <Page title="Executive Summary" crumbs="TMMS / Executive"><Loading /></Page>;

  const portfolio = summary.portfolio;
  const currency = summary.currency;
  return (
    <Page title="Executive Summary" crumbs="TMMS / Executive">
      <section className="executive-brief">
        <div><div className="eyebrow">Portfolio intelligence</div><h1>System performance</h1></div>
        <div className="muted">Updated {fmtDateTime(summary.generated_at)}</div>
      </section>
      <div className="executive-kpis">
        <KpiTile label="Asset population" value={portfolio.assets.toLocaleString()} sub={`${portfolio.lines} lines · ${portfolio.towers} towers`} />
        <KpiTile label="Current asset value" value={fmtMoney(summary.valuation.current, currency)} sub={`RCN ${fmtMoney(summary.valuation.rcn, currency)}`} />
        <KpiTile label="Open maintenance" value={portfolio.open_tasks} sub={`${portfolio.overdue_tasks} overdue`} tone={portfolio.overdue_tasks ? 'bad' : undefined} />
        <KpiTile label="12-month maintenance cost" value={fmtMoney(summary.maintenance_cost.totals.spend, currency)} sub={`${summary.maintenance_cost.totals.count} recorded events`} />
      </div>
      <nav className="executive-tabs" role="tablist" aria-label="Executive summary sections">
        {SECTIONS.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={'executive-tab' + (tab === key ? ' active' : '')} onClick={() => setTab(key)}>{label}</button>)}
      </nav>

      {tab === 'portfolio' && (
        <div className="executive-section">
          <div className="executive-grid">
            <section className="exec-panel">
              <h2>Infrastructure estate</h2>
              <div className="exec-stat-grid">
                <ExecStat label="Regions" value={portfolio.regions} />
                <ExecStat label="Substations" value={portfolio.substations} />
                <ExecStat label="Transmission lines" value={portfolio.lines} />
                <ExecStat label="Field crews" value={portfolio.crews} />
              </div>
              <h3>Task status</h3>
              <div className="tbl-wrap"><table><thead><tr><th>Status</th><th>Tasks</th></tr></thead><tbody>
                {Object.entries(summary.tasks.by_status).map(([status, count]) => <tr key={status}><td><Pill value={status} /></td><td>{count}</td></tr>)}
              </tbody></table></div>
              <h3>Task numbering</h3>
              <div className="exec-stat-grid">
                <ExecStat label="Tasks issued (all time)" value={summary.tasks.total ?? 0} />
                {Object.entries(summary.tasks.by_number_year || {}).sort(([a], [b]) => b.localeCompare(a)).map(([year, count]) => (
                  <ExecStat key={year} label={year === 'Unnumbered' ? year : `Issued ${year}`} value={count} />
                ))}
              </div>
              <div className="tbl-wrap"><table><thead><tr><th>Task type</th><th>All</th><th>Open</th></tr></thead><tbody>
                {Object.keys(summary.tasks.by_type_all || summary.tasks.by_type || {}).map((type) => (
                  <tr key={type}>
                    <td>{type.replace(/_/g, ' ')}</td>
                    <td>{(summary.tasks.by_type_all || {})[type] ?? '—'}</td>
                    <td>{(summary.tasks.by_type || {})[type] ?? 0}</td>
                  </tr>
                ))}
              </tbody></table></div>
            </section>
            <section className="exec-panel">
              <h2>Management recommendations</h2>
              <ol className="exec-recommendations">{summary.recommendations.map((text, index) => <li key={index}>{text}</li>)}</ol>
              <h3>Condition distribution</h3>
              <BarRow label="Critical · 1–3" value={summary.condition.critical} max={portfolio.assets} color="#dc2626" />
              <BarRow label="Poor · 4–5" value={summary.condition.poor} max={portfolio.assets} color="#ea580c" />
              <BarRow label="Fair · 6–7" value={summary.condition.fair} max={portfolio.assets} color="#d97706" />
              <BarRow label="Good · 8–10" value={summary.condition.good} max={portfolio.assets} color="#16a34a" />
              <h3>Infrastructure condition</h3>
              <div className="tbl-wrap"><table><thead><tr><th>Network</th><th>State / rating</th><th>Count</th></tr></thead><tbody>
                {Object.entries(summary.infrastructure_condition.lines).map(([status, count]) => <tr key={`line-${status}`}><td>Transmission lines</td><td>{status.replace(/_/g, ' ')}</td><td>{count}</td></tr>)}
                {Object.entries(summary.infrastructure_condition.substations).map(([status, count]) => <tr key={`sub-${status}`}><td>Substations</td><td>{status.replace(/_/g, ' ')}</td><td>{count}</td></tr>)}
                {Object.entries(summary.infrastructure_condition.towers).map(([rating, count]) => <tr key={`tower-${rating}`}><td>Tower corrosion</td><td>{rating}</td><td>{count}</td></tr>)}
              </tbody></table></div>
            </section>
          </div>
        </div>
      )}

      {tab === 'assets' && (
        <div className="executive-section">
          <div className="executive-grid">
            <section className="exec-panel"><h2>Asset mix by class</h2><div className="tbl-wrap"><table><thead><tr><th>Asset class</th><th>Count</th><th>Share</th></tr></thead><tbody>
              {summary.asset_mix.map((row) => <tr key={row.asset_type}><td>{row.asset_type.replace(/_/g, ' ')}</td><td>{row.count}</td><td>{portfolio.assets ? `${Math.round(row.count / portfolio.assets * 100)}%` : '0%'}</td></tr>)}
            </tbody></table></div></section>
            <section className="exec-panel"><h2>Ownership register &amp; cost allocation</h2><div className="tbl-wrap"><table><thead><tr><th>Owner</th><th>Class</th><th>Assets</th><th>Replacement cost</th><th>Current value</th><th>Unpriced</th></tr></thead><tbody>
              {summary.owner_mix.map((row, index) => <tr key={`${row.owner}-${row.asset_type}-${index}`}><td>{row.owner}</td><td>{row.asset_type.replace(/_/g, ' ')}</td><td>{row.count}</td><td>{fmtMoney(row.rcn, currency)}</td><td>{fmtMoney(row.current, currency)}</td><td>{row.unpriced_count}</td></tr>)}
            </tbody></table></div><div className="muted mt">Assets without a recorded substation owner are identified separately.</div></section>
          </div>
          <section className="exec-panel mt"><h2>Total asset costing</h2>
            <div className="exec-stat-grid">
              <ExecStat label="Assets valued" value={summary.valuation.count ?? 0} />
              <ExecStat label="Replacement cost" value={fmtMoney(summary.valuation.rcn, currency)} />
              <ExecStat label="Current value" value={fmtMoney(summary.valuation.current, currency)} />
              <ExecStat label="Unpriced assets" value={summary.valuation.unpriced_count ?? 0} />
              <ExecStat label="Avg condition" value={summary.valuation.avg_condition != null ? `${Number(summary.valuation.avg_condition).toFixed(1)}/10` : '—'} />
            </div>
            <h3>Valuation by asset class</h3>
            <div className="tbl-wrap"><table><thead><tr><th>Class</th><th>Population</th><th>Replacement cost</th><th>Current value</th></tr></thead><tbody>
            {(summary.valuation.by_type || []).map((row) => <tr key={row.asset_type}><td>{row.label}</td><td>{row.count}</td><td>{fmtMoney(row.rcn, currency)}</td><td><b>{fmtMoney(row.current, currency)}</b></td></tr>)}
            {!(summary.valuation.by_type || []).length && <tr><td colSpan={4} className="muted">No priced assets to value.</td></tr>}
          </tbody></table></div></section>
        </div>
      )}

      {tab === 'execution' && (
        <div className="executive-section">
          <div className="executive-grid">
          <section className="exec-panel"><h2>Execution maintenance cost</h2><div className="exec-stat-grid">
            <ExecStat label="Spend" value={fmtMoney(summary.maintenance_cost.totals.spend, currency)} />
            <ExecStat label="Events" value={summary.maintenance_cost.totals.count} />
            <ExecStat label="Average event" value={fmtMoney(summary.maintenance_cost.totals.avg, currency)} />
            <ExecStat label="Checklist executions" value={portfolio.executions} />
          </div><h3>Spend by asset class</h3><div className="tbl-wrap"><table><thead><tr><th>Class</th><th>Events</th><th>Spend</th></tr></thead><tbody>
            {summary.maintenance_cost.by_asset_type.map((row) => <tr key={row.asset_type}><td>{row.asset_type.replace(/_/g, ' ')}</td><td>{row.count}</td><td>{fmtMoney(row.spend, currency)}</td></tr>)}
          </tbody></table></div></section>
          <section className="exec-panel"><h2>Schedule frequency</h2><div className="exec-stat-grid">
            {Object.entries(summary.schedules.by_frequency).map(([frequency, count]) => <ExecStat key={frequency} label={frequency.replace(/_/g, ' ')} value={count} />)}
            {!summary.schedules.total && <div className="muted">No schedules recorded.</div>}
          </div><h3>Recent work orders</h3><div className="tbl-wrap"><table><thead><tr><th>Task</th><th>Target</th><th>Status</th><th>Due</th></tr></thead><tbody>
            {summary.tasks.recent.map((task) => <tr key={task.id}><td><a href={`/tasks/${task.id}`}><b>{task.task_number}</b></a><br />{task.title}</td><td>{task.line_name || task.crew_name || '—'}</td><td><Pill value={task.status} /></td><td>{fmtDate(task.due_date)}</td></tr>)}
          </tbody></table></div></section>
          </div>
        <section className="exec-panel mt"><h2>Maintenance cost allocation by owner</h2><div className="tbl-wrap"><table><thead><tr><th>Owner</th><th>Recorded events</th><th>Maintenance spend</th></tr></thead><tbody>
          {summary.maintenance_cost_by_owner.map((row) => <tr key={row.owner}><td>{row.owner}</td><td>{row.events}</td><td><b>{fmtMoney(row.spend, currency)}</b></td></tr>)}
          {!summary.maintenance_cost_by_owner.length && <tr><td colSpan={3} className="muted">No maintenance events in the 12-month reporting period.</td></tr>}
        </tbody></table></div></section>
        </div>
      )}

      {tab === 'people' && (
        <div className="executive-section">
          <div className="executive-kpis">
            <KpiTile label="People" value={summary.workforce.people} />
            <KpiTile label="Crews" value={summary.workforce.crews} sub={`${summary.workforce.active_crews} currently available / on task`} />
            <KpiTile label="Valid certifications" value={summary.workforce.valid_certifications} sub={`${summary.workforce.certifications} total on record`} />
            <KpiTile label="Expired / expiring" value={`${summary.workforce.expired_certifications} / ${summary.workforce.expiring_90_days}`} tone={summary.workforce.expired_certifications ? 'bad' : undefined} />
          </div>
          <section className="exec-panel mt"><h2>Recommended work equipment</h2><div className="exec-stat-grid">
            <ExecStat label="Recommendations" value={summary.equipment.recommended} />
            <ExecStat label="Confirmed available / used" value={summary.equipment.used} />
            <ExecStat label="Missed checks" value={summary.equipment.missed} />
            <ExecStat label="Open tasks with gaps" value={summary.equipment.tasks_with_gaps} />
          </div><p className="muted">Unchecked recommended items remain visible as missed until an assignment-stage availability check is saved.</p></section>
          <div className="executive-grid mt">
            <section className="exec-panel"><h2>Workforce by title / role</h2><div className="tbl-wrap"><table><thead><tr><th>Title / role</th><th>People</th></tr></thead><tbody>
              {Object.entries(summary.workforce.by_role || {}).sort((a, b) => b[1] - a[1]).map(([role, count]) => (
                <tr key={role}><td>{role}</td><td>{count}</td></tr>
              ))}
              {!Object.keys(summary.workforce.by_role || {}).length && <tr><td colSpan={2} className="muted">No personnel on record.</td></tr>}
            </tbody></table></div></section>
            <section className="exec-panel"><h2>Certifications by type</h2><div className="tbl-wrap"><table><thead><tr><th>Type</th><th>Total</th><th>Valid</th><th>Expiring</th><th>Expired</th></tr></thead><tbody>
              {(summary.workforce.by_type || []).map((row) => (
                <tr key={row.cert_type}><td>{row.cert_type.replace(/_/g, ' ')}</td><td>{row.total}</td><td>{row.valid}</td><td>{row.expiring}</td><td className={row.expired ? 'bad' : undefined}>{row.expired}</td></tr>
              ))}
              {!(summary.workforce.by_type || []).length && <tr><td colSpan={5} className="muted">No certifications on record.</td></tr>}
            </tbody></table></div></section>
          </div>
        </div>
      )}
    </Page>
  );
}

function ExecStat({ label, value }) {
  return <div className="exec-stat"><span className="muted">{label}</span><b>{value ?? 0}</b></div>;
}