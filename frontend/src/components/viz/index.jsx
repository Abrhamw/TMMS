export function Gauge({ value, max = 100, label, sub, size = 150, color = '#14532d', bands }) {
  const v = Math.max(0, Math.min(Number(max) || 100, Number(value) || 0));
  const pct = max > 0 ? v / max : 0;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const arc = 0.75;
  const bandColor = bands && bands.length
    ? bands.slice().sort((a, b) => Number(a.max) - Number(b.max)).find((b) => v <= Number(b.max))?.color
    : null;
  const strokeColor = bandColor || color;
  return (
    <div className="viz-gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label || 'gauge'}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${arc * circ} ${circ}`} transform={`rotate(135 ${cx} ${cy})`} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={strokeColor} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${pct * arc * circ} ${circ}`} transform={`rotate(135 ${cx} ${cy})`} />
        <text x={cx} y={cy + 2} textAnchor="middle" fontSize={size * 0.2} fontWeight="800" fill="#0f172a">{Math.round(v * 10) / 10}</text>
        {label ? <text x={cx} y={cy + size * 0.16} textAnchor="middle" fontSize={size * 0.085} fill="#64748b">{label}</text> : null}
      </svg>
      {sub ? <div className="viz-gauge-sub">{sub}</div> : null}
    </div>
  );
}

export function Donut({ segments, size = 140, thickness = 22, total, totalLabel, centerValue, centerLabel }) {
  const segs = (segments || []).filter((s) => Number(s.value) > 0);
  const sum = Number(total) > 0 ? Number(total) : segs.reduce((acc, s) => acc + (Number(s.value) || 0), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="viz-donut">
      <div className="viz-donut-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="distribution">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth={thickness} />
          {segs.map((s, i) => {
            const frac = sum > 0 ? (Number(s.value) || 0) / sum : 0;
            const len = frac * circ;
            const el = (
              <circle key={s.label || i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color || '#64748b'} strokeWidth={thickness} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${cx} ${cy})`} />
            );
            offset += len;
            return el;
          })}
          {!segs.length ? <text x={cx} y={cy} textAnchor="middle" fontSize="11" fill="#64748b">No data</text> : null}
        </svg>
        {(centerValue != null || centerLabel) ? (
          <div className="viz-donut-hole" style={{ width: size - thickness * 2, height: size - thickness * 2 }}>
            {centerValue != null ? <b>{centerValue}</b> : null}
            {centerLabel ? <span>{centerLabel}</span> : null}
          </div>
        ) : null}
      </div>
      {segs.length ? (
        <div className="viz-legend">
          {segs.map((s, i) => (
            <span className="viz-legend-item" key={s.label || i}>
              <span className="viz-swatch" style={{ background: s.color || '#64748b' }} />
              {s.label}{totalLabel ? ` ${s.value}` : ''}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StackedBar({ segments, height = 14, showLegend = true, unit = '' }) {
  const segs = (segments || []).filter((s) => Number(s.value) > 0);
  const sum = segs.reduce((acc, s) => acc + (Number(s.value) || 0), 0);
  return (
    <div className="viz-stacked">
      <div className="viz-stacked-track" style={{ height }}>
        {segs.map((s, i) => (
          <div key={s.label || i} className="viz-stacked-seg" style={{ width: `${sum > 0 ? (Number(s.value) / sum) * 100 : 0}%`, background: s.color || '#64748b' }} title={`${s.label}: ${s.value}${unit}`} />
        ))}
      </div>
      {showLegend ? (
        <div className="viz-stacked-legend">
          {segs.map((s, i) => (
            <span className="viz-legend-item" key={s.label || i}>
              <span className="viz-swatch" style={{ background: s.color || '#64748b' }} />
              {s.label} {s.value}{unit}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildPoints(values, width, height, pad) {
  const nums = (values || []).map((v) => Number(v) || 0);
  if (!nums.length) return { line: '', area: '', min: 0, max: 0 };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = nums.length > 1 ? (width - pad * 2) / (nums.length - 1) : 0;
  const pts = nums.map((n, i) => [pad + i * step, height - pad - ((n - min) / span) * (height - pad * 2)]);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  return { line, area, min, max };
}

export function Sparkline({ values, width = 120, height = 34, color = '#4338ca', fill = true }) {
  const { line, area } = buildPoints(values, width, height, 3);
  if (!line) return <svg width={width} height={height} className="viz-spark" aria-hidden="true" />;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="viz-spark" aria-hidden="true">
      {fill ? <path d={area} fill={color} className="viz-spark-area" /> : null}
      <path d={line} stroke={color} className="viz-spark-line" />
    </svg>
  );
}

export function TrendLine({ data, width = 520, height = 160, color = '#4338ca', valueFormat }) {
  const values = (data || []).map((d) => Number(d.value) || 0);
  const pad = 28;
  const { line, area } = buildPoints(values, width, height, pad);
  const labels = data || [];
  if (!line) return <div className="muted" style={{ fontSize: 12 }}>No trend data</div>;
  const fmt = (d) => (valueFormat ? valueFormat(d.value) : String(d.value));
  return (
    <div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="trend" preserveAspectRatio="none">
        <path d={area} fill={color} className="viz-spark-area" />
        <path d={line} stroke={color} className="viz-spark-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="viz-trend-labels">
        {labels.map((d, i) => (
          <span key={d.label || i} className="viz-trend-label" title={fmt(d)}>{d.label || fmt(d)}</span>
        ))}
      </div>
    </div>
  );
}

export function ProgressRing({ value, size = 54, thickness = 6, color = '#14532d', label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <span className="viz-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label || 'progress'}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={thickness} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${(v / 100) * circ} ${circ}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="viz-ring-text">{label || `${Math.round(v)}%`}</span>
    </span>
  );
}

export function SeverityBadge({ severity, children }) {
  const key = String(severity || '').toLowerCase();
  const cls = key === 'critical' || key === 'high' ? 'sev-high' : key === 'medium' || key === 'warn' ? 'sev-medium' : 'sev-low';
  return <span className={`sev-badge ${cls}`}>{children || key || 'low'}</span>;
}

export function SectionCard({ title, sub, actions, children, className = '' }) {
  return (
    <section className={`section-card ${className}`.trim()}>
      {(title || actions) ? (
        <div className="section-card-head">
          <h3>{title}</h3>
          {actions ? <div>{actions}</div> : (sub ? <span className="muted">{sub}</span> : null)}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Tabs({ tabs, active, onChange, className = '' }) {
  return (
    <nav className={`ui-tabs ${className}`.trim()} role="tablist">
      {(tabs || []).map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} className={'ui-tab' + (active === t.key ? ' active' : '')} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div className="ui-empty">
      {title ? <b>{title}</b> : null}
      {children ? <span>{children}</span> : null}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14, className = '', style }) {
  return <div className={`ui-skeleton ${className}`.trim()} style={{ width, height, ...(style || {}) }} aria-hidden="true" />;
}
