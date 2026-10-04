import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Animate a numeric value from 0 to target once the component mounts.
function useAnimatedNumber(target, duration = 700) {
  const value = Number(target) || 0;
  const [display, setDisplay] = useState(reduced() ? value : 0);
  const raf = useRef(0);
  useEffect(() => {
    if (reduced()) { setDisplay(value); return undefined; }
    const start = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(value * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);
  return display;
}

function Tooltip({ x, y, children, align = 'center' }) {
  return (
    <div
      className="viz-tip"
      style={{
        left: `${x}%`,
        top: y,
        transform: `translate(${align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0'}, -120%)`,
      }}
    >
      {children}
    </div>
  );
}

export function Gauge({ value, max = 100, label, sub, size = 150, color = '#14532d', bands }) {
  const raw = Math.max(0, Math.min(Number(max) || 100, Number(value) || 0));
  const shown = useAnimatedNumber(raw);
  const pct = max > 0 ? shown / max : 0;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const arc = 0.75;
  const bandColor = bands && bands.length
    ? bands.slice().sort((a, b) => Number(a.max) - Number(b.max)).find((b) => raw <= Number(b.max))?.color
    : null;
  const strokeColor = bandColor || color;
  return (
    <div className="viz-gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label || 'gauge'}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${arc * circ} ${circ}`} transform={`rotate(135 ${cx} ${cy})`} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={strokeColor} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${pct * arc * circ} ${circ}`} transform={`rotate(135 ${cx} ${cy})`} />
        <text x={cx} y={cy + 2} textAnchor="middle" fontSize={size * 0.2} fontWeight="800" fill="#0f172a">{Math.round(shown * 10) / 10}</text>
        {label ? <text x={cx} y={cy + size * 0.16} textAnchor="middle" fontSize={size * 0.085} fill="#64748b">{label}</text> : null}
      </svg>
      {sub ? <div className="viz-gauge-sub">{sub}</div> : null}
    </div>
  );
}

export function Donut({ segments, size = 140, thickness = 22, total, totalLabel, centerValue, centerLabel }) {
  const segs = (segments || []).filter((s) => Number(s.value) > 0);
  const sum = Number(total) > 0 ? Number(total) : segs.reduce((acc, s) => acc + (Number(s.value) || 0), 0);
  const [hover, setHover] = useState(-1);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const active = hover >= 0 ? segs[hover] : null;
  const activePct = active && sum > 0 ? Math.round((Number(active.value) / sum) * 100) : null;
  return (
    <div className="viz-donut">
      <div className="viz-donut-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="distribution">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth={thickness} />
          {segs.map((s, i) => {
            const frac = sum > 0 ? (Number(s.value) || 0) / sum : 0;
            const len = frac * circ;
            const el = (
              <circle
                key={s.label || i}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={s.color || '#64748b'}
                strokeWidth={hover === i ? thickness + 3 : thickness}
                strokeDasharray={`${len} ${circ - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${cx} ${cy})`}
                opacity={hover >= 0 && hover !== i ? 0.35 : 1}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(-1)}
                style={{ cursor: 'pointer', transition: 'opacity .15s ease, stroke-width .15s ease' }}
              />
            );
            offset += len;
            return el;
          })}
          {!segs.length ? <text x={cx} y={cy} textAnchor="middle" fontSize="11" fill="#64748b">No data</text> : null}
        </svg>
        {(centerValue != null || centerLabel || active) ? (
          <div className="viz-donut-hole" style={{ width: size - thickness * 2, height: size - thickness * 2 }}>
            {active ? (
              <>
                <b>{activePct}%</b>
                <span>{active.label}</span>
              </>
            ) : (
              <>
                {centerValue != null ? <b>{centerValue}</b> : null}
                {centerLabel ? <span>{centerLabel}</span> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
      {segs.length ? (
        <div className="viz-legend">
          {segs.map((s, i) => (
            <span
              className="viz-legend-item"
              key={s.label || i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(-1)}
              style={{ cursor: 'pointer', fontWeight: hover === i ? 700 : undefined }}
            >
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
  const [hover, setHover] = useState(-1);
  let acc = 0;
  return (
    <div className="viz-stacked">
      <div className="viz-stacked-track" style={{ height, position: 'relative' }}>
        {segs.map((s, i) => {
          const width = sum > 0 ? (Number(s.value) / sum) * 100 : 0;
          const left = acc;
          acc += width;
          return (
            <div
              key={s.label || i}
              className="viz-stacked-seg"
              style={{ width: `${width}%`, background: s.color || '#64748b', opacity: hover >= 0 && hover !== i ? 0.4 : 1, transition: 'opacity .15s ease, filter .15s ease', filter: hover === i ? 'brightness(1.1)' : undefined }}
              title={`${s.label}: ${s.value}${unit}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(-1)}
            >
              {hover === i && <Tooltip x={left + width / 2}>{s.label}: <b>{s.value}{unit}</b></Tooltip>}
            </div>
          );
        })}
      </div>
      {showLegend ? (
        <div className="viz-stacked-legend">
          {segs.map((s, i) => (
            <span className="viz-legend-item" key={s.label || i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)} style={{ cursor: 'pointer', fontWeight: hover === i ? 700 : undefined }}>
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
  if (!nums.length) return { line: '', area: '', min: 0, max: 0, points: [] };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = nums.length > 1 ? (width - pad * 2) / (nums.length - 1) : 0;
  const pts = nums.map((n, i) => [pad + i * step, height - pad - ((n - min) / span) * (height - pad * 2)]);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  return { line, area, min, max, points: pts };
}

export function Sparkline({ values, width = 120, height = 34, color = '#4338ca', fill = true }) {
  const { line, area } = buildPoints(values, width, height, 3);
  if (!line) return <svg width={width} height={height} className="viz-spark" aria-hidden="true" />;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="viz-spark" aria-hidden="true">
      {fill ? (
        <motion.path
          d={area}
          fill={color}
          className="viz-spark-area"
          initial={reduced() ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced() ? 0 : 0.6, delay: reduced() ? 0 : 0.15 }}
        />
      ) : null}
      <motion.path
        d={line}
        stroke={color}
        className="viz-spark-line"
        fill="none"
        initial={reduced() ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: reduced() ? 0 : 0.8, ease: 'easeOut' }}
      />
    </svg>
  );
}

export function TrendLine({ data, width = 520, height = 160, color = '#4338ca', valueFormat }) {
  const values = (data || []).map((d) => Number(d.value) || 0);
  const pad = 28;
  const { line, area, points } = buildPoints(values, width, height, pad);
  const labels = data || [];
  const [hover, setHover] = useState(-1);
  if (!line) return <div className="muted" style={{ fontSize: 12 }}>No trend data</div>;
  const fmt = (d) => (valueFormat ? valueFormat(d.value) : String(d.value));
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const hp = hover >= 0 ? points[hover] : null;
  return (
    <div className="viz-trend" style={{ position: 'relative' }}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="trend" preserveAspectRatio="none">
        <motion.path
          d={area}
          fill={color}
          className="viz-spark-area"
          initial={reduced() ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced() ? 0 : 0.6, delay: reduced() ? 0 : 0.2 }}
        />
        <motion.path
          d={line}
          stroke={color}
          className="viz-spark-line"
          fill="none"
          vectorEffect="non-scaling-stroke"
          initial={reduced() ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: reduced() ? 0 : 0.9, ease: 'easeOut' }}
        />
        {hp ? (
          <>
            <line x1={hp[0]} y1={pad / 2} x2={hp[0]} y2={height - pad} stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" vectorEffect="non-scaling-stroke" />
            <circle cx={hp[0]} cy={hp[1]} r="4" fill={color} stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
        {points.map((p, i) => (
          <rect
            key={i}
            x={pad + i * step - step / 2}
            y="0"
            width={step || width}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(-1)}
            style={{ cursor: 'crosshair' }}
          />
        ))}
      </svg>
      {hp && labels[hover] ? (
        <div
          className="viz-tip"
          style={{ left: `${((hp[0] - pad) / (width - pad * 2)) * 100}%`, top: 4, transform: 'translate(-50%, -110%)' }}
        >
          <b>{fmt(labels[hover])}</b>
          {labels[hover].label ? <span> · {labels[hover].label}</span> : null}
        </div>
      ) : null}
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
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={reduced() ? false : { strokeDashoffset: circ }}
          animate={{ strokeDashoffset: circ - (v / 100) * circ }}
          transition={{ duration: reduced() ? 0 : 0.8, ease: 'easeOut' }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
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
      {(title || actions || sub) ? (
        <div className="section-card-head">
          <h3>{title}</h3>
          <div className="ui-card-head-actions">
            {sub ? <span className="muted">{sub}</span> : null}
            {actions || null}
          </div>
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
