// Shared map legend. `groups` is an array of { title, entries }, where each
// entry is { label, color, shape, dash }. `shape` selects the mini glyph so the
// legend can explain not just colours but what each map symbol means.
export function LegendSwatch({ shape = 'dot', color = '#64748b', dash = false }) {
  if (shape === 'line') return <span className="map-swatch map-swatch--line" style={{ background: color }} />;
  if (shape === 'polygon') return <span className="map-swatch map-swatch--poly" style={{ borderColor: color }} />;
  if (shape === 'circle') return <span className="map-swatch map-swatch--circle" style={{ borderColor: color, borderStyle: dash ? 'dashed' : 'solid' }} />;
  if (shape === 'pin') return <span className="map-swatch map-swatch--pin" style={{ background: color }} />;
  if (shape === 'yard') return <span className="map-swatch map-swatch--yard" style={{ borderColor: color }} />;
  return <span className="pill-dot" style={{ background: color }} />;
}

export default function MapLegend({ groups = [] }) {
  return (
    <>
      {groups.map((g, gi) => (
        <div className="map-legend-group" key={g.title || `g${gi}`}>
          {g.title && <b className="map-legend-title">{g.title}</b>}
          {(g.entries || []).map((e) => (
            <div className="li" key={e.label}>
              <LegendSwatch shape={e.shape} color={e.color} dash={e.dash} />
              <span>{e.label}</span>
            </div>
          ))}
          {(g.notes || []).map((n) => (
            <div className="map-legend-note" key={n}>{n}</div>
          ))}
        </div>
      ))}
    </>
  );
}
