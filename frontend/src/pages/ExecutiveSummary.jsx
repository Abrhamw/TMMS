import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Boxes, ChevronRight, CircleDollarSign, RefreshCw, ShieldCheck, TrendingDown, Users, Wallet, Wrench } from 'lucide-react';
import { api, fmtMoney, fmtDateTime } from '../api';
import { ErrorNote, Page, PageSkeleton } from '../components';
import { Sparkline, StackedBar, TrendLine } from '../components/viz';
import { Sheet } from '../ui/Sheet';
import { Badge } from '../ui/Badge';
import { cn } from '../ui/cn';
import { getStoredUser } from '../auth';

const CONDITION = [
  { key: 'critical', label: 'Critical 1-3', color: '#dc2626' },
  { key: 'poor', label: 'Poor 4-5', color: '#ea580c' },
  { key: 'fair', label: 'Fair 6-7', color: '#d97706' },
  { key: 'good', label: 'Good 8-10', color: '#16a34a' },
];

const STATUS_PALETTE = ['#0e7490', '#4338ca', '#2563eb', '#7c3aed', '#d97706', '#16a34a', '#dc2626', '#64748b'];

const ACTIONS = [
  { key: 'ALL', label: 'All' },
  { key: 'UPGRADE', label: 'Upgrade' },
  { key: 'REPLACE', label: 'Replace' },
  { key: 'REPAIR', label: 'Repair' },
];

const ACTION_TONE = { REPLACE: 'danger', UPGRADE: 'warn', REPAIR: 'info' };

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function monthLabel(month) {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
}

function fmtNum(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
}

function CountUp({ value, format }) {
  const [display, setDisplay] = useState(reduced() ? value : 0);
  useEffect(() => {
    if (typeof value !== 'number') return undefined;
    if (reduced()) { setDisplay(value); return undefined; }
    let raf = 0;
    const start = performance.now();
    const dur = 750;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(value * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  if (typeof value !== 'number') return value;
  return format ? format(display) : Math.round(display).toLocaleString();
}

function Section({ title, sub, action, children, className }) {
  return (
    <section className={cn('exec-section', className)}>
      <div className="exec-section-head">
        <div>
          <h2>{title}</h2>
          {sub ? <span className="muted">{sub}</span> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Card({ title, sub, onOpen, children, className }) {
  const interactive = !!onOpen;
  return (
    <div
      className={cn('exec-card', interactive && 'exec-card--click', className)}
      onClick={onOpen}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      {(title || sub) ? (
        <header className="exec-card-head">
          <h3>{title}</h3>
          <span className="muted">
            {sub}
            {interactive ? <ChevronRight size={12} className="exec-card-chevron" /> : null}
          </span>
        </header>
      ) : null}
      <div className="exec-card-body">{children}</div>
    </div>
  );
}

function Kpi({ icon, label, value, format, sub, tone, spark, onOpen, delay }) {
  const toneAccent = tone === 'bad' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-brand';
  return (
    <button
      type="button"
      onClick={onOpen}
      style={reduced() ? undefined : { animationDelay: `${delay}s` }}
      className="exec-kpi"
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', toneAccent)} />
      <span className="exec-kpi-label">
        {icon}
        {label}
      </span>
      <span className="exec-kpi-value">
        <CountUp value={value} format={format} />
      </span>
      {sub ? <span className="exec-kpi-sub">{sub}</span> : null}
      {Array.isArray(spark) && spark.length > 1 ? <span className="exec-kpi-spark"><Sparkline values={spark} width={150} height={22} color={tone === 'bad' ? '#dc2626' : '#4338ca'} /></span> : null}
    </button>
  );
}

function Bar({ label, value, max, color }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, Math.round((value / max) * 100))) : 0;
  return (
    <div className="exec-bar">
      <div className="exec-bar-head">
        <span>{label}</span>
        <b>{value.toLocaleString()}</b>
      </div>
      <div className="exec-bar-track">
        <div className="exec-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Row({ left, right, tone }) {
  return (
    <div className="exec-row">
      <span className="exec-row-left">{left}</span>
      <span className="exec-row-right">{right}</span>
      {tone}
    </div>
  );
}

function EffBar({ label, value }) {
  const v = value == null ? null : Math.max(0, Math.min(100, Number(value)));
  return (
    <div className="exec-eff">
      <span className="muted">{label}</span>
      <div className="exec-eff-track">
        <div className="exec-eff-fill" style={{ width: `${v ?? 0}%` }} />
      </div>
      <b>{v == null ? '—' : `${v}%`}</b>
    </div>
  );
}

function RegionCard({ region }) {
  const eff = region.effectiveness || {};
  const lineVolts = Object.entries(region.lines?.by_voltage || {})
    .sort((a, b) => Number.parseFloat(b[0]) - Number.parseFloat(a[0])).slice(0, 3);
  return (
    <article className="exec-region">
      <header className="exec-region-head">
        <div className="exec-region-title">
          <b>{region.name}</b>
          <span className="muted">{region.code}</span>
        </div>
        <Ring value={eff.index ?? 0} label="Effectiveness" size={56} />
      </header>
      <div className="exec-region-metrics">
        <div>
          <span className="muted">Substations</span>
          <b>{fmtNum(region.substations?.count)}</b>
          <span className="muted">{fmtNum(region.substations?.total_bays)} bays · {region.substations?.avg_bays ?? 0} avg</span>
        </div>
        <div>
          <span className="muted">Lines</span>
          <b>{fmtNum(region.lines?.count)}</b>
          <span className="muted">{fmtNum(region.lines?.circuit_km)} ckt-km</span>
        </div>
        <div>
          <span className="muted">Assets</span>
          <b>{fmtNum(region.assets?.count)}</b>
          <span className="muted">{fmtNum((region.assets?.condition?.critical || 0) + (region.assets?.condition?.poor || 0))} at risk</span>
        </div>
      </div>
      <div className="exec-region-bars">
        <EffBar label="Availability" value={eff.availability} />
        <EffBar label="Delivery" value={eff.delivery} />
        <EffBar label="Condition" value={eff.condition} />
      </div>
      {lineVolts.length ? (
        <div className="exec-region-chips">
          {lineVolts.map(([label, entry]) => <span className="exec-chip" key={label}>{label} · {entry.count}</span>)}
        </div>
      ) : null}
    </article>
  );
}

export default function ExecutiveSummary() {
  const [summary, setSummary] = useState(null);
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState('');
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [intFilter, setIntFilter] = useState('ALL');
  const [concDim, setConcDim] = useState('category');
  const user = getStoredUser();
  const linksEnabled = !!user && user.role === 'ADMIN';
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
  }, []);

  const load = useCallback(() => {
    const qs = region ? `?region=${region}` : '';
    setRefreshing(true);
    return api.get(`/executive/summary${qs}`)
      .then((s) => { if (alive.current) setSummary(s); })
      .catch((e) => { if (alive.current) setError(e.message); })
      .finally(() => { if (alive.current) setRefreshing(false); });
  }, [region]);

  useEffect(() => {
    setError(null);
    setSummary(null);
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => { load(); }, 60000);
    return () => clearInterval(id);
  }, [load]);

  const controls = (
    <>
      <span className="hidden items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 sm:inline-flex">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Live
      </span>
      <select aria-label="Region scope" value={region} onChange={(e) => setRegion(e.target.value)}>
        <option value="">All regions</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button type="button" className="theme-toggle" onClick={load} aria-label="Refresh" title="Refresh">
        <RefreshCw size={16} className={refreshing ? 'animate-spin' : undefined} />
      </button>
      <button type="button" className="btn btn-sm" onClick={() => window.print()}>Export view</button>
    </>
  );

  if (error) return <Page title="Executive Command Center" crumbs="TMMS / Executive" actions={controls}><ErrorNote error={error} /></Page>;
  if (!summary) return <Page title="Executive Command Center" crumbs="TMMS / Executive" actions={controls} fill><PageSkeleton /></Page>;

  const portfolio = summary.portfolio || {};
  const currency = summary.currency;
  const kpis = summary.kpis || [];
  const trends = summary.trends || { spend: [], condition: [] };
  const recommendations = summary.recommendations || [];
  const degradation = summary.degradation_attention || [];
  const composition = summary.cost_composition || { total: 0, buckets: [] };
  const readiness = summary.workforce_readiness || {};
  const workforce = summary.workforce || {};
  const equipment = summary.equipment || {};
  const condition = summary.condition || {};
  const infra = summary.infrastructure_condition || {};
  const valuation = summary.valuation || {};
  const concentration = summary.asset_concentration || {};
  const concDims = [
    { key: 'category', label: 'Category' },
    { key: 'owner', label: 'Owner' },
    { key: 'region', label: 'Region' },
  ].filter((dim) => (concentration[dim.key]?.count || 0) > 1);
  const activeConcDim = (concDims.find((dim) => dim.key === concDim) || concDims[0] || { key: 'category' }).key;
  const conc = concentration[activeConcDim] || { top: [], total: 0, count: 0, top5_share: 0 };
  const regionLoad = summary.region_load || [];
  const interventions = summary.interventions || [];
  const byStatus = summary.tasks?.by_status || {};

  const meanCondition = (() => {
    const kpi = kpis.find((k) => k.key === 'condition');
    if (kpi && typeof kpi.value === 'number') return kpi.value;
    return valuation.avg_condition != null ? Number(valuation.avg_condition) : null;
  })();
  const spendPoints = trends.spend.map((row) => ({ label: monthLabel(row.month), value: row.spend }));
  const conditionPoints = (trends.condition || []).filter((row) => row.rating != null).map((row) => ({ label: monthLabel(row.month), value: row.rating }));
  const statusSegments = Object.entries(byStatus).map(([status, count], i) => ({ label: status.replace(/_/g, ' ').toLowerCase(), value: count, color: STATUS_PALETTE[i % STATUS_PALETTE.length] }));
  const lineSegments = Object.entries(infra.lines || {}).map(([status, count], i) => ({ label: status.replace(/_/g, ' ').toLowerCase(), value: count, color: STATUS_PALETTE[i % STATUS_PALETTE.length] }));
  const subSegments = Object.entries(infra.substations || {}).map(([status, count], i) => ({ label: status.replace(/_/g, ' ').toLowerCase(), value: count, color: STATUS_PALETTE[i % STATUS_PALETTE.length] }));
  const roleRows = Object.entries(workforce.by_role || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const certRows = (workforce.by_type || []).slice(0, 6);
  const filteredInterventions = intFilter === 'ALL' ? interventions : interventions.filter((row) => row.action === intFilter);

  const kpiFormat = (kpi) => (n) => {
    if (kpi.key === 'spend' || kpi.key === 'capital') return fmtMoney(n, currency);
    if (kpi.key === 'condition') return Number(n).toFixed(1);
    return Math.round(n).toLocaleString();
  };

  const tiles = [
    { key: 'assets', icon: <Boxes size={13} />, label: 'Assets in service', value: portfolio.assets ?? 0, sub: `${portfolio.regions ?? 0} regions · ${portfolio.lines ?? 0} lines`, open: 'assets' },
    { key: 'condition', icon: <Activity size={13} />, label: 'Mean condition', value: meanCondition ?? '—', sub: `${condition.assessed ?? 0} assessed`, tone: meanCondition != null && meanCondition <= 5 ? 'bad' : meanCondition != null && meanCondition <= 7 ? 'warn' : undefined, spark: conditionPoints.map((p) => p.value), open: 'condition' },
    { key: 'capital', icon: <CircleDollarSign size={13} />, label: 'Capital value', value: valuation.current ?? 0, sub: `RCN ${fmtMoney(valuation.rcn ?? 0, currency)}`, open: 'assets' },
    { key: 'spend', icon: <Wallet size={13} />, label: '12-month spend', value: summary.maintenance_cost?.totals?.spend ?? 0, sub: `${summary.maintenance_cost?.totals?.count ?? 0} events`, spark: spendPoints.map((p) => p.value), open: 'spend' },
    { key: 'workforce', icon: <Users size={13} />, label: 'Crew readiness', value: readiness.crew_readiness != null ? `${readiness.crew_readiness}%` : '—', sub: `${readiness.active_crews ?? 0} of ${readiness.crews ?? 0} active`, tone: readiness.crew_readiness != null && readiness.crew_readiness < 50 ? 'warn' : undefined, open: 'readiness' },
    { key: 'cert', icon: <ShieldCheck size={13} />, label: 'Certification readiness', value: readiness.certification_readiness != null ? `${readiness.certification_readiness}%` : '—', sub: `${workforce.valid_certifications ?? 0} valid · ${workforce.expiring_90_days ?? 0} expiring`, tone: readiness.certification_readiness != null && readiness.certification_readiness < 60 ? 'warn' : undefined, open: 'readiness' },
  ];

  const drawerTitle = {
    condition: 'Condition detail', assets: 'Asset portfolio', spend: 'Maintenance spend', work: 'Work status',
    readiness: 'Workforce readiness', composition: 'Cost composition', degradation: 'Degradation attention', recs: 'Executive recommendations',
  };

  return (
    <Page title="Executive Command Center" crumbs="TMMS / Executive" actions={controls}>
      <div className="exec-briefing">
        <div className="exec-briefing-meta">
          <span>Generated {fmtDateTime(summary.hero?.generated_at || summary.generated_at)}</span>
          <span className="exec-briefing-scope">{summary.hero?.scope || 'All regions'}</span>
        </div>

        <div className="exec-briefing-kpis">
          {tiles.map((kpi, i) => (
            <Kpi
              key={kpi.key}
              icon={kpi.icon}
              label={kpi.label}
              value={kpi.value}
              format={typeof kpi.value === 'number' ? kpiFormat(kpi) : undefined}
              sub={kpi.sub}
              tone={kpi.tone}
              spark={kpi.spark}
              delay={i * 0.05}
              onOpen={() => setDrawer(kpi.open)}
            />
          ))}
        </div>

        <Section title="Human capital & readiness" sub={`${readiness.headcount ?? portfolio.people ?? 0} people · ${readiness.crews ?? 0} crews`}>
          <div className="exec-grid exec-grid--3">
            <Card title="Readiness" sub="crews and certifications" onOpen={() => setDrawer('readiness')}>
              <div className="exec-rings">
                <Ring value={readiness.certification_readiness ?? 0} label="Certification" size={72} />
                <Ring value={readiness.crew_readiness ?? 0} label="Crew" size={72} />
              </div>
              <div className="exec-mini">
                <span>Valid <b>{fmtNum(workforce.valid_certifications)}</b></span>
                <span>Expiring <b>{fmtNum(workforce.expiring_90_days)}</b></span>
                <span>Expired <b>{fmtNum(workforce.expired_certifications)}</b></span>
              </div>
            </Card>

            <Card title="Workforce by role" sub={`${roleRows.length} roles`}>
              {roleRows.length ? roleRows.map(([role, count]) => <Bar key={role} label={role} value={count} max={roleRows[0]?.[1] || 1} color="#2563eb" />) : <div className="exec-empty">No personnel recorded</div>}
            </Card>

            <Card title="Certifications by type" sub={`${workforce.certifications ?? 0} records`}>
              {certRows.length ? certRows.map((cert) => (
                <div className="exec-cert" key={cert.cert_type}>
                  <span className="exec-cert-name">{String(cert.cert_type || '').replace(/_/g, ' ')}</span>
                  <span className="exec-cert-counts">
                    <b>{cert.valid}</b> valid · <b>{cert.expiring}</b> expiring · <span className={cert.expired ? 'exec-cert-bad' : undefined}>{cert.expired}</span> expired
                  </span>
                </div>
              )) : <div className="exec-empty">No certifications recorded</div>}
              <div className="exec-mini">
                <span>Equipment missed <b>{fmtNum(equipment.missed)}</b></span>
                <span>Tasks w/ gaps <b>{fmtNum(equipment.tasks_with_gaps)}</b></span>
              </div>
            </Card>
          </div>
        </Section>

        <Section title="Capital & cost of operation" sub={`${currency} · last 12 months`}>
          <div className="exec-grid exec-grid--3">
            <Card title="Cost composition" sub={fmtMoney(composition.total, currency)} onOpen={() => setDrawer('composition')}>
              <StackedBar segments={composition.buckets.map((b) => ({ label: b.label, value: b.spend, color: b.color }))} height={14} />
              <div className="exec-legend">
                {composition.buckets.map((b) => (
                  <span key={b.key}><i style={{ background: b.color }} />{b.label} <b>{fmtMoney(b.spend, currency)}</b></span>
                ))}
              </div>
            </Card>

            <Card title="Maintenance spend" sub="12 months" onOpen={() => setDrawer('spend')}>
              {spendPoints.length ? <TrendLine data={spendPoints} height={130} valueFormat={(v) => fmtMoney(v, currency)} /> : <div className="exec-empty">No spend recorded</div>}
            </Card>

            <Card title="Valuation" sub="condition-adjusted" onOpen={() => setDrawer('assets')}>
              <Row left="Replacement cost (RCN)" right={fmtMoney(valuation.rcn, currency)} />
              <Row left="Current value" right={fmtMoney(valuation.current, currency)} />
              <Row left="Avg condition" right={valuation.avg_condition != null ? `${Number(valuation.avg_condition).toFixed(1)}/10` : '—'} />
            </Card>

            <Card
              title="Portfolio concentration"
              sub={conc.count ? `top ${Math.min(5, conc.count)} hold ${Math.round((conc.top5_share || 0) * 100)}% of value` : 'no priced assets'}
            >
              {concDims.length > 1 && (
                <div className="chip-row" style={{ marginBottom: 8 }}>
                  {concDims.map((dim) => (
                    <button
                      key={dim.key}
                      type="button"
                      className={cn('chip', dim.key === activeConcDim && 'chip-on')}
                      onClick={() => setConcDim(dim.key)}
                    >
                      {dim.label}
                    </button>
                  ))}
                </div>
              )}
              {conc.top?.length ? conc.top.map((row) => (
                <Bar
                  key={row.label}
                  label={`${row.label} · ${Math.round(row.share * 100)}%`}
                  value={row.value}
                  max={conc.top[0]?.value || 1}
                  color="#0e7490"
                />
              )) : <div className="exec-empty">No priced assets in scope</div>}
              {concentration.unpriced_count ? (
                <div className="exec-mini"><span>Unpriced assets <b>{fmtNum(concentration.unpriced_count)}</b></span></div>
              ) : null}
            </Card>
          </div>
        </Section>

        <Section title="Network condition & degradation" sub={`${fmtNum(portfolio.assets)} assets`}>
          <div className="exec-grid exec-grid--3">
            <Card title="Condition" sub={`mean ${meanCondition != null ? Number(meanCondition).toFixed(1) : '—'}`} onOpen={() => setDrawer('condition')}>
              <div className="exec-center">
                <DonutMini condition={condition} total={portfolio.assets || 0} mean={meanCondition} />
              </div>
            </Card>

            <Card title="Infrastructure status" sub={`${fmtNum(portfolio.substations)} substations · ${fmtNum(portfolio.lines)} lines`}>
              <span className="exec-subhead">Lines</span>
              {lineSegments.length ? <StackedBar segments={lineSegments} height={12} /> : <div className="exec-empty">No lines recorded</div>}
              <span className="exec-subhead">Substations</span>
              {subSegments.length ? <StackedBar segments={subSegments} height={12} /> : <div className="exec-empty">No substations recorded</div>}
              {conditionPoints.length ? <div className="exec-trend"><span className="exec-subhead">Condition trend</span><TrendLine data={conditionPoints} height={70} valueFormat={(v) => Number(v).toFixed(1)} /></div> : null}
            </Card>

            <Card title="Degradation attention" sub={`Top ${degradation.length}`} onOpen={() => setDrawer('degradation')}>
              {degradation.length ? degradation.slice(0, 5).map((row) => (
                <div className="exec-attention" key={row.asset_id}>
                  <Badge tone={row.delta <= -3 ? 'danger' : row.delta <= -1.5 ? 'warn' : 'info'}>{row.delta <= -3 ? 'High' : row.delta <= -1.5 ? 'Med' : 'Low'}</Badge>
                  <span className="exec-attention-name">{row.asset_code || row.asset_name}</span>
                  <b className="exec-attention-delta">{row.delta}</b>
                </div>
              )) : <div className="exec-empty">No degradation signals</div>}
            </Card>
          </div>
        </Section>

        <Section title="Regional load & effectiveness" sub={`${regionLoad.length} regions · substations, circuits and delivery`}>
          {regionLoad.length ? (
            <div className="exec-region-grid">
              {regionLoad.map((r) => <RegionCard key={r.id} region={r} />)}
            </div>
          ) : <div className="exec-empty">No regions in scope</div>}
        </Section>

        <Section
          title="Assets needing intervention"
          sub={`${interventions.length} flagged`}
          action={(
            <div className="exec-int-tabs">
              {ACTIONS.map((a) => (
                <button key={a.key} type="button" className={cn('exec-int-tab', intFilter === a.key && 'is-active')} onClick={() => setIntFilter(a.key)}>{a.label}</button>
              ))}
            </div>
          )}
        >
          {filteredInterventions.length ? (
            <div className="exec-int-list">
              {filteredInterventions.map((row) => (
                <div className="exec-int-row" key={row.asset_id}>
                  <Badge tone={ACTION_TONE[row.action] || 'neutral'}>{row.action}</Badge>
                  <div className="exec-int-main">
                    <b>{row.asset_code || row.asset_name}</b>
                    <span className="muted">{row.asset_name || '—'} · {row.region || '—'}</span>
                  </div>
                  <span className="exec-int-rating">{row.current_rating != null ? `${row.current_rating}/10` : '—'}{row.suggested_rating != null ? ` → ${row.suggested_rating}/10` : ''}</span>
                  <Badge tone={row.urgency === 'high' ? 'danger' : row.urgency === 'medium' ? 'warn' : 'neutral'}>{row.urgency}</Badge>
                </div>
              ))}
            </div>
          ) : <div className="exec-empty">Nothing flagged for the selected action</div>}
        </Section>

        <Section title="Executive recommendations" sub={`${recommendations.length} items`} action={<button type="button" className="exec-link" onClick={() => setDrawer('recs')}>View all</button>}>
          {recommendations.length ? (
            <div className="exec-briefing-recs-list">
              {recommendations.slice(0, 6).map((rec) => (
                <div className="exec-rec" key={rec.id}>
                  <Badge tone={rec.severity === 'high' || rec.severity === 'critical' ? 'danger' : rec.severity === 'medium' ? 'warn' : 'info'}>{rec.severity || 'low'}</Badge>
                  <div className="exec-rec-main">
                    <b>{rec.title}</b>
                    {rec.action ? <span className="muted">{rec.action}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="exec-empty">No exceptions detected</div>}
        </Section>
      </div>

      <Sheet open={!!drawer} onClose={() => setDrawer(null)} title={drawerTitle[drawer] || 'Detail'} description={summary.hero?.scope || 'All regions'}>
        {drawer === 'condition' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {CONDITION.map((c) => (
                <div key={c.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{c.label}</div>
                  <div className="text-lg font-bold" style={{ color: c.color }}>{(condition[c.key] || 0).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Mean condition</h4>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-50">{meanCondition != null ? `${Number(meanCondition).toFixed(1)}/10` : '—'}</div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{condition.assessed ?? 0} of {fmtNum(portfolio.assets)} assets assessed</p>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Top degradation</h4>
              {degradation.slice(0, 8).map((row) => (
                <Row key={row.asset_id} left={<><b>{row.asset_code}</b> · {row.region || '—'}</>} right={`${row.suggested_rating}/10 (${row.delta})`} />
              ))}
              {!degradation.length && <div className="exec-empty">No negative movement recorded.</div>}
            </div>
          </div>
        )}

        {drawer === 'assets' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-center">
              <Stat label="Assets" value={fmtNum(portfolio.assets)} />
              <Stat label="Lines" value={fmtNum(portfolio.lines)} />
              <Stat label="Towers" value={fmtNum(portfolio.towers)} />
              <Stat label="Substations" value={fmtNum(portfolio.substations)} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Condition mix</h4>
              {CONDITION.map((c) => <Bar key={c.key} label={c.label} value={condition[c.key] || 0} max={portfolio.assets || 1} color={c.color} />)}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Condition-adjusted value</h4>
              <Row left="Replacement cost" right={fmtMoney(valuation.rcn, currency)} />
              <Row left="Current value" right={fmtMoney(valuation.current, currency)} />
              <Row left="Avg condition" right={valuation.avg_condition != null ? `${Number(valuation.avg_condition).toFixed(1)}/10` : '—'} />
            </div>
          </div>
        )}

        {drawer === 'spend' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-center">
              <Stat label="Spend" value={fmtMoney(summary.maintenance_cost?.totals?.spend, currency)} />
              <Stat label="Events" value={summary.maintenance_cost?.totals?.count ?? 0} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">By month</h4>
              {trends.spend.map((row) => <Row key={row.month} left={monthLabel(row.month)} right={fmtMoney(row.spend, currency)} />)}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Composition</h4>
              {composition.buckets.map((b) => <Row key={b.key} left={b.label} right={fmtMoney(b.spend, currency)} />)}
            </div>
          </div>
        )}

        {drawer === 'work' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-center">
              <Stat label="Open" value={portfolio.open_tasks} />
              <Stat label="Overdue" value={portfolio.overdue_tasks} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">By status</h4>
              {Object.entries(byStatus).map(([status, count]) => <Row key={status} left={status.replace(/_/g, ' ')} right={count} />)}
              {!Object.keys(byStatus).length && <div className="exec-empty">No tasks recorded.</div>}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent work orders</h4>
              {(summary.tasks?.recent || []).map((task) => (
                <Row key={task.id} left={<><b>{task.task_number}</b> · {task.title}</>} right={<Badge tone="neutral">{task.status}</Badge>} />
              ))}
            </div>
          </div>
        )}

        {drawer === 'readiness' && (
          <div className="space-y-4">
            <div className="flex justify-around">
              <BigRing value={readiness.certification_readiness ?? 0} label="Certification" />
              <BigRing value={readiness.crew_readiness ?? 0} label="Crew" />
            </div>
            <Row left="Crews active" right={`${readiness.active_crews ?? 0}/${readiness.crews ?? 0}`} />
            <Row left="Valid certifications" right={workforce.valid_certifications ?? 0} />
            <Row left="Expired certifications" right={workforce.expired_certifications ?? 0} />
            <Row left="Expiring within 90 days" right={workforce.expiring_90_days ?? 0} />
            <Row left="Recommended equipment used" right={equipment.used ?? 0} />
            <Row left="Recommended equipment missed" right={equipment.missed ?? 0} />
            <Row left="Tasks with equipment gaps" right={equipment.tasks_with_gaps ?? 0} />
          </div>
        )}

        {drawer === 'composition' && (
          <div className="space-y-3">
            <div className="text-2xl font-bold text-slate-900 dark:text-slate-50">{fmtMoney(composition.total, currency)}</div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Last 12 months</p>
            <StackedBar segments={composition.buckets.map((b) => ({ label: b.label, value: b.spend, color: b.color }))} height={14} />
            {composition.buckets.map((b) => <Row key={b.key} left={b.label} right={fmtMoney(b.spend, currency)} />)}
          </div>
        )}

        {drawer === 'degradation' && (
          <div>
            {degradation.map((row) => (
              <div key={row.asset_id} className="flex items-center gap-3 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
                <TrendingDown size={16} className="text-red-500" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{row.asset_code || row.asset_name}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{row.asset_name} · {row.region || '—'} · suggested {row.suggested_rating}/10</div>
                </div>
                <Badge tone="danger">{row.delta}</Badge>
              </div>
            ))}
            {!degradation.length && <div className="exec-empty">No degradation signals.</div>}
          </div>
        )}

        {drawer === 'recs' && (
          <div className="space-y-3">
            {recommendations.map((rec) => (
              <div key={rec.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Badge tone={rec.severity === 'high' || rec.severity === 'critical' ? 'danger' : rec.severity === 'medium' ? 'warn' : 'info'}>{rec.severity || 'low'}</Badge>
                  {rec.metric ? <span className="text-[10px] text-slate-400">{rec.metric.key?.replace(/_/g, ' ')}: {rec.metric.value}</span> : null}
                </div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{rec.title}</div>
                {rec.detail ? <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{rec.detail}</p> : null}
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">{rec.action}</span>
                  {linksEnabled && rec.link ? <a className="text-[11px] font-semibold text-accent hover:underline" href={rec.link}>Open record</a> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </Page>
  );
}

function DonutMini({ condition, total, mean }) {
  const segs = CONDITION.map((c) => ({ ...c, value: condition[c.key] || 0 })).filter((s) => s.value > 0);
  const sum = total > 0 ? total : segs.reduce((a, s) => a + s.value, 0);
  const size = 108;
  const thickness = 15;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="condition distribution">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" className="text-slate-100 dark:text-slate-800" strokeWidth={thickness} />
          {segs.map((s) => {
            const len = sum > 0 ? (s.value / sum) * circ : 0;
            const el = <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
            offset += len;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <b className="text-lg font-bold text-slate-900 dark:text-slate-50">{mean != null ? Number(mean).toFixed(1) : total.toLocaleString()}</b>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">{mean != null ? 'mean' : 'assets'}</span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap justify-center gap-x-2 gap-y-0.5 text-[10px]">
        {CONDITION.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />
            {c.label} {(condition[c.key] || 0).toLocaleString()}
          </span>
        ))}
      </div>
    </div>
  );
}

function Ring({ value, label, size = 52 }) {
  const thickness = 6;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="exec-ring">
      <span className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" className="text-slate-200 dark:text-slate-700" strokeWidth={thickness} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" className="text-brand" strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${(v / 100) * circ} ${circ}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </svg>
        <span className="exec-ring-value">{Math.round(v)}%</span>
      </span>
      {label ? <span className="exec-ring-label">{label}</span> : null}
    </div>
  );
}

function BigRing({ value, label }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <Ring value={value} label="" size={72} />
      <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-base font-bold text-slate-900 dark:text-slate-50">{value}</div>
    </div>
  );
}
