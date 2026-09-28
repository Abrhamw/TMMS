export function KpiTile({ label, value, sub, tone }) {
  return (
    <div className={`card card-pad ktile${tone ? ` ktile-${tone}` : ''}`}>
      <div className="ktile-label">{label}</div>
      <div className="ktile-value">{value ?? '—'}</div>
      {sub ? <div className="ktile-sub">{sub}</div> : null}
    </div>
  );
}

export function BarRow({ label, value, max, sub, color = '#4338ca', valueText }) {
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
        <div className="donut" style={{ background: '#e5e7eb' }}><div className="donut-hole" /></div>
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
  add(Number(good) || 0, '#16a34a');
  add(Number(fair) || 0, '#d97706');
  add(Number(poor) || 0, '#dc2626');
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ background: `conic-gradient(${stops.join(', ')})` }}><div className="donut-hole" /></div>
    </div>
  );
}
