import { Button } from '../ui/Button';
import { getDevicePosition } from './MapPicker';
import { parseStored } from '../checklistFormat';
import { t } from '../i18n';

// One checklist step input, shared by every execution surface so PASS/FAIL,
// numeric, select, GPS and free-text steps behave identically wherever a crew
// records a run.
export default function ChecklistItem({ item, state, setState }) {
  const set = (value) => setState({ ...state, value });

  if (item.response_type === 'PASS_FAIL' || item.response_type === 'YES_NO') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant={state.value === true ? 'primary' : 'outline'} size="lg" onClick={() => set(true)}>{t('ok')}</Button>
        <Button type="button" variant={state.value === false ? 'danger' : 'outline'} size="lg" onClick={() => set(false)}>{t('notOk')}</Button>
      </div>
    );
  }
  if (item.response_type === 'NUMERIC') {
    const pc = parseStored(item.pass_criteria);
    return (
      <div className="flex">
        <input type="number" style={{ width: 180 }} value={state.value ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} placeholder="Enter value" />
        {pc && Number.isFinite(pc.min) && <span className="muted">Pass range: {pc.min}–{pc.max} {pc.unit || ''}</span>}
      </div>
    );
  }
  if (item.response_type === 'SELECT') {
    const opts = parseStored(item.pass_criteria)?.options || [];
    return (
      <div className="flex flex-wrap gap-2">
        {opts.map((o) => (
          <Button key={o} type="button" variant={state.value === o ? 'primary' : 'outline'} size="lg" onClick={() => set(o)}>{o}</Button>
        ))}
      </div>
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
