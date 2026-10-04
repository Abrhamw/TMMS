import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, Boxes, RefreshCw, TrendingDown, Users, Wallet, Wrench, ChevronRight } from 'lucide-react';
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

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function monthLabel(month) {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
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

function Panel({ title, sub, onOpen, children, className, delay = 0 }) {
  return (
    <motion.section
      initial={reduced() ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced() ? 0 : 0.4, delay: reduced() ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      className={cn(
        'group flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent/40 dark:border-slate-800 dark:bg-slate-900',
        onOpen && 'cursor-pointer',
        className
      )}
    >
      <header className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        <span className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
          {sub}
          {onOpen && <ChevronRight size={12} className="opacity-0 transition-opacity group-hover:opacity-100" />}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </motion.section>
  );
}

function Kpi({ icon, label, value, numeric, format, sub, tone, spark, onOpen, delay }) {
  const toneAccent = tone === 'bad' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-brand';
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={reduced() ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced() ? 0 : 0.4, delay: reduced() ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-2.5 text-left shadow-sm outline-none transition-transform hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent/40 dark:border-slate-800 dark:bg-slate-900'
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', toneAccent)} />
      <span className="flex items-center gap-1.5 pl-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {icon}
        {label}
      </span>
      <span className="pl-1.5 text-[clamp(1.05rem,1.7vw,1.5rem)] font-bold leading-tight text-slate-900 dark:text-slate-50">
        <CountUp value={value} format={format} />
        {numeric ? null : null}
      </span>
      {sub ? <span className="pl-1.5 text-[10px] text-slate-500 dark:text-slate-400">{sub}</span> : null}
      {Array.isArray(spark) && spark.length > 1 ? <span className="mt-1 pl-1.5"><Sparkline values={spark} width={150} height={22} color={tone === 'bad' ? '#dc2626' : '#4338ca'} /></span> : null}
    </motion.button>
  );
}

function Bar({ label, value, max, color }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, Math.round((value / max) * 100))) : 0;
  return (
    <div className="py-1">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-600 dark:text-slate-300">{label}</span>
        <b className="text-slate-900 dark:text-slate-100">{value.toLocaleString()}</b>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Row({ left, right, tone }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 text-xs last:border-0 dark:border-slate-800">
      <span className="min-w-0 text-slate-600 dark:text-slate-300">{left}</span>
      <span className="shrink-0 font-semibold text-slate-900 dark:text-slate-100">{right}</span>
      {tone}
    </div>
  );
}

export default function ExecutiveSummary() {
  const [summary, setSummary] = useState(null);
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState('');
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drawer, setDrawer] = useState(null);
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

  const portfolio = summary.portfolio;
  const currency = summary.currency;
  const kpis = summary.kpis || [];
  const trends = summary.trends || { spend: [], condition: [] };
  const recommendations = summary.recommendations || [];
  const degradation = summary.degradation_attention || [];
  const composition = summary.cost_composition || { total: 0, buckets: [] };
  const readiness = summary.workforce_readiness || {};
  const equipment = summary.equipment || {};
  const byStatus = summary.tasks?.by_status || {};

  const meanCondition = (() => {
    const kpi = kpis.find((k) => k.key === 'condition');
    if (kpi && typeof kpi.value === 'number') return kpi.value;
    return summary.valuation?.avg_condition != null ? Number(summary.valuation.avg_condition) : null;
  })();
  const spendPoints = trends.spend.map((row) => ({ label: monthLabel(row.month), value: row.spend }));
  const statusSegments = Object.entries(byStatus).map(([status, count], i) => ({ label: status.replace(/_/g, ' ').toLowerCase(), value: count, color: STATUS_PALETTE[i % STATUS_PALETTE.length] }));

  const kpiMeta = {
    assets: { icon: <Boxes size={13} />, open: 'assets' },
    condition: { icon: <Activity size={13} />, open: 'condition' },
    work: { icon: <Wrench size={13} />, open: 'work' },
    spend: { icon: <Wallet size={13} />, open: 'spend' },
    workforce: { icon: <Users size={13} />, open: 'readiness' },
  };

  const kpiFormat = (kpi) => (n) => {
    if (kpi.key === 'spend') return fmtMoney(n, currency);
    if (kpi.key === 'condition') return Number(n).toFixed(1);
    return Math.round(n).toLocaleString();
  };

  const fallback = [
    { key: 'assets', label: 'Asset population', value: portfolio.assets, sub: `${portfolio.lines} lines · ${portfolio.towers} towers` },
    { key: 'condition', label: 'Mean condition', value: meanCondition ?? '—', sub: `${summary.condition?.assessed ?? 0} assessed` },
    { key: 'work', label: 'Open work orders', value: portfolio.open_tasks, sub: `${portfolio.overdue_tasks} overdue`, tone: portfolio.overdue_tasks ? 'bad' : undefined },
    { key: 'spend', label: '12-month spend', value: summary.maintenance_cost?.totals?.spend ?? 0, sub: `${summary.maintenance_cost?.totals?.count ?? 0} events` },
  ];

  const tiles = kpis.length ? kpis : fallback;
  const drawerTitle = {
    condition: 'Condition detail', assets: 'Asset portfolio', spend: 'Maintenance spend', work: 'Work status',
    readiness: 'Workforce readiness', composition: 'Cost composition', degradation: 'Degradation attention', recs: 'Executive recommendations',
  };

  return (
    <Page title="Executive Command Center" crumbs="TMMS / Executive" actions={controls} fill>
      <div className="exec-briefing">
        <div className="exec-briefing-meta">
          <span>Generated {fmtDateTime(summary.hero?.generated_at || summary.generated_at)}</span>
          <span className="exec-briefing-scope">{summary.hero?.scope || 'All regions'}</span>
        </div>

        <div className="exec-briefing-kpis">
          {tiles.map((kpi, i) => {
            const meta = kpiMeta[kpi.key] || {};
            const numeric = typeof kpi.value === 'number';
            return (
              <Kpi
                key={kpi.key}
                icon={meta.icon}
                label={kpi.label}
                value={kpi.value}
                numeric={numeric}
                format={numeric ? kpiFormat(kpi) : undefined}
                sub={kpi.sub}
                tone={kpi.tone}
                spark={kpi.spark}
                delay={i * 0.06}
                onOpen={() => setDrawer(meta.open || 'assets')}
              />
            );
          })}
        </div>

        <div className="exec-briefing-grid">
          <Panel title="Condition" sub={`${portfolio.assets.toLocaleString()} assets`} delay={0.05} onOpen={() => setDrawer('condition')}>
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <DonutMini condition={summary.condition || {}} total={portfolio.assets} mean={meanCondition} />
            </div>
          </Panel>

          <Panel title="Maintenance spend" sub="12 months" delay={0.1} onOpen={() => setDrawer('spend')}>
            <div className="min-h-0 flex-1">
              {spendPoints.length ? <TrendLine data={spendPoints} height={112} valueFormat={(v) => fmtMoney(v, currency)} /> : <div className="grid h-full place-items-center text-xs text-slate-400">No spend recorded</div>}
            </div>
          </Panel>

          <Panel title="Work status" sub={`${portfolio.open_tasks} open · ${portfolio.overdue_tasks} overdue`} delay={0.15} onOpen={() => setDrawer('work')}>
            {statusSegments.length ? <StackedBar segments={statusSegments} height={12} /> : <div className="text-xs text-slate-400">No tasks recorded</div>}
          </Panel>

          <Panel title="Readiness" sub={`${readiness.active_crews ?? 0}/${readiness.crews ?? 0} crews active`} delay={0.2} onOpen={() => setDrawer('readiness')}>
            <div className="flex items-center gap-4">
              <Ring value={readiness.certification_readiness ?? 0} label="Cert" />
              <Ring value={readiness.crew_readiness ?? 0} label="Crew" />
            </div>
            <div className="mt-auto flex gap-3 pt-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span>Equipment gaps <b className="text-slate-900 dark:text-slate-100">{equipment.missed ?? 0}</b></span>
              <span>Tasks w/ gaps <b className="text-slate-900 dark:text-slate-100">{equipment.tasks_with_gaps ?? 0}</b></span>
            </div>
          </Panel>

          <Panel title="Cost composition" sub={fmtMoney(composition.total, currency)} delay={0.25} onOpen={() => setDrawer('composition')}>
            <StackedBar segments={composition.buckets.map((b) => ({ label: b.label, value: b.spend, color: b.color }))} height={12} />
          </Panel>

          <Panel title="Degradation attention" sub={`Top ${degradation.length}`} delay={0.3} onOpen={() => setDrawer('degradation')}>
            {degradation.length ? (
              <div className="min-h-0 overflow-hidden">
                {degradation.slice(0, 3).map((row) => (
                  <div className="flex items-center gap-2 border-b border-slate-100 py-1 text-xs last:border-0 dark:border-slate-800" key={row.asset_id}>
                    <Badge tone={row.delta <= -3 ? 'danger' : row.delta <= -1.5 ? 'warn' : 'info'}>{row.delta <= -3 ? 'High' : row.delta <= -1.5 ? 'Med' : 'Low'}</Badge>
                    <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">{row.asset_code || row.asset_name}</span>
                    <b className="text-red-600 dark:text-red-400">{row.delta}</b>
                  </div>
                ))}
              </div>
            ) : <div className="text-xs text-slate-400">No degradation signals</div>}
          </Panel>
        </div>

        <div className="exec-briefing-recs">
          <div className="exec-briefing-recs-head">
            <h3>Executive recommendations</h3>
            <button type="button" className="text-[11px] font-semibold text-accent hover:underline" onClick={() => setDrawer('recs')}>View all</button>
          </div>
          {recommendations.length ? (
            <div className="exec-briefing-recs-list">
              {recommendations.slice(0, 4).map((rec) => (
                <div className="exec-rec" key={rec.id}>
                  <Badge tone={rec.severity === 'high' || rec.severity === 'critical' ? 'danger' : rec.severity === 'medium' ? 'warn' : 'info'}>{rec.severity || 'low'}</Badge>
                  <div className="exec-rec-main">
                    <b>{rec.title}</b>
                    {rec.action ? <span className="muted">{rec.action}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="text-xs text-slate-400">No exceptions detected</div>}
        </div>
      </div>

      <Sheet open={!!drawer} onClose={() => setDrawer(null)} title={drawerTitle[drawer] || 'Detail'} description={summary.hero?.scope || 'All regions'}>
        {drawer === 'condition' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {CONDITION.map((c) => (
                <div key={c.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{c.label}</div>
                  <div className="text-lg font-bold" style={{ color: c.color }}>{(summary.condition?.[c.key] || 0).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Mean condition</h4>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-50">{meanCondition != null ? `${Number(meanCondition).toFixed(1)}/10` : '—'}</div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{summary.condition?.assessed ?? 0} of {portfolio.assets.toLocaleString()} assets assessed</p>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Top degradation</h4>
              {degradation.slice(0, 8).map((row) => (
                <Row key={row.asset_id} left={<><b>{row.asset_code}</b> · {row.region || '—'}</>} right={`${row.suggested_rating}/10 (${row.delta})`} />
              ))}
              {!degradation.length && <div className="text-xs text-slate-400">No negative movement recorded.</div>}
            </div>
          </div>
        )}

        {drawer === 'assets' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-center">
              <Stat label="Assets" value={portfolio.assets.toLocaleString()} />
              <Stat label="Lines" value={portfolio.lines.toLocaleString()} />
              <Stat label="Towers" value={portfolio.towers.toLocaleString()} />
              <Stat label="Substations" value={portfolio.substations.toLocaleString()} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Condition mix</h4>
              {CONDITION.map((c) => <Bar key={c.key} label={c.label} value={summary.condition?.[c.key] || 0} max={portfolio.assets} color={c.color} />)}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Condition-adjusted value</h4>
              <Row left="Replacement cost" right={fmtMoney(summary.valuation?.rcn, currency)} />
              <Row left="Current value" right={fmtMoney(summary.valuation?.current, currency)} />
              <Row left="Avg condition" right={summary.valuation?.avg_condition != null ? `${Number(summary.valuation.avg_condition).toFixed(1)}/10` : '—'} />
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
              {!Object.keys(byStatus).length && <div className="text-xs text-slate-400">No tasks recorded.</div>}
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
            <Row left="Valid certifications" right={summary.workforce?.valid_certifications ?? 0} />
            <Row left="Expired certifications" right={summary.workforce?.expired_certifications ?? 0} />
            <Row left="Expiring within 90 days" right={summary.workforce?.expiring_90_days ?? 0} />
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
            {!degradation.length && <div className="text-xs text-slate-400">No degradation signals.</div>}
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

function Ring({ value, label }) {
  const size = 52;
  const thickness = 6;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={thickness} className="text-slate-200 dark:text-slate-700" />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#14532d" strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${(v / 100) * circ} ${circ}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-[11px] font-bold text-slate-900 dark:text-slate-50">{Math.round(v)}%</span>
      </span>
      <span className="text-[10px] text-slate-500 dark:text-slate-400">{label}</span>
    </div>
  );
}

function BigRing({ value, label }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <Ring value={value} label="" />
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
