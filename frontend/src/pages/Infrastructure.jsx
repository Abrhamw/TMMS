import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Page, Loading, ErrorNote } from '../components';
import InfraTree from '../components/InfraTree';
import RegionSummary from './RegionSummary';
import SubstationSummary from './SubstationSummary';
import LineSummary from './LineSummary';
import Regions from './Regions';
import Substations from './Substations';
import Lines from './Lines';
import Towers from './Towers';
import DataValidation from './DataValidation';
import LineMapWorkspace from './LineMapWorkspace';

const TAB_KINDS = [
  { key: 'region', label: 'Regions' },
  { key: 'substation', label: 'Substations' },
  { key: 'line', label: 'Transmission lines' },
];
const MANAGE = { regions: <Regions embedded />, substations: <Substations embedded />, lines: <Lines embedded />, towers: <Towers embedded />, map: <LineMapWorkspace embedded />, validate: <DataValidation embedded /> };

export default function Infrastructure() {
  const [sp, setSp] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const patch = useCallback((obj) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setSp(next, { replace: true });
  }, [sp, setSp]);

  const tab = TAB_KINDS.some((t) => t.key === sp.get('tab')) ? sp.get('tab') : 'region';
  const rid = sp.get('region') ? Number(sp.get('region')) : null;
  const sid = sp.get('substation') ? Number(sp.get('substation')) : null;
  const lid = sp.get('line') ? Number(sp.get('line')) : null;
  const manage = ['regions', 'substations', 'lines', 'towers', 'map', 'validate'].includes(sp.get('manage')) ? sp.get('manage') : null;

  const load = () => api.get('/infrastructure').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const subById = useMemo(() => new Map((data?.substations || []).map((s) => [s.id, s])), [data]);
  const lineById = useMemo(() => new Map((data?.lines || []).map((l) => [l.id, l])), [data]);
  const towersByLine = useMemo(() => {
    const m = {};
    for (const t of data?.towers || []) (m[t.line_id] = m[t.line_id] || []).push(t);
    return m;
  }, [data]);

  const clearScope = () => patch({ region: null, substation: null, line: null, tab: 'region' });
  const goAll = () => patch({ region: null, substation: null, line: null, tab: null, manage: null });

  function pick(scope) {
    if (scope.kind === 'all') return clearScope();
    if (scope.kind === 'region') return patch({ region: scope.id, substation: null, line: null, tab: 'region' });
    if (scope.kind === 'substation') {
      const s = subById.get(scope.id);
      return patch({ region: s ? s.region_id : rid, substation: scope.id, line: null, tab: 'substation' });
    }
    const l = lineById.get(scope.id);
    return patch({ region: l ? l.region_id : rid, substation: null, line: scope.id, tab: 'line' });
  }

  function focusRegion() {
    if (tab !== 'region') return;
    const rows = data.regions.filter((r) => (rid ? r.id === rid : true));
    return <RegionSummary regions={rows} focusId={rid} onPick={(id) => (id === null ? patch({ region: null }) : pick({ kind: 'region', id }))} />;
  }
  function focusSubstation() {
    const rows = data.substations.filter((s) => (rid ? s.region_id === rid : true));
    return <SubstationSummary substations={rows} focusId={sid} onPick={(id) => (id === null ? patch({ substation: null }) : pick({ kind: 'substation', id }))} />;
  }
  function focusLine() {
    const rows = data.lines.filter((l) => (rid ? l.region_id === rid : true));
    return <LineSummary lines={rows} towersByLine={towersByLine} focusId={lid} onPick={(id) => (id === null ? patch({ line: null }) : pick({ kind: 'line', id }))} />;
  }

  const region = rid ? data?.regions.find((r) => r.id === rid) : null;
  const substation = sid ? subById.get(sid) : null;
  const line = lid ? lineById.get(lid) : null;
  const crumbPath = [
    ...(region ? [{ label: region.code, action: () => patch({ region: null, substation: null, line: null }) }] : []),
    ...(substation ? [{ label: substation.substation_id, action: () => patch({ substation: null }) }] : []),
    ...(line ? [{ label: line.line_id, action: () => patch({ line: null }) }] : []),
  ];

  return (
    <Page title="Infrastructure" crumbs="TMMS / Infrastructure"
      actions={<>
        {manage && <button className="btn btn-sm" onClick={goAll}>← Back to Infrastructure summaries</button>}
        {['regions', 'substations', 'lines', 'towers'].map((m) => (
          <button key={m} className="btn btn-sm" onClick={() => patch({ manage: m })}>Manage {m === 'lines' ? 'lines' : m}</button>
        ))}
        <button className="btn btn-sm" onClick={() => patch({ manage: 'map' })}>Map workspace</button>
        <button className="btn btn-sm" onClick={() => patch({ manage: 'validate' })}>Data validation</button>
      </>}>
      {error && <div><ErrorNote error={error} /><button className="btn btn-sm mt" onClick={load}>Retry</button></div>}
      {!data && !error && <Loading />}
      {data && (manage ? MANAGE[manage] : (
        <div className="hub">
          <div className="card hub-tree">
            <InfraTree regions={data.regions} substations={data.substations} lines={data.lines}
              selection={{ region: rid, substation: sid, line: lid }} onSelect={pick} />
          </div>
          <div className="hub-main">
            <div className="crumbs2">
              <span className={region || substation || line ? 'crumb-link' : 'crumb-cur'} onClick={() => { if (region || substation || line) clearScope(); }}>
                All regions
              </span>
              {crumbPath.map((c, i) => (
                <span key={i} style={{ display: 'flex', gap: 6 }}>
                  <span>/</span>
                  <span className="crumb-link" onClick={c.action}>{c.label}</span>
                </span>
              ))}
              {(substation || line) && (
                <span className="crumb-x" onClick={() => { patch({ substation: null, line: null, tab: 'region' }); }} title="Clear focus">✕</span>
              )}
            </div>
            <div className="tabs">
              {TAB_KINDS.map((t) => (
                <button key={t.key} className={'tab' + (tab === t.key ? ' active' : '')}
                  onClick={() => patch({ tab: t.key })}>
                  {t.label}
                </button>
              ))}
            </div>
            {tab === 'region' && focusRegion()}
            {tab === 'substation' && focusSubstation()}
            {tab === 'line' && focusLine()}
          </div>
        </div>
      ))}
    </Page>
  );
}
