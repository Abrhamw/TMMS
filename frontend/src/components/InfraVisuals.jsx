import { Sparkline } from './viz';

export function KpiTile({ label, value, sub, tone, spark }) {
  return (
    <div className={`card card-pad ktile${tone ? ` ktile-${tone}` : ''}`}>
      <span className="ktile-accent" />
      <div className="ktile-label">{label}</div>
      <div className="ktile-value">{value ?? '—'}</div>
      {sub ? <div className="ktile-sub">{sub}</div> : null}
      {Array.isArray(spark) && spark.length > 1 ? (
        <div className="ktile-spark"><Sparkline values={spark} width={160} height={30} /></div>
      ) : null}
    </div>
  );
}

export function BarRow({ label, value, max, sub, color = 'var(--chart-1)', valueText }) {
  const num = Number(value) || 0;
  const hi = Number(max) > 0 ? Number(max) : num;
  const pct = hi > 0 ? Math.max(1.5, Math.min(100, Math.round((num / hi) * 100))) : 0;
  return (
    <div className="bar-row">
      <div className="spread">
        <span>{label}{sub ? <span className="muted"> · {sub}</span> : null}</span>
        <b>{valueText ?? num}</b>
      </div>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

export function Donut({ good, fair, poor }) {
  const total = (Number(good) || 0) + (Number(fair) || 0) + (Number(poor) || 0);
  if (!total) {
    return (
      <div className="donut-wrap">
        <div className="donut" style={{ background: 'var(--surface-3)' }}><div className="donut-hole" /></div>
        <div className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 8 }}>No assessed assets</div>
      </div>
    );
  }
  const stops = [];
  let acc = 0;
  const add = (v, color) => {
    if (!v) return;
    const p = (v / total) * 360;
    stops.push(`${color} ${acc}deg ${acc + p}deg`);
    acc += p;
  };
  add(Number(good) || 0, 'var(--chart-1)');
  add(Number(fair) || 0, 'var(--severity-medium)');
  add(Number(poor) || 0, 'var(--severity-high)');
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ background: `conic-gradient(${stops.join(', ')})` }}><div className="donut-hole" /></div>
    </div>
  );
}
