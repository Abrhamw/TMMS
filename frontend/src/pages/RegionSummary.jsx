import { KpiTile, BarRow, Donut } from '../components/InfraVisuals';

function sortedTypes(assetTypes) {
  return Object.entries(assetTypes || {}).sort((a, b) => b[1] - a[1]);
}

function Chip({ children }) {
  return <span className="infra-chip">{children}</span>;
}

function Legend() {
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
      <span className="ok">■</span> Good 8–10&nbsp;&nbsp;
      <span className="warn">■</span> Fair 5–7&nbsp;&nbsp;
      <span className="bad">■</span> Poor &lt;5
    </div>
  );
}

export default function RegionSummary({ regions, focusId, onPick }) {
  const focused = regions.find((r) => r.id === Number(focusId));

  if (focused) {
    const types = sortedTypes(focused.asset_types);
    const max = types.length ? Math.max(...types.map(([, n]) => n)) : 1;
    return (
      <div>
        <div className="spread">
          <div>
            <h2 className="entity-title">{focused.name}</h2>
            <div className="mt">
              <Chip>{focused.code}</Chip> <Chip>{focused.type}</Chip> <Chip>{focused.status}</Chip>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => onPick(null)}>Back to all regions</button>
        </div>
        <div className="grid grid-4 mt">
          <KpiTile label="Substations" value={focused.substation_count} />
          <KpiTile label="Transmission lines" value={focused.line_count} />
          <KpiTile label="Towers" value={focused.tower_count} />
          <KpiTile label="Circuit length" value={`${focused.circuit_length_km} km`} />
          <KpiTile label="Assets" value={focused.asset_count} sub={`avg condition ${(focused.avg_condition || 0).toFixed(1)}`} />
        </div>
        <div className="grid grid-2 mt">
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Asset mix</h3></div>
            {types.length === 0 && <div className="muted">No categorized assets (towers only)</div>}
            {types.slice(0, 8).map(([type, n]) => (
              <BarRow key={type} label={type.replace(/_/g, ' ')} value={n} max={max} />
            ))}
            {types.length > 8 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>+{types.length - 8} more types</div>}
          </div>
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Condition</h3></div>
            <Donut good={focused.condition_bands.good} fair={focused.condition_bands.fair} poor={focused.condition_bands.poor} />
            <Legend />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-2">
      {regions.map((r) => (
        <div key={r.id} className="card card-pad hub-card" onClick={() => onPick(r.id)}>
          <div className="spread">
            <span><Chip>{r.code}</Chip> <b>{r.name}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>{r.status}</span>
          </div>
          <div className="ktile-value" style={{ margin: '8px 0 4px' }}>{r.asset_count}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {r.substation_count} substations · {r.line_count} lines · {r.tower_count} towers · {r.circuit_length_km} km
          </div>
          <div className="mt">
            {sortedTypes(r.asset_types).slice(0, 4).map(([type, n]) => (
              <Chip key={type}>{type.replace(/_/g, ' ')} {n}</Chip>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
