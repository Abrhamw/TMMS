import { useEffect, useState } from 'react';
import { api, fmtNum, fmtMoney, condColor } from '../api';

function countBadge(n) {
  return <span className="pill" style={{ background: '#eef2ff', color: '#4338ca', fontSize: 11 }}>{n}</span>;
}

export default function RegisterTree({ canWrite, regionId, onChangeRegion, onSelectAsset, onNewAsset }) {
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState({}); // "sub:3" | "line:4" | "sub:3:CONTROL_AND_PROTECTION" | "line:4:towers" ...
  const [jbLine, setJbLine] = useState(null);   // { line, busy, dry, error }
  const [val, setVal] = useState(null);

  const load = () => {
    const q = regionId ? `?region_id=${regionId}` : '';
    api.get(`/register/tree${q}`).then((r) => { setTree(r); setErr(null); }).catch((e) => setErr(e.message));
  };
  useEffect(load, [regionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const rid = regionId || (tree && tree.regions.length === 1 ? tree.regions[0].region.id : null);
    if (!rid) { setVal(null); return; }
    api.get(`/register/valuation?region_id=${rid}`).then(setVal).catch(() => setVal(null));
  }, [tree, regionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k) => setExpanded((m) => ({ ...m, [k]: !m[k] }));

  const runDryRun = async (line, apply) => {
    try {
      setJbLine({ line, busy: true, error: null, dry: null });
      const dry = await api.post(`/lines/${line.id}/generate-joint-boxes?dry_run=${apply ? '0' : '1'}`, {});
      if (apply) {
        setJbLine(null);
        load();
      } else {
        setJbLine({ line, busy: false, error: null, dry });
      }
    } catch (e) {
      setJbLine({ line, busy: false, error: e.message, dry: null });
    }
  };

  if (err) return <div className="card card-pad muted" style={{ color: '#dc2626' }}>{err}</div>;
  if (!tree) return <div className="card card-pad muted">Loading register…</div>;

  const RegionNode = ({ region }) => (
    <div className="mb">
      <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(`r:${region.id}`)}>
        <b>{region.region.name}</b>
        <span>{countBadge(region.counts.assets)}</span>
      </div>
      {expanded[`r:${region.id}`] && (
        <div style={{ marginLeft: 14 }}>
          {region.substations.map((s) => <SubstationNode key={s.id} regionId={region.region.id} s={s} />)}
          {region.lines.map((l) => <LineNode key={l.id} l={l} />)}
        </div>
      )}
    </div>
  );

  const SubstationNode = ({ regionId, s }) => {
    const open = expanded[`sub:${s.id}`];
    return (
      <div>
        <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(`sub:${s.id}`)}>
          <span>■ {s.name} <span className="muted">({s.substation_id})</span></span>
          <span>{countBadge(s.counts.assets)}</span>
        </div>
        {open && (
          <div style={{ marginLeft: 16 }}>
            {s.families.map((f) => {
              const fk = `sub:${s.id}:${f.family}`;
              const fOpen = expanded[fk];
              return (
                <div key={f.family}>
                  <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(fk)}>
                    <span>▸ {f.family_label}</span>
                    <span>{countBadge(f.bays.reduce((n, b) => n + b.count, 0))}</span>
                  </div>
                  {fOpen && (
                    <div style={{ marginLeft: 16 }}>
                      {f.bays.map((bay) => (
                        <div key={bay.bay}>
                          <div className="muted" style={{ fontSize: 12 }}>Bay: {bay.bay} · {bay.count}</div>
                          {bay.assets.map((a) => (
                            <div key={a.id} className="spread" style={{ fontSize: 13, marginLeft: 10 }}>
                              <button className="link" style={{ textAlign: 'left' }} onClick={() => onSelectAsset(a)}>
                                {a.asset_type}: {a.name} <span className="mono muted">{a.asset_id}</span>
                              </button>
                              <span style={{ color: condColor(a.condition_rating) }}>●</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const LineNode = ({ l }) => {
    const open = expanded[`line:${l.id}`];
    return (
      <div>
        <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(`line:${l.id}`)}>
          <span>‖ {l.name} <span className="muted">({l.line_id})</span></span>
          <span>{countBadge(l.counts.assets)}</span>
        </div>
        {open && (
          <div style={{ marginLeft: 16 }}>
            <div className="spread muted" style={{ fontSize: 12 }}>
              <span>{l.voltage_kv ? `${l.voltage_kv} kV` : ''} · {l.length_km ? `${fmtNum(l.length_km)} km` : ''}</span>
              {canWrite && <button className="btn btn-sm" onClick={() => runDryRun(l, false)}>Joint boxes…</button>}
            </div>
            <div style={{ fontSize: 12 }}><span className="muted">Spans</span> {countBadge(l.counts.spans)}</div>
            {expanded[`line:${l.id}:spans`] === true && l.spans.map((sp) => (
              <div key={sp.id} className="spread" style={{ marginLeft: 10 }}>
                <button className="link" onClick={() => onSelectAsset(sp)}>{sp.asset_type} · {sp.name}</button>
                <span className="mono muted">{sp.km_from ?? 0}–{sp.km_to ?? '—'} km</span>
              </div>
            ))}
            {l.counts.spans > 0 && <button className="link muted" style={{ marginLeft: 10 }} onClick={() => toggle(`line:${l.id}:spans`)}>{expanded[`line:${l.id}:spans`] ? 'hide' : 'show'} spans</button>}
            <div style={{ fontSize: 12, marginTop: 6 }}><span className="muted">Joint boxes</span> {countBadge(l.counts.joint_boxes)}</div>
            {expanded[`line:${l.id}:jb`] === true && l.joint_boxes.map((jb) => (
              <div key={jb.id} className="spread" style={{ marginLeft: 10 }}>
                <button className="link" onClick={() => onSelectAsset(jb)}>{jb.name}</button>
                <span className="mono muted">{jb.km} km</span>
              </div>
            ))}
            {l.counts.joint_boxes > 0 && <button className="link muted" style={{ marginLeft: 10 }} onClick={() => toggle(`line:${l.id}:jb`)}>{expanded[`line:${l.id}:jb`] ? 'hide' : 'show'} boxes</button>}
            <div style={{ fontSize: 12, marginTop: 6 }}><span className="muted">Towers</span> {countBadge(l.counts.towers)}</div>
            {expanded[`line:${l.id}:towers`] === true && l.towers.map((t) => (
              <div key={t.id} style={{ marginLeft: 10 }}>
                <div className="spread">
                  <span>{t.tower_id} <span className="muted">· {t.tower_type} · {t.foundation_type}</span></span>
                  <span className="muted mono">{t.km_marker ?? 0} km · {t.part_count} parts</span>
                </div>
                {expanded[`t:${t.id}`] && (
                  <div style={{ marginLeft: 14 }} className="muted">
                    {t.parts.map((p, i) => <div key={i} style={{ fontSize: 12 }}>· {p.name} × {p.quantity} {p.unit}</div>)}
                  </div>
                )}
                <button className="link muted" style={{ marginLeft: 12, fontSize: 12 }} onClick={() => toggle(`t:${t.id}`)}>{expanded[`t:${t.id}`] ? 'hide' : 'show'} parts</button>
              </div>
            ))}
            {l.counts.towers > 0 && <button className="link muted" style={{ marginLeft: 10 }} onClick={() => toggle(`line:${l.id}:towers`)}>{expanded[`line:${l.id}:towers`] ? 'hide' : 'show'} towers</button>}
            {canWrite && (
              <div className="mt">
                <button className="btn btn-sm" onClick={() => onNewAsset({ line_id: l.id })}>+ Add line asset</button>
                <span className="muted" style={{ marginLeft: 8 }}>joint boxes every ~{l.joint_box_interval_km ?? 5} km</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card card-pad">
      {tree.regions.length > 1 && (
        <div className="filters" style={{ marginBottom: 8 }}>
          <select value={regionId ?? ''} onChange={(e) => onChangeRegion(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All regions</option>
            {tree.regions.map((r) => <option key={r.region.id} value={r.region.id}>{r.region.name}</option>)}
          </select>
        </div>
      )}
      {val && (
        <div className="card card-pad mb" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
          <div className="spread">
            <div><div className="muted" style={{ fontSize: 12 }}>Estimated register value (RCN)</div><div style={{ fontSize: 20, fontWeight: 700 }}>{fmtMoney(val.totals.rcn, val.currency?.code)}</div></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Condition-adjusted</div><div style={{ fontSize: 20, fontWeight: 700 }}>{fmtMoney(val.totals.current, val.currency?.code)}</div></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Assets</div><div style={{ fontSize: 20, fontWeight: 700 }}>{val.totals.count}</div></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Unpriced</div><div style={{ fontSize: 20, fontWeight: 700 }}>{val.totals.unpriced_count}</div></div>
          </div>
        </div>
      )}
      {tree.regions.map((r) => <RegionNode key={r.region.id} region={r} />)}
      {jbLine && (
        <div className="card card-pad" style={{ marginTop: 10 }}>
          <b>Joint boxes — {jbLine.line.name}</b>
          {jbLine.error && <div style={{ color: '#dc2626' }}>{jbLine.error}</div>}
          {jbLine.dry && (
            <>
              <div style={{ fontSize: 13 }}>Will create {jbLine.dry.proposals.filter((p) => p.status === 'new').length} box(es):</div>
              <div style={{ margin: '6px 0' }}>
                {jbLine.dry.proposals.filter((p) => p.status === 'new').map((p) => (
                  <span key={p.km} className="pill" style={{ background: '#dcfce7', marginRight: 4 }}>{p.asset_id}@{p.km}km</span>
                ))}
                {jbLine.dry.proposals.filter((p) => p.status === 'existing').length > 0 && <span className="muted" style={{ fontSize: 12 }}>({jbLine.dry.proposals.filter((p) => p.status === 'existing').length} already present)</span>}
              </div>
              <button className="btn btn-sm btn-primary" disabled={jbLine.busy} onClick={() => runDryRun(jbLine.line, true)}>Create boxes</button>
            </>
          )}
          {jbLine.busy && <span className="muted">working…</span>}
        </div>
      )}
    </div>
  );
}
