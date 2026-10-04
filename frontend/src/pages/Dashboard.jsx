import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtDateTime } from '../api';
import { ErrorNote, Page, PageSkeleton } from '../components';
import { KpiTile } from '../components/InfraVisuals';
import { Donut, TrendLine, SeverityBadge, SectionCard, EmptyState } from '../components/viz';
import { Sheet } from '../ui/Sheet';

function conditionSegments(condition = {}) {
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

export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState('');
  const [error, setError] = useState(null);
  const [drill, setDrill] = useState(null);

  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
  }, []);

  useEffect(() => {
    setSummary(null);
    setError(null);
    const qs = region ? `?region=${region}` : '';
    api.get(`/dashboard/summary${qs}`).then(setSummary).catch((e) => setError(e.message));
  }, [region]);

  if (error) return <Page title="Dashboard" crumbs="TMMS / Dashboard"><ErrorNote error={error} /></Page>;
  if (!summary) return <Page title="Dashboard" crumbs="TMMS / Dashboard"><PageSkeleton /></Page>;

  const portfolio = summary.portfolio || {};
  const currency = summary.currency;
  const kpis = summary.kpis || [];
  const trends = summary.trends || { spend: [], condition: [] };
  const recommendations = summary.recommendations || [];
  const degradation = summary.degradation_attention || [];

  const spendPoints = trends.spend.map((row) => ({ label: monthLabel(row.month), value: row.spend }));
  const conditionPoints = trends.condition.filter((row) => row.rating != null).map((row) => ({ label: monthLabel(row.month), value: row.rating }));

  const kpiValue = (kpi) => {
    if (kpi.key === 'spend') return fmtMoney(kpi.value, currency);
    if (typeof kpi.value === 'number') return kpi.value.toLocaleString();
    return kpi.value ?? '—';
  };

  return (
    <Page title="Dashboard" crumbs="TMMS / Dashboard">
      <section className="hero-band">
        <div>
          <div className="eyebrow">Operations dashboard</div>
          <h1>{summary.hero?.scope || 'All regions'}</h1>
          <div className="muted">Generated {fmtDateTime(summary.hero?.generated_at || summary.generated_at)}</div>
        </div>
        <div className="hero-actions">
          <span className="hero-live"><span className="hero-live-dot" /> Live</span>
          {regions.length > 1 && (
            <select aria-label="Region scope" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">All regions</option>
              {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <button className="btn btn-sm" onClick={() => window.print()}>Export view</button>
        </div>
      </section>

      <div className="executive-kpis mt">
        {kpis.length ? kpis.map((kpi) => (
          <KpiTile key={kpi.key} label={kpi.label} value={kpiValue(kpi)} sub={kpi.sub} tone={kpi.tone} spark={kpi.spark} />
        )) : (
          <>
            <KpiTile label="Assets in service" value={(portfolio.assets || 0).toLocaleString()} sub={`${portfolio.lines || 0} lines · ${portfolio.towers || 0} towers`} />
            <KpiTile label="Open work" value={portfolio.open_tasks || 0} sub={`${portfolio.overdue_tasks || 0} overdue`} tone={portfolio.overdue_tasks ? 'warn' : 'ok'} />
          </>
        )}
      </div>

      <div className="executive-grid mt">
        <SectionCard title="Condition distribution" sub={`${(portfolio.assets || 0).toLocaleString()} assets`}>
          <Donut segments={conditionSegments(summary.condition)} total={portfolio.assets || 0} centerValue={(portfolio.assets || 0).toLocaleString()} centerLabel="assets" />
        </SectionCard>
        <SectionCard title="Degradation attention" sub={`Top ${Math.min(degradation.length, 5)} by negative movement`} actions={<button type="button" className="link" onClick={() => setDrill('degradation')}>View all</button>}>
          {degradation.length ? (
            <div className="attention-list">
              {degradation.slice(0, 5).map((row) => (
                <div className="attention-item" key={row.asset_id}>
                  <SeverityBadge severity={row.delta <= -3 ? 'high' : row.delta <= -1.5 ? 'medium' : 'low'} />
                  <div className="attention-main">
                    <b>{row.asset_code || row.asset_name}</b>
                    <span className="muted">{row.asset_name} · {row.region || '—'} · suggested {row.suggested_rating}/10</span>
                  </div>
                  <span className="contribution-neg">{row.delta}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState title="No degradation signals">Performance data appears here once readings or events are recorded.</EmptyState>}
        </SectionCard>
      </div>

      <div className="executive-grid mt">
        <SectionCard title="12-month maintenance spend" sub={`Total ${fmtMoney(summary.cost_composition?.total || 0, currency)}`}>
          {spendPoints.length ? <TrendLine data={spendPoints} valueFormat={(v) => fmtMoney(v, currency)} /> : <EmptyState title="No spend recorded">Maintenance cost appears once events are logged.</EmptyState>}
        </SectionCard>
        <SectionCard title="Condition trend" sub={conditionPoints.length ? `Latest ${conditionPoints[conditionPoints.length - 1].value}/10` : 'No snapshots yet'}>
          {conditionPoints.length ? <TrendLine data={conditionPoints} color="#14532d" valueFormat={(v) => `${Number(v).toFixed(1)}/10`} /> : <EmptyState title="No condition snapshots">Run the asset monitor to build a condition history.</EmptyState>}
        </SectionCard>
      </div>

      <SectionCard title="Recommendations" sub={`${recommendations.length} ranked by severity`} actions={<button type="button" className="link" onClick={() => setDrill('recs')}>View all</button>} className="mt">
        {recommendations.length ? (
          <div className="executive-grid">
            {recommendations.slice(0, 5).map((rec) => (
              <article className={`rec-card sev-${rec.severity}`} key={rec.id}>
                <div className="spread">
                  <SeverityBadge severity={rec.severity} />
                  <span className="rec-metric">{rec.metric?.key?.replace(/_/g, ' ')}: {rec.metric?.value}</span>
                </div>
                <h4>{rec.title}</h4>
                <p>{rec.detail}</p>
                {rec.link ? <a className="link" href={rec.link}>Open record</a> : null}
              </article>
            ))}
          </div>
        ) : <EmptyState title="No exceptions detected">No critical portfolio exceptions in the current register.</EmptyState>}
      </SectionCard>

      <Sheet open={drill === 'degradation'} onClose={() => setDrill(null)} title="Degradation attention" description={summary.hero?.scope || 'All regions'}>
        {degradation.length ? (
          <div className="attention-list">
            {degradation.map((row) => (
              <div className="attention-item" key={row.asset_id}>
                <SeverityBadge severity={row.delta <= -3 ? 'high' : row.delta <= -1.5 ? 'medium' : 'low'} />
                <div className="attention-main">
                  <b>{row.asset_code || row.asset_name}</b>
                  <span className="muted">{row.asset_name} · {row.region || '—'} · suggested {row.suggested_rating}/10</span>
                </div>
                <span className="contribution-neg">{row.delta}</span>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No degradation signals">Performance data appears here once readings or events are recorded.</EmptyState>}
      </Sheet>

      <Sheet open={drill === 'recs'} onClose={() => setDrill(null)} title="Recommendations" description={`${recommendations.length} ranked by severity`}>
        {recommendations.length ? (
          <div className="space-y-3">
            {recommendations.map((rec) => (
              <article className={`rec-card sev-${rec.severity}`} key={rec.id}>
                <div className="spread">
                  <SeverityBadge severity={rec.severity} />
                  <span className="rec-metric">{rec.metric?.key?.replace(/_/g, ' ')}: {rec.metric?.value}</span>
                </div>
                <h4>{rec.title}</h4>
                <p>{rec.detail}</p>
                {rec.link ? <a className="link" href={rec.link}>Open record</a> : null}
              </article>
            ))}
          </div>
        ) : <EmptyState title="No exceptions detected">No critical portfolio exceptions in the current register.</EmptyState>}
      </Sheet>
    </Page>
  );
}
