import { SearchSelect } from '../components';
import { getDevicePosition } from './MapPicker';

// One checklist step input, shared by every execution surface so PASS/FAIL,
// numeric, select, GPS and free-text steps behave identically wherever a crew
// records a run.
export default function ChecklistItem({ item, state, setState }) {
  const set = (value) => setState({ ...state, value });

  if (item.response_type === 'PASS_FAIL' || item.response_type === 'YES_NO') {
    return (
      <SearchSelect value={state.value ?? ''} onChange={(e) => set(e.target.value === 'true' ? true : e.target.value === 'false' ? false : null)}>
        <option value="">Select…</option><option value="true">Pass / Yes</option><option value="false">Fail / No</option>
      </SearchSelect>
    );
  }
  if (item.response_type === 'NUMERIC') {
    const pc = item.pass_criteria;
    return (
      <div className="flex">
        <input type="number" style={{ width: 180 }} value={state.value ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} placeholder="Enter value" />
        {pc && Number.isFinite(pc.min) && <span className="muted">Pass range: {pc.min}–{pc.max} {pc.unit || ''}</span>}
      </div>
    );
  }
  if (item.response_type === 'SELECT') {
    const opts = item.pass_criteria?.options || [];
    return (
      <SearchSelect value={state.value ?? ''} onChange={(e) => set(e.target.value)}>
        <option value="">Select…</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </SearchSelect>
    );
  }
  if (item.response_type === 'GPS_POINT') {
    let pos = null;
    try { pos = typeof state.value === 'string' ? JSON.parse(state.value) : state.value; } catch (_) { /* ignore */ }
    return (
      <div>
        <button className="btn btn-sm" onClick={() => {
          getDevicePosition().then((p) => {
            set(JSON.stringify({ lat: p.lat, lng: p.lng, accuracy_m: p.accuracy }));
          }).catch(() => {});
        }}>Capture location</button>
        {pos && <span className="muted" style={{ marginLeft: 8 }}>{Number(pos.lat).toFixed(5)}, {Number(pos.lng).toFixed(5)}</span>}
      </div>
    );
  }
  return <input value={state.value ?? ''} onChange={(e) => set(e.target.value)} />;
}
