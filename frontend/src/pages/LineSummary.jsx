import { useEffect, useState } from 'react';
import { api } from '../api';
import { KpiTile, BarRow } from '../components/InfraVisuals';
import Comments from '../components/Comments';

function Chip({ children }) {
  return <span className="infra-chip">{children}</span>;
}

function sortedTypes(assetTypes) {
  return Object.entries(assetTypes || {}).sort((a, b) => b[1] - a[1]);
}

function conductorLabel(c) {
  return c ? c : 'Not recorded';
}

export default function LineSummary({ lines, focusId, onPick }) {
  const focused = lines.find((l) => l.id === Number(focusId));
  // Towers for a single line are fetched only when a line is opened, instead
  // of shipping the whole national tower list with the infrastructure summary.
  const [towers, setTowers] = useState([]);
  const focusedId = focused ? focused.id : null;
  useEffect(() => {
    if (focusedId == null) { setTowers([]); return undefined; }
    let alive = true;
    api.get(`/towers?line_id=${focusedId}`)
      .then((r) => { if (alive) setTowers(Array.isArray(r) ? r : (r.items || [])); })
      .catch(() => { if (alive) setTowers([]); });
    return () => { alive = false; };
  }, [focusedId]);

  if (focused) {
    const types = sortedTypes(focused.asset_types);
    const max = types.length ? Math.max(...types.map(([, n]) => n)) : 1;
    const route = `${focused.from_sub ? focused.from_sub.name : '—'} ⇄ ${focused.to_sub ? focused.to_sub.name : '—'}`;
    return (
      <div>
        <div className="spread">
          <div>
            <h2 className="entity-title">{focused.name}</h2>
            <div className="mt">
              <Chip>{focused.line_id}</Chip>
              <Chip>{focused.voltage_kv} kV</Chip>
              <Chip>{focused.circuit_count === 2 ? 'Double circuit' : 'Single circuit'}</Chip>
              <Chip>{focused.operational_status}</Chip>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => onPick(null)}>Back to all lines</button>
        </div>
        <div className="muted mt">{route}</div>
        <div className="grid grid-4 mt">
          <KpiTile label="Towers" value={focused.tower_count} sub={`spacing ${focused.tower_spacing_km} km`} />
          <KpiTile label="Length" value={`${focused.length_km} km`} />
          <KpiTile label="Conductor" value={conductorLabel(focused.conductor_type)} />
          <KpiTile label="Joint boxes" value={focused.joint_box_count} />
          <KpiTile label="Fiber (OPGW)" value={focused.fiber_on_towers.towers} sub={`${focused.fiber_on_towers.qty} spans`} />
          <KpiTile label="Conductor spans" value={focused.conductor_span_count} />
        </div>
        <div className="grid grid-2 mt">
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Line asset mix</h3></div>
            {types.length === 0 && <div className="muted">No line-level assets (towers carry the line)</div>}
            {types.slice(0, 8).map(([type, n]) => (
              <BarRow key={type} label={type.replace(/_/g, ' ')} value={n} max={max} />
            ))}
          </div>
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Towers on this line</h3></div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Tower</th><th>km</th><th>Type</th><th>Height</th><th>Corrosion</th><th>GPS</th><th>Parts</th></tr></thead>
                <tbody>
                  {towers.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.tower_id}</td>
                      <td>{t.km_marker ?? '—'}</td>
                      <td>{t.tower_type}</td>
                      <td>{t.height_m ? `${t.height_m} m` : '—'}</td>
                      <td>{t.corrosion_rating}</td>
                      <td>{t.gps_validated ? '✓' : '—'}</td>
                      <td>{t.component_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {towers.length === 0 && <div className="muted mt">No towers recorded yet</div>}
          </div>
        </div>
        <div className="card card-pad mt">
          <Comments entityType="transmission_line" entityId={focused.id} title="Line comments" placeholder="Comment on this line…" />
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Line</th><th>Route</th><th>kV</th><th>Circuit</th><th>km</th><th>Towers</th><th>Conductor</th><th>Fiber</th><th>JB</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} onClick={() => onPick(l.id)} style={{ cursor: 'pointer' }}>
                <td><b>{l.line_id}</b> <span className="muted" style={{ fontSize: 12 }}>{l.name}</span></td>
                <td>{l.from_sub ? l.from_sub.name : '—'} ⇄ {l.to_sub ? l.to_sub.name : '—'}</td>
                <td>{l.voltage_kv}</td>
                <td>{l.circuit_count === 2 ? 'Double' : 'Single'}</td>
                <td>{l.length_km}</td>
                <td>{l.tower_count} <span className="muted">({l.tower_spacing_km}/km)</span></td>
                <td>{conductorLabel(l.conductor_type)}</td>
                <td>{l.fiber_on_towers.towers ? `${l.fiber_on_towers.towers} towers` : '—'}</td>
                <td>{l.joint_box_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length === 0 && <div className="muted" style={{ padding: 12 }}>No transmission lines in this scope</div>}
    </div>
  );
}
