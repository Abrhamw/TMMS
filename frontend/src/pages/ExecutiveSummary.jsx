import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtDate, fmtDateTime } from '../api';
import { ErrorNote, Loading, Page, Pill } from '../components';
import { KpiTile, BarRow } from '../components/InfraVisuals';
import { Donut, StackedBar, TrendLine, SeverityBadge, SectionCard, Tabs, EmptyState, ProgressRing } from '../components/viz';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'assets', label: 'Assets' },
  { key: 'cost', label: 'Cost' },
  { key: 'work', label: 'Work' },
  { key: 'workforce', label: 'Workforce' },
];

function conditionSegments(condition) {
  return [
    { label: 'Critical 1-3', value: condition.critical || 0, color: '#dc2626' },
    { label: 'Poor 4-5', value: condition.poor || 0, color: '#ea580c' },
    { label: 'Fair 6-7', value: condition.fair || 0, color: '#d97706' },
    { label: 'Good 8-10', value: condition.good || 0, color: '#16a34a' },
  ];
}

export default function ExecutiveSummary() {
  const [summary, setSummary] = useState(null);
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState('');
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
  }, []);

  useEffect(() => {
    setSummary(null);
    const qs = region ? `?region=${region}` : '';
    api.get(`/executive/summary${qs}`).then(setSummary).catch((e) => setError(e.message));
  }, [region]);

  if (error) return <Page title="Executive Command Center" crumbs="TMMS / Executive"><ErrorNote error={error} /></Page>;
  if (!summary) return <Page title="Executive Command Center" crumbs="TMMS / Executive"><Loading /></Page>;

  const portfolio = summary.portfolio;
  const currency = summary.currency;
  const kpis = summary.kpis || [];
  const trends = summary.trends || { spend: [], condition: [] };
  const recommendations = summary.recommendations || [];
  const degradation = summary.degradation_attention || [];
  const composition = summary.cost_composition || { total: 0, buckets: [] };

  const kpiValue = (kpi) => {
    if (kpi.key === 'spend') return fmtMoney(kpi.value, currency);
    if (typeof kpi.value === 'number') return kpi.value.toLocaleString();
    return kpi.value ?? '—';
  };

  return (
    <Page title="Executive Command Center" crumbs="TMMS / Executive">
      <section className="hero-band">
        <div>
          <div className="eyebrow">Executive Command Center</div>
          <h1>System performance</h1>
          <div className="muted">Generated {fmtDateTime(summary.hero?.generated_at || summary.generated_at)} · {summary.hero?.scope || 'All regions'}</div>
        </div>
        <div className="hero-actions">
          <span className="hero-live"><span className="hero-live-dot" /> Live</span>
          <select aria-label="Region scope" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">All regions</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => window.print()}>Export view</button>
        </div>
      </section>

      <div className="executive-kpis mt">
        {kpis.length ? kpis.map((kpi) => (
          <KpiTile key={kpi.key} label={kpi.label} value={kpiValue(kpi)} sub={kpi.sub} tone={kpi.tone} spark={kpi.spark} />
        )) : (
          <>
            <KpiTile label="Asset population" value={portfolio.assets.toLocaleString()} sub={`${portfolio.lines} lines · ${portfolio.towers} towers`} />
            <KpiTile label="Current asset value" value={fmtMoney(summary.valuation.current, currency)} sub={`RCN ${fmtMoney(summary.valuation.rcn, currency)}`} />
            <KpiTile label="Open maintenance" value={portfolio.open_tasks} sub={`${portfolio.overdue_tasks} overdue`} tone={portfolio.overdue_tasks ? 'bad' : undefined} />
            <KpiTile label="12-month maintenance cost" value={fmtMoney(summary.maintenance_cost.totals.spend, currency)} sub={`${summary.maintenance_cost.totals.count} recorded events`} />
          </>
        )}
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} className="executive-tabs mt" />

      {tab === 'overview' && (
        <div className="executive-section">
          <div className="executive-grid">
            <SectionCard title="Condition distribution" sub={`${portfolio.assets.toLocaleString()} assets`}>
              <Donut segments={conditionSegments(summary.condition)} total={portfolio.assets} centerValue={portfolio.assets.toLocaleString()} centerLabel="assets" />
            </SectionCard>
            <SectionCard title="Degradation attention" sub={`Top ${degradation.length} by negative movement`} actions={<a className="link" href="/reports">Reports</a>}>
              {degradation.length ? (
                <div className="attention-list">
                  {degradation.slice(0, 6).map((row) => (
                    <div className="attention-item" key={row.asset_id}>
                      <SeverityBadge severity={row.delta <= -3 ? 'high' : row.delta <= -1.5 ? 'medium' : 'low'} />
                      <div className="attention-main">
                        <b>{row.asset_code || row.asset_name}</b>
                        <span className="muted">{row.asset_name} · {row.region || '—'} · suggested {row.suggested_rating}/10 ({row.recommendation || 'INSPECT'})</span>
                      </div>
                      <a className="link" href={`/assets?id=${row.asset_id}`}>{row.delta}</a>
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="No degradation signals">Performance data appears here once readings or events are recorded.</EmptyState>}
            </SectionCard>
          </div>
          <SectionCard title="Executive recommendations" sub={`${recommendations.length} ranked by severity`} className="mt">
            {recommendations.length ? (
              <div className="executive-grid">
                {recommendations.slice(0, 8).map((rec) => (
                  <article className={`rec-card sev-${rec.severity}`} key={rec.id}>
                    <div className="spread"><SeverityBadge severity={rec.severity} /><span className="rec-metric">{rec.metric?.key?.replace(/_/g, ' ')}: {rec.metric?.value}</span></div>
                    <h4>{rec.title}</h4>
                    <p>{rec.detail}</p>
                    <div className="spread">
                      <span className="muted" style={{ fontSize: 12 }}>{rec.action}</span>
                      {rec.link ? <a className="link" href={rec.link}>Open record</a> : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : <EmptyState title="No exceptions detected">No critical portfolio exceptions in the current register.</EmptyState>}
          </SectionCard>
          <div className="executive-grid mt">
            <SectionCard title="12-month maintenance spend" sub="Monthly">
              <TrendLine data={trends.spend.map((row) => ({ label: row.month.slice(2), value: row.spend }))} valueFormat={(v) => fmtMoney(v, currency)} />
            </SectionCard>
            <SectionCard title="Condition trend" sub="Mean rating from snapshots">
              <TrendLine data={trends.condition.map((row) => ({ label: row.month.slice(2), value: row.rating || 0 }))} color="#14532d" valueFormat={(v) => (v ? Number(v).toFixed(1) : '—')} />
            </SectionCard>
          </div>
        </div>
      )}

      {tab === 'assets' && (
        <div className="executive-section">
          <div className="executive-grid">
            <SectionCard title="Asset mix by class">
              <div className="tbl-wrap"><table><thead><tr><th>Asset class</th><th>Count</th><th>Share</th></tr></thead><tbody>
                {summary.asset_mix.map((row) => <tr key={row.asset_type}><td>{row.asset_type.replace(/_/g, ' ')}</td><td>{row.count}</td><td>{portfolio.assets ? `${Math.round(row.count / portfolio.assets * 100)}%` : '0%'}</td></tr>)}
              </tbody></table></div>
            </SectionCard>
            <SectionCard title="Condition distribution">
              <BarRow label="Critical · 1-3" value={summary.condition.critical} max={portfolio.assets} color="#dc2626" />
              <BarRow label="Poor · 4-5" value={summary.condition.poor} max={portfolio.assets} color="#ea580c" />
              <BarRow label="Fair · 6-7" value={summary.condition.fair} max={portfolio.assets} color="#d97706" />
              <BarRow label="Good · 8-10" value={summary.condition.good} max={portfolio.assets} color="#16a34a" />
            </SectionCard>
          </div>
          <div className="executive-grid mt">
            <SectionCard title="Condition-adjusted value">
              <div className="exec-stat-grid">
                <ExecStat label="Assets valued" value={summary.valuation.count ?? 0} />
                <ExecStat label="Replacement cost" value={fmtMoney(summary.valuation.rcn, currency)} />
                <ExecStat label="Current value" value={fmtMoney(summary.valuation.current, currency)} />
                <ExecStat label="Avg condition" value={summary.valuation.avg_condition != null ? `${Number(summary.valuation.avg_condition).toFixed(1)}/10` : '—'} />
              </div>
            </SectionCard>
            <SectionCard title="Dynamic condition attention" sub="From the performance model">
              {degradation.length ? (
                <div className="tbl-wrap"><table><thead><tr><th>Asset</th><th>Region</th><th>Rating</th><th>Δ</th><th>Action</th></tr></thead><tbody>
                  {degradation.map((row) => <tr key={row.asset_id}><td><a href={`/assets?id=${row.asset_id}`}><b>{row.asset_code}</b></a><br /><span className="muted">{row.asset_name}</span></td><td>{row.region || '—'}</td><td>{row.suggested_rating}/10</td><td className="contribution-neg">{row.delta}</td><td>{row.recommendation || '—'}</td></tr>)}
                </tbody></table></div>
              ) : <EmptyState title="No dynamic attention">No negative performance movement recorded.</EmptyState>}
            </SectionCard>
          </div>
          <SectionCard title="Ownership register & cost allocation" className="mt">
            <div className="tbl-wrap"><table><thead><tr><th>Owner</th><th>Class</th><th>Assets</th><th>Replacement cost</th><th>Current value</th><th>Unpriced</th></tr></thead><tbody>
              {summary.owner_mix.map((row, index) => <tr key={`${row.owner}-${row.asset_type}-${index}`}><td>{row.owner}</td><td>{row.asset_type.replace(/_/g, ' ')}</td><td>{row.count}</td><td>{fmtMoney(row.rcn, currency)}</td><td>{fmtMoney(row.current, currency)}</td><td>{row.unpriced_count}</td></tr>)}
            </tbody></table></div>
          </SectionCard>
        </div>
      )}

      {tab === 'cost' && (
        <div className="executive-section">
          <SectionCard title="Spend composition" sub={`${fmtMoney(composition.total, currency)} in the last 12 months`}>
            <StackedBar segments={composition.buckets.map((b) => ({ label: b.label, value: b.spend, color: b.color }))} />
            <div className="exec-stat-grid mt">
              {composition.buckets.map((b) => <ExecStat key={b.key} label={b.label} value={fmtMoney(b.spend, currency)} />)}
            </div>
          </SectionCard>
          <div className="executive-grid mt">
            <SectionCard title="Monthly spend">
              <TrendLine data={trends.spend.map((row) => ({ label: row.month.slice(2), value: row.spend }))} valueFormat={(v) => fmtMoney(v, currency)} />
            </SectionCard>
            <SectionCard title="Spend summary">
              <div className="exec-stat-grid">
                <ExecStat label="Spend" value={fmtMoney(summary.maintenance_cost.totals.spend, currency)} />
                <ExecStat label="Events" value={summary.maintenance_cost.totals.count} />
                <ExecStat label="Average event" value={fmtMoney(summary.maintenance_cost.totals.avg, currency)} />
                <ExecStat label="Spend / value" value={summary.valuation.current ? `${Math.round(summary.maintenance_cost.totals.spend / summary.valuation.current * 100)}%` : '—'} />
              </div>
            </SectionCard>
          </div>
          <div className="executive-grid mt">
            <SectionCard title="Spend by asset class">
              <div className="tbl-wrap"><table><thead><tr><th>Class</th><th>Events</th><th>Spend</th></tr></thead><tbody>
                {summary.maintenance_cost.by_asset_type.map((row) => <tr key={row.asset_type}><td>{row.asset_type.replace(/_/g, ' ')}</td><td>{row.count}</td><td>{fmtMoney(row.spend, currency)}</td></tr>)}
              </tbody></table></div>
            </SectionCard>
            <SectionCard title="Spend by region and owner">
              <div className="tbl-wrap"><table><thead><tr><th>Owner</th><th>Events</th><th>Spend</th></tr></thead><tbody>
                {summary.maintenance_cost_by_owner.map((row) => <tr key={row.owner}><td>{row.owner}</td><td>{row.events}</td><td><b>{fmtMoney(row.spend, currency)}</b></td></tr>)}
                {!summary.maintenance_cost_by_owner.length && <tr><td colSpan={3} className="muted">No maintenance events in the reporting period.</td></tr>}
              </tbody></table></div>
            </SectionCard>
          </div>
        </div>
      )}

      {tab === 'work' && (
        <div className="executive-section">
          <div className="executive-grid">
            <SectionCard title="Task status">
              <div className="tbl-wrap"><table><thead><tr><th>Status</th><th>Tasks</th></tr></thead><tbody>
                {Object.entries(summary.tasks.by_status).map(([status, count]) => <tr key={status}><td><Pill value={status} /></td><td>{count}</td></tr>)}
              </tbody></table></div>
            </SectionCard>
            <SectionCard title="Overdue and schedule">
              <div className="exec-stat-grid">
                <ExecStat label="Open tasks" value={portfolio.open_tasks} />
                <ExecStat label="Overdue" value={portfolio.overdue_tasks} />
                <ExecStat label="Schedules" value={summary.schedules.total} />
                <ExecStat label="Checklist executions" value={portfolio.executions} />
              </div>
              <div className="mt">
                {Object.entries(summary.schedules.by_frequency).map(([frequency, count]) => <BarRow key={frequency} label={frequency.replace(/_/g, ' ')} value={count} max={summary.schedules.total} />)}
                {!summary.schedules.total && <div className="muted">No schedules recorded.</div>}
              </div>
            </SectionCard>
          </div>
          <SectionCard title="Recent work orders" className="mt">
            <div className="tbl-wrap"><table><thead><tr><th>Task</th><th>Target</th><th>Status</th><th>Due</th></tr></thead><tbody>
              {summary.tasks.recent.map((task) => <tr key={task.id}><td><a href={`/tasks/${task.id}`}><b>{task.task_number}</b></a><br />{task.title}</td><td>{task.line_name || task.crew_name || '—'}</td><td><Pill value={task.status} /></td><td>{fmtDate(task.due_date)}</td></tr>)}
            </tbody></table></div>
          </SectionCard>
        </div>
      )}

      {tab === 'workforce' && (
        <div className="executive-section">
          <div className="executive-kpis">
            <KpiTile label="People" value={summary.workforce.people} />
            <KpiTile label="Crews" value={summary.workforce.crews} sub={`${summary.workforce.active_crews} available / on task`} />
            <KpiTile label="Valid certifications" value={summary.workforce.valid_certifications} sub={`${summary.workforce.certifications} total on record`} />
            <KpiTile label="Expired / expiring" value={`${summary.workforce.expired_certifications} / ${summary.workforce.expiring_90_days}`} tone={summary.workforce.expired_certifications ? 'bad' : undefined} />
          </div>
          <div className="executive-grid mt">
            <SectionCard title="Readiness">
              <div className="exec-stat-grid">
                <div className="exec-stat"><span className="muted">Certification</span><ProgressRing value={summary.workforce_readiness?.certification_readiness ?? 0} label={`${summary.workforce_readiness?.certification_readiness ?? 0}%`} /></div>
                <div className="exec-stat"><span className="muted">Crew</span><ProgressRing value={summary.workforce_readiness?.crew_readiness ?? 0} label={`${summary.workforce_readiness?.crew_readiness ?? 0}%`} /></div>
              </div>
            </SectionCard>
            <SectionCard title="Recommended work equipment">
              <div className="exec-stat-grid">
                <ExecStat label="Recommendations" value={summary.equipment.recommended} />
                <ExecStat label="Used" value={summary.equipment.used} />
                <ExecStat label="Missed checks" value={summary.equipment.missed} />
                <ExecStat label="Open tasks with gaps" value={summary.equipment.tasks_with_gaps} />
              </div>
            </SectionCard>
          </div>
          <div className="executive-grid mt">
            <SectionCard title="Workforce by title / role">
              <div className="tbl-wrap"><table><thead><tr><th>Title / role</th><th>People</th></tr></thead><tbody>
                {Object.entries(summary.workforce.by_role || {}).sort((a, b) => b[1] - a[1]).map(([role, count]) => <tr key={role}><td>{role}</td><td>{count}</td></tr>)}
                {!Object.keys(summary.workforce.by_role || {}).length && <tr><td colSpan={2} className="muted">No personnel on record.</td></tr>}
              </tbody></table></div>
            </SectionCard>
            <SectionCard title="Certifications by type">
              <div className="tbl-wrap"><table><thead><tr><th>Type</th><th>Total</th><th>Valid</th><th>Expiring</th><th>Expired</th></tr></thead><tbody>
                {(summary.workforce.by_type || []).map((row) => <tr key={row.cert_type}><td>{row.cert_type.replace(/_/g, ' ')}</td><td>{row.total}</td><td>{row.valid}</td><td>{row.expiring}</td><td className={row.expired ? 'bad' : undefined}>{row.expired}</td></tr>)}
                {!(summary.workforce.by_type || []).length && <tr><td colSpan={5} className="muted">No certifications on record.</td></tr>}
              </tbody></table></div>
            </SectionCard>
          </div>
        </div>
      )}
    </Page>
  );
}

function ExecStat({ label, value }) {
  return <div className="exec-stat"><span className="muted">{label}</span><b>{value ?? 0}</b></div>;
}
