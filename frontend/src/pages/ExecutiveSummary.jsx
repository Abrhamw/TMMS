import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtDateTime } from '../api';
import { ErrorNote, Loading, Page } from '../components';
import { KpiTile } from '../components/InfraVisuals';
import { Donut, StackedBar, TrendLine, SeverityBadge, SectionCard, ProgressRing, EmptyState } from '../components/viz';

const STATUS_PALETTE = ['#0e7490', '#4338ca', '#2563eb', '#7c3aed', '#d97706', '#16a34a', '#dc2626', '#64748b'];

function conditionSegments(condition) {
  return [
    { label: 'Critical 1-3', value: condition.critical || 0, color: '#dc2626' },
    { label: 'Poor 4-5', value: condition.poor || 0, color: '#ea580c' },
    { label: 'Fair 6-7', value: condition.fair || 0, color: '#d97706' },
    { label: 'Good 8-10', value: condition.good || 0, color: '#16a34a' },
  ];
}

function monthLabel(month) {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
}

export default function ExecutiveSummary() {
  const [summary, setSummary] = useState(null);
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
  }, []);

  useEffect(() => {
    setError(null);
    setSummary(null);
    const qs = region ? `?region=${region}` : '';
    api.get(`/executive/summary${qs}`).then(setSummary).catch((e) => setError(e.message));
  }, [region]);

  const controls = (
    <>
      <span className="hero-live"><span className="hero-live-dot" /> Live</span>
      <select aria-label="Region scope" value={region} onChange={(e) => setRegion(e.target.value)}>
        <option value="">All regions</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button className="btn btn-sm" onClick={() => window.print()}>Export view</button>
    </>
  );

  if (error) return <Page title="Executive Command Center" crumbs="TMMS / Executive" actions={controls}><ErrorNote error={error} /></Page>;
  if (!summary) return <Page title="Executive Command Center" crumbs="TMMS / Executive" actions={controls} fill><Loading /></Page>;

  const portfolio = summary.portfolio;
  const currency = summary.currency;
  const kpis = summary.kpis || [];
  const trends = summary.trends || { spend: [], condition: [] };
  const recommendations = summary.recommendations || [];
  const degradation = summary.degradation_attention || [];
  const composition = summary.cost_composition || { total: 0, buckets: [] };
  const readiness = summary.workforce_readiness || {};
  const equipment = summary.equipment || {};

  const kpiValue = (kpi) => {
    if (kpi.key === 'spend') return fmtMoney(kpi.value, currency);
    if (typeof kpi.value === 'number') return kpi.value.toLocaleString();
    return kpi.value ?? '—';
  };

  const meanCondition = (() => {
    const kpi = kpis.find((k) => k.key === 'condition');
    if (kpi && typeof kpi.value === 'number') return kpi.value;
    return summary.valuation?.avg_condition != null ? Number(summary.valuation.avg_condition) : null;
  })();

  const spendPoints = trends.spend.map((row) => ({ label: monthLabel(row.month), value: row.spend }));
  const statusSegments = Object.entries(summary.tasks?.by_status || {}).map(([status, count], i) => ({
    label: status.replace(/_/g, ' ').toLowerCase(), value: count, color: STATUS_PALETTE[i % STATUS_PALETTE.length],
  }));

  const fallbackKpis = [
    { key: 'assets', label: 'Asset population', value: portfolio.assets.toLocaleString(), sub: `${portfolio.lines} lines · ${portfolio.towers} towers` },
    { key: 'value', label: 'Current asset value', value: fmtMoney(summary.valuation?.current, currency), sub: `RCN ${fmtMoney(summary.valuation?.rcn, currency)}` },
    { key: 'work', label: 'Open maintenance', value: portfolio.open_tasks, sub: `${portfolio.overdue_tasks} overdue`, tone: portfolio.overdue_tasks ? 'bad' : undefined },
    { key: 'spend', label: '12-month spend', value: fmtMoney(summary.maintenance_cost?.totals?.spend, currency), sub: `${summary.maintenance_cost?.totals?.count ?? 0} events` },
  ];

  return (
    <Page title="Executive Command Center" crumbs="TMMS / Executive" actions={controls} fill>
      <div className="exec-briefing">
        <div className="exec-briefing-meta">
          <span>Generated {fmtDateTime(summary.hero?.generated_at || summary.generated_at)}</span>
          <span className="exec-briefing-scope">{summary.hero?.scope || 'All regions'}</span>
        </div>

        <div className="exec-briefing-kpis">
          {(kpis.length ? kpis : fallbackKpis).map((kpi) => (
            <KpiTile key={kpi.key} label={kpi.label} value={kpiValue(kpi)} sub={kpi.sub} tone={kpi.tone} spark={kpi.spark} />
          ))}
        </div>

        <div className="exec-briefing-grid">
          <SectionCard title="Condition" sub={`${portfolio.assets.toLocaleString()} assets`}>
            <Donut
              segments={conditionSegments(summary.condition || {})}
              total={portfolio.assets}
              size={116}
              thickness={16}
              totalLabel
              centerValue={meanCondition != null ? Number(meanCondition).toFixed(1) : portfolio.assets.toLocaleString()}
              centerLabel={meanCondition != null ? 'mean' : 'assets'}
            />
          </SectionCard>

          <SectionCard title="Maintenance spend" sub="12 months">
            {spendPoints.length ? <TrendLine data={spendPoints} height={118} valueFormat={(v) => fmtMoney(v, currency)} /> : <EmptyState title="No spend recorded" />}
          </SectionCard>

          <SectionCard title="Work status" sub={`${portfolio.open_tasks} open · ${portfolio.overdue_tasks} overdue`}>
            {statusSegments.length ? (
              <StackedBar segments={statusSegments} height={12} />
            ) : <EmptyState title="No tasks recorded" />}
          </SectionCard>

          <SectionCard title="Readiness" sub={`${readiness.active_crews ?? 0}/${readiness.crews ?? 0} crews active`}>
            <div className="exec-briefing-rings">
              <div className="exec-ring"><ProgressRing value={readiness.certification_readiness ?? 0} /><span>Certification</span></div>
              <div className="exec-ring"><ProgressRing value={readiness.crew_readiness ?? 0} /><span>Crew</span></div>
            </div>
            <div className="exec-briefing-mini">
              <span>Equipment gaps <b>{equipment.missed ?? 0}</b></span>
              <span>Tasks with gaps <b>{equipment.tasks_with_gaps ?? 0}</b></span>
            </div>
          </SectionCard>

          <SectionCard title="Cost composition" sub={fmtMoney(composition.total, currency)}>
            <StackedBar segments={composition.buckets.map((b) => ({ label: b.label, value: b.spend, color: b.color }))} height={12} />
          </SectionCard>

          <SectionCard title="Degradation attention" sub={`Top ${degradation.length}`}>
            {degradation.length ? (
              <div className="exec-briefing-attention">
                {degradation.slice(0, 3).map((row) => (
                  <a className="exec-attention-item" key={row.asset_id} href={`/assets?id=${row.asset_id}`}>
                    <SeverityBadge severity={row.delta <= -3 ? 'high' : row.delta <= -1.5 ? 'medium' : 'low'} />
                    <span className="exec-attention-main">
                      <b>{row.asset_code || row.asset_name}</b>
                      <span className="muted">{row.region || '—'} · {row.suggested_rating}/10</span>
                    </span>
                    <span className="exec-attention-delta">{row.delta}</span>
                  </a>
                ))}
              </div>
            ) : <EmptyState title="No degradation signals" />}
          </SectionCard>
        </div>

        <div className="exec-briefing-recs">
          <div className="exec-briefing-recs-head">
            <h3>Executive recommendations</h3>
            <a className="link" href="/admin">Open reports</a>
          </div>
          {recommendations.length ? (
            <div className="exec-briefing-recs-list">
              {recommendations.slice(0, 4).map((rec) => (
                <div className="exec-rec" key={rec.id}>
                  <SeverityBadge severity={rec.severity} />
                  <div className="exec-rec-main">
                    <b>{rec.title}</b>
                    {rec.action ? <span className="muted">{rec.action}</span> : null}
                  </div>
                  {rec.link ? <a className="link" href={rec.link}>Open</a> : null}
                </div>
              ))}
            </div>
          ) : <EmptyState title="No exceptions detected" />}
        </div>
      </div>
    </Page>
  );
}
