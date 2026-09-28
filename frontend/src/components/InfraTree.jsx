import { useEffect, useMemo, useState } from 'react';

function Badge({ n }) {
  return n != null && Number(n) > 0 ? <span className="hub-badge">{n}</span> : null;
}

export default function InfraTree({ regions, substations, lines, selection, onSelect }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set());

  const subsByRegion = useMemo(() => {
    const m = {};
    for (const s of substations) (m[s.region_id] = m[s.region_id] || []).push(s);
    return m;
  }, [substations]);
  const linesByRegion = useMemo(() => {
    const m = {};
    for (const l of lines) (m[l.region_id] = m[l.region_id] || []).push(l);
    return m;
  }, [lines]);

  // Auto-open regions that contain the selected entity.
  useEffect(() => {
    if (selection.substation || selection.line) {
      const rid = selection.substation
        ? (substations.find((s) => s.id === Number(selection.substation)) || {}).region_id
        : (lines.find((l) => l.id === Number(selection.line)) || {}).region_id;
      if (rid) setOpen((prev) => new Set(prev).add(rid));
    } else if (selection.region) {
      setOpen((prev) => new Set(prev).add(Number(selection.region)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.region, selection.substation, selection.line]);

  const ql = q.trim().toLowerCase();
  const filteredRegions = ql
    ? regions.filter((r) =>
        r.name.toLowerCase().includes(ql) || r.code.toLowerCase().includes(ql) ||
        (subsByRegion[r.id] || []).some((s) => s.name.toLowerCase().includes(ql) || s.substation_id.toLowerCase().includes(ql)) ||
        (linesByRegion[r.id] || []).some((l) => l.name.toLowerCase().includes(ql) || l.line_id.toLowerCase().includes(ql)))
    : regions;

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const sel = (kind, id) => {
    const row = (kind === 'region' ? { r: regions } : kind === 'substation' ? { r: substations } : { r: lines }).r.find((x) => x.id === Number(id));
    const label = row ? (row.name || row.substation_id || row.line_id) : '';
    onSelect({ kind, id: Number(id), label });
  };

  const cls = (match) => match ? 'hub-node sel' : 'hub-node';

  return (
    <div className="hub-tree-pad">
      <input className="hub-search" placeholder="Search regions, substations, lines…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className={cls(!selection.region && !selection.substation && !selection.line)} onClick={() => onSelect({ kind: 'all', label: 'All regions' })}>
        <span className="ico">▣</span> All regions <Badge n={regions.length} />
      </div>
      {filteredRegions.map((r) => {
        const subs = subsByRegion[r.id] || [];
        const lins = linesByRegion[r.id] || [];
        const isOpen = open.has(r.id) || !!ql;
        return (
          <div key={r.id}>
            <div className={cls(selection.region === r.id && !selection.substation && !selection.line)}>
              <button className="hub-caret" onClick={() => toggle(r.id)}>{isOpen ? '▾' : '▸'}</button>
              <span className="hub-row-main" onClick={() => sel('region', r.id)}>
                {r.code} · <span className="muted">{r.name}</span>
              </span>
              <Badge n={subs.length + lins.length} />
            </div>
            {isOpen && (
              <div className="hub-child">
                {subs.length > 0 && (
                  <>
                    <div className="hub-folder">Substations <Badge n={subs.length} /></div>
                    {subs.map((s) => (
                      <div key={s.id} className={cls(selection.substation === s.id)}>
                        <span className="hub-row-main leaf" onClick={() => sel('substation', s.id)}>{s.name}</span>
                        <Badge n={s.asset_count} />
                      </div>
                    ))}
                  </>
                )}
                {lins.length > 0 && (
                  <>
                    <div className="hub-folder">Lines <Badge n={lins.length} /></div>
                    {lins.map((l) => (
                      <div key={l.id} className={cls(selection.line === l.id)}>
                        <span className="hub-row-main leaf" onClick={() => sel('line', l.id)}>{l.line_id}</span>
                        <Badge n={l.tower_count} />
                      </div>
                    ))}
                  </>
                )}
                {subs.length === 0 && lins.length === 0 && <div className="muted hub-empty">No children</div>}
              </div>
            )}
          </div>
        );
      })}
      {filteredRegions.length === 0 && <div className="muted hub-empty">No matches</div>}
    </div>
  );
}
