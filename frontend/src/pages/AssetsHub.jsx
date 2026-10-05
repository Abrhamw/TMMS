import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtMoney } from '../api';
import { ErrorNote, Loading, Page } from '../components';
import { KpiTile, BarRow } from '../components/InfraVisuals';
import { Donut, SectionCard, Tabs, EmptyState } from '../components/viz';
import Infrastructure from './Infrastructure';
import Assets from './Assets';

const AREAS = [
  { key: 'overview', label: 'Overview' },
  { key: 'infrastructure', label: 'Infrastructure' },
  { key: 'register', label: 'Register' },
];

function conditionSegments(condition = {}) {
  return [
    { label: 'Critical 1-3', value: condition.critical || 0, color: '#dc2626' },
    { label: 'Poor 4-5', value: condition.poor || 0, color: '#ea580c' },
    { label: 'Fair 6-7', value: condition.fair || 0, color: '#d97706' },
    { label: 'Good 8-10', value: condition.good || 0, color: '#16a34a' },
  ];
}

function AssetsOverview() {
  const [summary, setSummary] = useState(null);
  const [exec, setExec] = useState(null);
  const [subs, setSubs] = useState([]);
  const [regions, setRegions] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get('/assets/summary'),
      api.get('/dashboard/summary').catch(() => null),
      api.get('/substations').catch(() => []),
      api.get('/regions').catch(() => []),
    ])
      .then(([assetSummary, execSummary, substations, regionList]) => {
        setSummary(assetSummary);
        setExec(execSummary);
        setSubs(Array.isArray(substations) ? substations : []);
        setRegions(Array.isArray(regionList) ? regionList : []);
      })
      .catch((e) => setError(e.message));
  }, []);

  const subCount = subs.length;
  const subBays = subs.reduce((n, s) => n + (s.bay_count || 0), 0);
  const subsByRegion = useMemo(() => {
    const map = new Map();
    for (const s of subs) {
      const entry = map.get(s.region_id) || { region_id: s.region_id, count: 0, bays: 0 };
      entry.count += 1;
      entry.bays += s.bay_count || 0;
      map.set(s.region_id, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [subs]);
  const classRows = useMemo(() => {
    const rows = [...((summary && summary.by_class) || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
    if (subCount && !rows.some((r) => r.asset_type === 'SUBSTATION')) rows.push({ asset_type: 'SUBSTATION', count: subCount });
    return rows;
  }, [summary, subCount]);

  if (error) return <ErrorNote error={error} />;
  if (!summary) return <Loading />;

  const total = summary.total_assets || 0;
  const mixRows = classRows.slice(0, 8);
  if (subCount && !mixRows.some((r) => r.asset_type === 'SUBSTATION')) mixRows.push({ asset_type: 'SUBSTATION', count: subCount });
  const currency = exec?.currency;
  const degradation = exec?.degradation_attention || [];
  const valuation = exec?.valuation || {};
  const condition = summary.condition || {};
  const regionName = (id) => regions.find((r) => r.id === id)?.name || `Region ${id}`;

  return (
    <div className="executive-section">
      <div className="executive-kpis">
        <KpiTile label="Assets in service" value={total.toLocaleString()} sub={`${summary.by_class?.length || 0} classes`} />
        <KpiTile label="Substations" value={subCount.toLocaleString()} sub={subBays ? `${subBays} bays` : undefined} />
        <KpiTile label="Current value" value={valuation.current != null ? fmtMoney(valuation.current, currency) : '—'} sub={valuation.rcn != null ? `RCN ${fmtMoney(valuation.rcn, currency)}` : undefined} />
        <KpiTile label="Avg condition" value={valuation.avg_condition != null ? `${Number(valuation.avg_condition).toFixed(1)}/10` : '—'} tone={valuation.avg_condition != null && valuation.avg_condition <= 5 ? 'bad' : 'ok'} />
        <KpiTile label="Regions" value={summary.by_region?.length || 0} />
      </div>

      <div className="executive-grid mt">
        <SectionCard title="Condition distribution" sub={`${total.toLocaleString()} assets`}>
          <Donut segments={conditionSegments(condition)} total={total} centerValue={total.toLocaleString()} centerLabel="assets" />
        </SectionCard>
        <SectionCard title="Mix by class" sub={subCount ? `${classRows.length} classes · incl. substations` : undefined}>
          {mixRows.map((row) => (
            <BarRow key={row.asset_type} label={row.asset_type.replace(/_/g, ' ')} value={row.count} max={total} />
          ))}
          {!classRows.length ? <EmptyState title="No assets">No assets in scope.</EmptyState> : null}
        </SectionCard>
      </div>

      <div className="executive-grid mt">
        <SectionCard title="Assets by region">
          <div className="tbl-wrap"><table><thead><tr><th>Region</th><th>Assets</th><th>Share</th></tr></thead><tbody>
            {(summary.by_region || []).map((row) => (
              <tr key={row.region_id}><td>Region {row.region_id}</td><td>{row.count}</td><td>{total ? `${Math.round(row.count / total * 100)}%` : '0%'}</td></tr>
            ))}
            {!(summary.by_region || []).length ? <tr><td colSpan={3} className="muted">No regional distribution.</td></tr> : null}
          </tbody></table></div>
        </SectionCard>
        <SectionCard title="Substations by region">
          <div className="tbl-wrap"><table><thead><tr><th>Region</th><th>Substations</th><th>Bays</th></tr></thead><tbody>
            {subsByRegion.map((row) => (
              <tr key={row.region_id}><td>{regionName(row.region_id)}</td><td>{row.count}</td><td>{row.bays}</td></tr>
            ))}
            {!subsByRegion.length ? <tr><td colSpan={3} className="muted">No substations in scope.</td></tr> : null}
          </tbody></table></div>
        </SectionCard>
      </div>

      <div className="executive-grid mt">
        <SectionCard title="Top degradation" sub="From the performance model">
          {degradation.length ? (
            <div className="attention-list">
              {degradation.slice(0, 6).map((row) => (
                <div className="attention-item" key={row.asset_id}>
                  <div className="attention-main">
                    <b>{row.asset_code || row.asset_name}</b>
                    <span className="muted">{row.asset_name} · {row.region || '—'} · {row.suggested_rating}/10</span>
                  </div>
                  <span className="contribution-neg">{row.delta}</span>
                </div>
              ))}
            </div>
          ) : <EmptyState title="No degradation signals">Performance data appears once readings or events are recorded.</EmptyState>}
        </SectionCard>
      </div>
    </div>
  );
}

export default function AssetsHub() {
  const [searchParams] = useSearchParams();
  const initial = useMemo(() => {
    const area = searchParams.get('area');
    if (AREAS.some((a) => a.key === area)) return area;
    return searchParams.get('manage') ? 'infrastructure' : 'overview';
  }, []);
  const [area, setArea] = useState(initial);

  return (
    <>
      <div className="hub-tabs-bar">
        <Tabs tabs={AREAS} active={area} onChange={setArea} />
      </div>
      {area === 'overview' && (
        <Page title="Assets" crumbs="TMMS / Assets"><AssetsOverview /></Page>
      )}
      {area === 'infrastructure' && <Infrastructure />}
      {area === 'register' && <Assets />}
    </>
  );
}
