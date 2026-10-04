import { BarRow, KpiTile, Donut } from './InfraVisuals';

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 };

// The uniform analytics header every report carries: KPI tiles, bar/trend
// charts, a condition donut and the rule-based expert evaluation (graded
// findings + prioritised recommendations). Rendered above the raw tables so a
// reader sees the judgement before the evidence.
export default function AnalyticsBlock({ a }) {
  if (!a) return null;
  const ev = a.evaluation || {};
  const findings = [...(ev.findings || [])].sort((x, y) => (SEV_ORDER[x.severity] ?? 9) - (SEV_ORDER[y.severity] ?? 9));
  return (
    <div className="analytics">
      {(a.kpis || []).length > 0 && (
        <div className="kpi-grid">
          {a.kpis.map((k, i) => <KpiTile key={i} label={k.label} value={k.value} sub={k.sub} tone={k.tone} />)}
        </div>
      )}
      {((a.bars || []).length > 0 || (a.donuts || []).length > 0) && (
        <div className="analytics-charts">
          {(a.bars || []).map((b, i) => {
            // Scale every bar against the chart's own maximum. Without this a
            // chart that never declared `max` made each bar render at 100% (the
            // bar took its own value as the ceiling), so the comparison was
            // meaningless. An explicit `max` (e.g. 100 for a rate, 10 for a
            // condition score) still wins.
            const max = Number(b.max) > 0
              ? Number(b.max)
              : Math.max(0, ...b.items.map((it) => Number(it.value) || 0));
            return (
              <div key={i} className="card card-pad chart-card">
                <h4 className="chart-title">{b.title}</h4>
                {b.items.map((it, j) => (
                  <BarRow key={j} label={it.label} value={it.value} max={max || it.max} sub={it.sub} color={it.color} valueText={it.valueText} />
                ))}
              </div>
            );
          })}
          {(a.donuts || []).map((d, i) => (
            <div key={`d${i}`} className="card card-pad chart-card donut-card">
              <h4 className="chart-title">{d.title}</h4>
              <Donut good={d.good} fair={d.fair} poor={d.poor} />
              <div className="donut-legend">
                {(d.labels || ['Good', 'Fair', 'Poor']).map((l, j) => (
                  <span key={l} className={`legend-item legend-${['good', 'fair', 'poor'][j]}`}>{l}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {((ev.findings || []).length > 0 || (ev.recommendations || []).length > 0) && (
        <div className="card card-pad eval-card">
          <div className="eval-head">
            <h4 className="chart-title">Expert evaluation</h4>
            {ev.grade && <span className={`grade grade-${ev.grade}`}>Grade {ev.grade}{ev.score != null ? ` · ${ev.score}/100` : ''}</span>}
          </div>
          <ul className="finding-list">
            {findings.map((f, i) => (
              <li key={i} className={`finding finding-${f.severity}`}>
                <span className="finding-dot" />
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
          {(ev.recommendations || []).length > 0 && (
            <div className="rec-block">
              <div className="rec-label">Recommended actions</div>
              <ul className="rec-list">
                {ev.recommendations.map((r, i) => (
                  <li key={i} className={`rec rec-${r.priority}`}>{r.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
