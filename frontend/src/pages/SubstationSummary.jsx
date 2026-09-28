import { KpiTile, BarRow } from '../components/InfraVisuals';

function Chip({ children }) {
  return <span className="infra-chip">{children}</span>;
}

function sortedTypes(assetTypes) {
  return Object.entries(assetTypes || {}).sort((a, b) => b[1] - a[1]);
}

function voltageChips(levels) {
  return (levels || []).map((v) => <Chip key={v}>{v}</Chip>);
}

export default function SubstationSummary({ substations, focusId, onPick }) {
  const focused = substations.find((s) => s.id === Number(focusId));

  if (focused) {
    const types = sortedTypes(focused.asset_types);
    const max = types.length ? Math.max(...types.map(([, n]) => n)) : 1;
    return (
      <div>
        <div className="spread">
          <div>
            <h2 className="entity-title">{focused.name}</h2>
            <div className="mt">
              <Chip>{focused.substation_id}</Chip>
              <Chip>{focused.region_code}</Chip>
              {voltageChips(focused.voltage_levels)}
              <Chip>{focused.operational_status}</Chip>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => onPick(null)}>Back to all substations</button>
        </div>
        <div className="grid grid-4 mt">
          <KpiTile label="Transformers" value={focused.transformer_count} />
          <KpiTile label="Incident lines" value={focused.incident_lines.length} />
          <KpiTile label="Bays" value={focused.bay_count} />
          <KpiTile label="Assets" value={focused.asset_count} />
        </div>
        <div className="grid grid-3 mt">
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Asset mix</h3></div>
            {types.length === 0 && <div className="muted">No equipment registered in this substation</div>}
            {types.slice(0, 8).map(([type, n]) => (
              <BarRow key={type} label={type.replace(/_/g, ' ')} value={n} max={max} />
            ))}
          </div>
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Bays</h3></div>
            {(!focused.bays || focused.bays.length === 0) && <div className="muted">No bay labels recorded on this substation's assets yet</div>}
            {(focused.bays || []).map((b) => (
              <div key={b.bay} className="spread" style={{ padding: '4px 0' }}>
                <span>{b.bay}</span>
                <span className="muted" style={{ fontSize: 12 }}>{b.count} asset(s)</span>
              </div>
            ))}
          </div>
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Incident transmission lines</h3></div>
            {focused.incident_lines.length === 0 && <div className="muted">No lines terminate at this substation</div>}
            {focused.incident_lines.map((l) => (
              <div key={l.id} className="spread" style={{ padding: '4px 0' }}>
                <span><b>{l.line_id}</b> — {l.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>{l.voltage_kv} kV</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-2">
      {substations.map((s) => (
        <div key={s.id} className="card card-pad hub-card" onClick={() => onPick(s.id)}>
          <div className="spread">
            <span><Chip>{s.substation_id}</Chip> <b>{s.name}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>{s.region_code}</span>
          </div>
          <div className="mt">{voltageChips(s.voltage_levels)}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {s.transformer_count} transformers · {s.incident_lines.length} lines · {s.bay_count} bays · {s.asset_count} assets
          </div>
        </div>
      ))}
    </div>
  );
}
