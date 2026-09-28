import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtDate } from '../api';
import { SearchSelect, Page, MoneyCard, Loading, ErrorNote } from '../components';
import { BarRow } from '../components/InfraVisuals';
import { can, getStoredUser } from '../auth';

export default function Value() {
  const canWrite = can(getStoredUser(), 'asset:write');
  const [tab, setTab] = useState('valuation');
  const [currency, setCurrency] = useState('USD');
  const [regions, setRegions] = useState([]);
  const [regionId, setRegionId] = useState(null);
  const [val, setVal] = useState(null);
  const [cost, setCost] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);
  const now = new Date();
  const [range, setRange] = useState({
    from: new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  });

  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/settings').then((s) => { if (s && s.currency) setCurrency(s.currency); }).catch(() => {});
    api.get('/asset-catalog').then(setCatalog).catch((e) => setError(e.message));
  }, []);

  const scopeQ = regionId ? `&region_id=${regionId}` : '';
  const loadVal = () => api.get(`/register/valuation${regionId ? `?region_id=${regionId}` : ''}`).then(setVal).catch((e) => setError(e.message));
  const loadCost = () => api.get(`/maintenance-cost?from=${range.from}&to=${range.to}${scopeQ}`).then(setCost).catch((e) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadVal(); }, [regionId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCost(); }, [regionId, range]);

  async function savePrice(row) {
    try {
      setSaving(row.id);
      await api.put(`/asset-catalog/${row.id}`, { default_unit_price: Number(drafts[row.id]) });
      const res = await api.get('/asset-catalog');
      setCatalog(res);
      const next = { ...drafts };
      delete next[row.id];
      setDrafts(next);
    } catch (e) { setError(e.message); }
    finally { setSaving(null); }
  }

  return (
    <Page title="Value & Cost" crumbs="TMMS / Management">
      {error && <ErrorNote error={error} />}
      <div className="filters">
        <button className={`btn btn-sm${tab === 'valuation' ? ' btn-primary' : ''}`} onClick={() => setTab('valuation')}>Valuation</button>
        <button className={`btn btn-sm${tab === 'cost' ? ' btn-primary' : ''}`} onClick={() => setTab('cost')}>Maintenance cost</button>
        <button className={`btn btn-sm${tab === 'prices' ? ' btn-primary' : ''}`} onClick={() => setTab('prices')}>Prices</button>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>{currency}</span>
        <SearchSelect value={regionId ?? ''} onChange={(e) => setRegionId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">All regions (my scope)</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </SearchSelect>
      </div>

      {tab === 'valuation' && (
        <div className="mt">
          {!val && <Loading />}
          {val && (
            <>
              <div className="grid grid-4">
                <MoneyCard label="Population (assets)" value={fmtMoney(val.totals.count, val.currency.code)} sub={`${val.regions.length} region(s) · avg condition ${(val.totals.avg_condition || 0).toFixed(1)}`} />
                <MoneyCard label="Replacement cost (RCN)" value={fmtMoney(val.totals.rcn, val.currency.code)} sub="benchmark catalog prices × quantity" />
                <MoneyCard label="Condition-adjusted value" value={fmtMoney(val.totals.current, val.currency.code)} sub="RCN × condition / 10" />
                <MoneyCard label="Unpriced assets" value={fmtMoney(val.totals.unpriced_count, val.currency.code)} sub={val.unpriced_types.length ? `${val.unpriced_types.length} type(s) without a price` : 'all priced'} />
              </div>
              {val.unpriced_types.length > 0 && (
                <div className="card card-pad mt">
                  <div className="card-head"><h3 className="card-title">Unpriced types</h3></div>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Asset type</th><th>Assets</th></tr></thead>
                      <tbody>
                        {val.unpriced_types.map((u) => (
                          <tr key={u.asset_type}><td className="mono">{u.asset_type}</td><td>{u.count}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Add a price on the Prices tab to include these in value totals.</div>
                </div>
              )}
              <div className="grid grid-2 mt">
                <div className="card card-pad">
                  <h3 className="section-title">By region</h3>
                  {val.regions.map((r) => (
                    <BarRow key={r.region_id} label={r.region.name} value={r.current} max={Math.max(...val.regions.map((x) => x.current), 1)} sub={`${r.count} assets`} valueText={fmtMoney(r.current, val.currency.code)} />
                  ))}
                </div>
                <div className="card card-pad">
                  <h3 className="section-title">By location</h3>
                  {val.by_location.map((l) => (
                    <BarRow key={l.location} label={l.label} value={l.current} max={Math.max(...val.by_location.map((x) => x.current), 1)} sub={`${l.count} assets`} valueText={fmtMoney(l.current, val.currency.code)} />
                  ))}
                </div>
              </div>
              <div className="grid grid-2 mt">
                <div className="card card-pad">
                  <h3 className="section-title">By family</h3>
                  {val.by_family.map((f) => (
                    <BarRow key={f.family} label={f.family_label} value={f.current} max={Math.max(...val.by_family.map((x) => x.current), 1)} sub={`${f.count} assets`} valueText={fmtMoney(f.current, val.currency.code)} />
                  ))}
                </div>
                <div className="card card-pad">
                  <h3 className="section-title">By asset type</h3>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Type</th><th>Assets</th><th>RCN</th><th>Current value</th></tr></thead>
                      <tbody>
                        {val.by_type.slice(0, 12).map((t) => (
                          <tr key={t.asset_type}>
                            <td>{t.label}</td>
                            <td>{t.count}</td>
                            <td>{fmtMoney(t.rcn, val.currency.code)}</td>
                            <td><b>{fmtMoney(t.current, val.currency.code)}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'cost' && (
        <div className="mt">
          <div className="filters">
            <label style={{ fontSize: 12 }}>From</label>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <label style={{ fontSize: 12 }}>To</label>
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
          {!cost && <Loading />}
          {cost && (
            <>
              <div className="grid grid-4">
                <MoneyCard label="Total spend" value={fmtMoney(cost.totals.spend, cost.currency.code)} sub={`${cost.totals.count} event(s)`} />
                <MoneyCard label="Average per event" value={fmtMoney(cost.totals.avg, cost.currency.code)} />
                <MoneyCard label="Regions with spend" value={fmtMoney(cost.by_region.length, cost.currency.code)} />
                <MoneyCard label="Event types" value={fmtMoney(cost.by_event_type.length, cost.currency.code)} />
              </div>
              <div className="grid grid-2 mt">
                <div className="card card-pad">
                  <h3 className="section-title">Monthly spend</h3>
                  {cost.monthly.map((m) => (
                    <BarRow key={m.month} label={m.month} value={m.spend} max={Math.max(...cost.monthly.map((x) => x.spend), 1)} sub={`${m.count} event(s)`} valueText={fmtMoney(m.spend, cost.currency.code)} />
                  ))}
                  {cost.monthly.length === 0 && <div className="muted">No events in period.</div>}
                </div>
                <div className="card card-pad">
                  <h3 className="section-title">By asset type</h3>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Type</th><th>Events</th><th>Spend</th></tr></thead>
                      <tbody>
                        {cost.by_asset_type.map((t) => (
                          <tr key={t.asset_type}><td>{t.asset_type}</td><td>{t.count}</td><td><b>{fmtMoney(t.spend, cost.currency.code)}</b></td></tr>
                        ))}
                        {cost.by_asset_type.length === 0 && <tr><td colSpan={3} className="muted">No data.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <h3 className="section-title mt">By event type</h3>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Type</th><th>Events</th><th>Spend</th></tr></thead>
                      <tbody>
                        {cost.by_event_type.map((t) => (
                          <tr key={t.event_type}><td>{t.event_type}</td><td>{t.count}</td><td><b>{fmtMoney(t.spend, cost.currency.code)}</b></td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="card card-pad mt">
                <h3 className="section-title">Recent events</h3>
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>Date</th><th>Asset</th><th>Type</th><th>Summary</th><th>Cost</th></tr></thead>
                    <tbody>
                      {cost.recent.map((e) => (
                        <tr key={e.id}>
                          <td className="nowrap">{fmtDate(e.performed_at)}</td>
                          <td>{e.asset_name ? `${e.asset_name} (${e.asset_id})` : '—'}</td>
                          <td>{e.event_type}</td>
                          <td className="muted">{e.crew_name || ''}</td>
                          <td><b>{fmtMoney(e.cost, cost.currency.code)}</b></td>
                        </tr>
                      ))}
                      {cost.recent.length === 0 && <tr><td colSpan={5} className="muted">No events in period.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'prices' && (
        <div className="card card-pad mt">
          <div className="muted mb" style={{ fontSize: 13 }}>
            Benchmark replacement costs (RCN) per catalog class in {currency}. KM rows price the span length (per kilometre); all other units price one unit. Prices are editable by users with asset:write.
          </div>
          {!catalog && <Loading />}
          {catalog && catalog.families.filter((f) => f.family !== 'TOWER_PARTS').map((f) => (
            <div key={f.family} className="mb">
              <div className="card-head"><h3 className="card-title">{f.family_label || f.family}</h3></div>
              <div className="tbl-wrap mt">
                <table>
                  <thead><tr><th>Class</th><th>Unit</th><th>Current price</th><th>New price</th><th></th></tr></thead>
                  <tbody>
                    {f.types.map((t) => {
                      const dirty = drafts[t.id] !== undefined && String(drafts[t.id]) !== String(t.default_unit_price ?? '');
                      return (
                        <tr key={t.id}>
                          <td>{t.label || t.asset_type}</td>
                          <td className="mono muted">{t.unit_of_measure}</td>
                          <td>{Number(t.default_unit_price) > 0 ? fmtMoney(t.default_unit_price, currency) : <span className="muted">not set</span>}</td>
                          <td>
                            <input
                              type="number"
                              min="0"
                              step="100"
                              style={{ width: 130 }}
                              disabled={!canWrite}
                              value={drafts[t.id] ?? t.default_unit_price ?? ''}
                              onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })}
                            />
                          </td>
                          <td>
                            {canWrite && dirty && (
                              <button className="btn btn-sm btn-primary" disabled={saving === t.id} onClick={() => savePrice(t)}>{saving === t.id ? '…' : 'Update'}</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {canWrite && <div className="muted" style={{ fontSize: 12 }}>Save writes go through the standard catalog endpoint (audited).</div>}
        </div>
      )}
    </Page>
  );
}
