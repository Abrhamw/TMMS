import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ClipboardCheck, MapPin, Camera, Flag, Check, ChevronLeft, ChevronRight,
  Loader2, Upload, Navigation, FileText, PackageCheck, X,
} from 'lucide-react';
import { api, fmtDateTime } from '../api';
import { Pill, Loading, ErrorNote } from '../components';
import { can, getStoredUser } from '../auth';
import { priorityLabel, taskTypeLabel, statusLabel } from '../labels';
import { getDevicePosition } from './MapPicker';
import ChecklistItem from './ChecklistItem';
import ReadinessNotes from './ReadinessNotes';
import SyncStatus from './SyncStatus';
import WorkPanelOverlay from './WorkPanelOverlay';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { cn } from '../ui/cn';
import { t } from '../i18n';

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function readFileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

// One guided execution surface for a crew member or lead: start work, run the
// checklist, capture the finishing location and photos, then hand off. It wraps
// the same task endpoints the full Task Detail page uses, but presents a single
// obvious next step instead of eight sections.
export default function TaskRunner({ taskId, onClose, onChanged }) {
  const me = getStoredUser();
  const canExecute = can(me, 'task:execute');
  const canStart = can(me, 'task:start') || can(me, 'task:manage');
  const canLead = can(me, 'task:lead') || can(me, 'task:manage');
  const canAttach = can(me, 'attachment:write');

  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  const [notif, setNotif] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [gps, setGps] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [uploading, setUploading] = useState(null);
  const [equipmentDraft, setEquipmentDraft] = useState({});
  const [equipmentBusy, setEquipmentBusy] = useState(false);

  const load = () => api.get(`/tasks/${taskId}`).then((x) => {
    setTask(x);
    const checks = x.readiness?.equipment_checks || [];
    setEquipmentDraft(Object.fromEntries(checks.map((c) => [c.equipment, c.available])));
    setError(null);
  }).catch((e) => setError(e.message));

  useEffect(() => {
    setTask(null); setTpl(null); setChecklist(null); setGps(null); setError(null); setStep(null); setSheet(null); setEquipmentDraft({});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  function flash(msg, ms = 3200) {
    setNotif(msg);
    setTimeout(() => setNotif(null), ms);
  }

  async function act(action, extra) {
    try {
      setBusy(true);
      await api.post(`/tasks/${taskId}/state`, { action, ...extra });
      await load();
      if (onChanged) onChanged();
      flash(t('updated'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function openChecklist(templateId) {
    try {
      const data = await api.get(`/tasks/${taskId}/checklist`);
      const list = data.templates || (data.template ? [data.template] : []);
      const chosen = list.find((y) => y.id === templateId) || list[0];
      if (!chosen) { setError(t('noData')); return; }
      const items = {};
      chosen.items.forEach((it) => { items[it.id] = { value: null, comment: '' }; });
      setTpl(chosen);
      setChecklist(items);
    } catch (e) { setError(e.message); }
  }

  async function submitRun() {
    try {
      setBusy(true);
      const items = Object.entries(checklist).map(([tid, v]) => ({ template_item_id: Number(tid), response_value: v.value, comment: v.comment }));
      const body = { template_id: tpl.id, items };
      if (gps) body.finish_gps = gps;
      const res = await api.post(`/tasks/${taskId}/checklist`, body);
      setTpl(null); setChecklist(null);
      await load();
      if (onChanged) onChanged();
      if (!canLead) flash(t('waitingLead'), 4200);
      else if (res.templates_done === false) flash(`${t('result')}: ${res.result} — other checklists pending`, 4200);
      else flash(`${t('result')}: ${res.result}`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function saveEquipment() {
    try {
      setEquipmentBusy(true);
      const checks = (task?.readiness?.equipment_checks || []).map((c) => ({
        equipment: c.equipment,
        available: equipmentDraft[c.equipment] === true,
      }));
      await api.put(`/tasks/${taskId}/equipment-checks`, { checks });
      await load();
      if (onChanged) onChanged();
      flash(t('updated'));
    } catch (e) { setError(e.message); }
    finally { setEquipmentBusy(false); }
  }

  async function capture() {
    try {
      setBusy(true);
      const p = await getDevicePosition();
      setGps({ lat: p.lat, lng: p.lng, accuracy_m: p.accuracy });
      setSheet(null);
      flash(t('locationCaptured'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    try {
      setBusy(true);
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        setUploading(`${i + 1}/${files.length}`);
        const data = await readFileData(file);
        const isImg = String(file.type || '').startsWith('image/');
        await api.post(`/tasks/${taskId}/attachments`, { file_name: file.name, mime: file.type || 'application/octet-stream', kind: isImg ? 'PHOTO' : 'DOC', data, note: '' });
      }
      await load();
      if (onChanged) onChanged();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); setUploading(null); }
  }

  if (error && !task) return <WorkPanelOverlay><div className="p-3"><ErrorNote error={error} /><button className="btn btn-sm mt" onClick={onClose}>{t('cancel')}</button></div></WorkPanelOverlay>;
  if (!task) return <WorkPanelOverlay><div className="p-3"><Loading /></div></WorkPanelOverlay>;

  const x = task;
  const where = x.tower?.tower_id || x.asset?.name || x.substation?.name || x.line?.name || '—';
  const templates = x.checklist_templates?.length ? x.checklist_templates : (x.checklist_template ? [x.checklist_template] : []);
  const executions = x.executions || [];
  const attachments = x.attachments || [];
  const answered = checklist
    ? tpl.items.filter((it) => {
        const v = checklist[it.id]?.value;
        return v !== null && v !== undefined && v !== '';
      }).length
    : 0;
  const total = tpl ? tpl.items.length : 0;
  const done = ['COMPLETED', 'CANCELLED', 'FAILED'].includes(x.status);
  const inRun = checklist !== null;

  const checklistDone = templates.length === 0
    || executions.some((e) => e.submitted_at && e.result && e.result !== 'INCOMPLETE');
  const locationDone = !!gps || executions.some((e) => e.gps_lat != null);
  const photosDone = attachments.length > 0;
  const equipmentChecks = x.readiness?.equipment_checks || [];
  const equipmentDone = equipmentChecks.length === 0 || equipmentChecks.every((c) => c.answered);
  const canCheckEquipment = canStart || canExecute;

  const steps = [
    ...(equipmentChecks.length ? [{ key: 'equipment', icon: PackageCheck, label: t('stepEquipment'), done: equipmentDone }] : []),
    { key: 'checklist', icon: ClipboardCheck, label: t('stepChecklist'), done: checklistDone },
    { key: 'location', icon: MapPin, label: t('stepLocation'), done: locationDone },
    { key: 'photos', icon: Camera, label: t('stepPhotos'), done: photosDone },
    { key: 'handoff', icon: Flag, label: t('stepHandoff'), done },
  ];
  const firstOpen = steps.findIndex((s) => !s.done);
  const activeKey = step || steps[firstOpen === -1 ? steps.length - 1 : firstOpen].key;
  const activeIndex = steps.findIndex((s) => s.key === activeKey);
  const completedCount = steps.filter((s) => s.done).length;

  function goTo(key) {
    setStep(key);
  }

  function move(delta) {
    const next = Math.max(0, Math.min(steps.length - 1, activeIndex + delta));
    setStep(steps[next].key);
  }

  if (inRun) {
    return (
      <WorkPanelOverlay>
        <div className="work-panel-head">
          <div className="min-w-0">
            <b className="block truncate">{t('runChecklist')}: {tpl.name}</b>
            <div className="muted text-xs">{x.task_number} — {x.title}</div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>{t('cancel')}</button>
        </div>

        {notif && <div className="alert alert-success">{notif}</div>}
        {error && <ErrorNote error={error} />}

        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="font-semibold">{t('checklistProgress')}</span>
            <span className="muted">{answered} / {total}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <motion.div
              className="h-full rounded-full bg-brand"
              initial={false}
              animate={{ width: `${total ? (answered / total) * 100 : 0}%` }}
              transition={{ duration: reduced() ? 0 : 0.3, ease: 'easeOut' }}
            />
          </div>
        </div>

        <div className="space-y-3">
          {tpl.items.map((it) => {
            const state = checklist[it.id];
            const filled = state?.value !== null && state?.value !== undefined && state?.value !== '';
            return (
              <div key={it.id} className={cn('rounded-xl border p-3 transition-colors', filled ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-slate-200 dark:border-slate-800')}>
                <div className="flex items-start justify-between gap-2">
                  <b className="text-sm">{it.sequence}. {it.instruction}</b>
                  {filled && <Check size={16} className="mt-0.5 shrink-0 text-emerald-600" />}
                </div>
                <div className="muted mb-2 text-xs">{it.section || '—'}{it.test_equipment ? ` · ${it.test_equipment}` : ''}</div>
                <ChecklistItem item={it} state={state} setState={(s) => setChecklist({ ...checklist, [it.id]: s })} />
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className={cn('text-xs', gps ? 'text-emerald-600 dark:text-emerald-400' : 'muted')}>
            {gps ? `${Number(gps.lat).toFixed(5)}, ${Number(gps.lng).toFixed(5)} · ${t('accuracy')} ${gps.accuracy_m} m` : t('captureGps')}
          </span>
          <button className="btn btn-sm" onClick={() => setSheet('gps')} disabled={busy}><Navigation size={14} /> {t('useDeviceLocation')}</button>
        </div>

        <div className="work-panel-actions">
          <Button variant="primary" size="lg" onClick={submitRun} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
            {x.status === 'ASSIGNED' ? t('startWork') : t('submitTask')}
          </Button>
          <Button variant="outline" size="lg" onClick={() => { setChecklist(null); setTpl(null); }} disabled={busy}>{t('cancel')}</Button>
        </div>

        <CaptureSheets sheet={sheet} setSheet={setSheet} gps={gps} capture={capture} busy={busy} canAttach={canAttach} attachments={attachments} uploadFiles={uploadFiles} uploading={uploading} />
      </WorkPanelOverlay>
    );
  }

  return (
    <WorkPanelOverlay>
      <div className="work-panel-head">
        <div className="min-w-0">
          <b className="block truncate">{x.task_number} — {x.title}</b>
          <div className="muted flex flex-wrap items-center gap-2 text-xs">
            <span>{taskTypeLabel(x.task_type)} · {priorityLabel(x.priority)}</span>
            <Pill value={x.status} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SyncStatus />
          <a className="btn btn-sm" href={`/tasks/${taskId}`}>{t('openFullTask')}</a>
          <button className="btn btn-sm" aria-label={t('close')} title={t('close')} onClick={onClose}><X size={16} /></button>
        </div>
      </div>

      {notif && <div className="alert alert-success">{notif}</div>}
      {error && <ErrorNote error={error} />}

      {/* Animated stepper: tap a step to jump, the bar shows overall progress. */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {activeIndex + 1} / {steps.length} · {steps[activeIndex].label}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">{completedCount}/{steps.length}</span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <motion.div
            className="h-full rounded-full bg-brand"
            initial={false}
            animate={{ width: `${(completedCount / steps.length) * 100}%` }}
            transition={{ duration: reduced() ? 0 : 0.35, ease: 'easeOut' }}
          />
        </div>
        <div className={cn('mt-3 grid gap-2', steps.length > 4 ? 'grid-cols-5' : 'grid-cols-4')}>
          {steps.map((s) => {
            const Icon = s.icon;
            const active = s.key === activeKey;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => goTo(s.key)}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-[11px] font-semibold transition-colors',
                  active
                    ? 'border-brand bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : s.done
                      ? 'border-emerald-200 bg-white text-emerald-700 dark:border-emerald-900 dark:bg-slate-900 dark:text-emerald-300'
                      : 'border-slate-200 bg-white text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400'
                )}
              >
                <span className={cn('grid h-7 w-7 place-items-center rounded-full', s.done && !active ? 'bg-emerald-100 dark:bg-emerald-950' : 'bg-slate-100 dark:bg-slate-800')}>
                  {s.done && !active ? <Check size={15} /> : <Icon size={15} />}
                </span>
                <span className="w-full truncate text-center">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="kv mb-3">
        <span className="k">{t('due')}</span><span>{fmtDateTime(x.due_date)}</span>
        <span className="k">{t('where')}</span><span>{where}</span>
        <span className="k">{t('region')}</span><span>{x.region?.name || '—'}</span>
        <span className="k">{t('assignedTo')}</span><span>{x.crew?.name || '—'}</span>
      </div>
      <p className="muted mb-3">{x.description || x.title}</p>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeKey}
          initial={reduced() ? false : { opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced() ? { opacity: 0 } : { opacity: 0, x: -12 }}
          transition={{ duration: reduced() ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {activeKey === 'equipment' && (
            <StepBlock
              done={equipmentDone}
              title={t('stepEquipment')}
              hint={`${equipmentChecks.filter((c) => c.answered).length} / ${equipmentChecks.length}`}
            >
              <div className="w-full space-y-2">
                {equipmentChecks.map((c) => {
                  const checked = equipmentDraft[c.equipment] === true;
                  return (
                    <label key={c.equipment} className="flex items-center gap-3 rounded-xl border border-slate-200 p-2 text-sm dark:border-slate-800">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canCheckEquipment || equipmentBusy}
                        onChange={(e) => setEquipmentDraft((prev) => ({ ...prev, [c.equipment]: e.target.checked }))}
                      />
                      <span className="flex-1">{c.equipment}</span>
                      <span className={cn('grid h-5 w-5 place-items-center rounded-full', checked ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>
                        {checked && <Check size={12} />}
                      </span>
                    </label>
                  );
                })}
                {canCheckEquipment && (
                  <Button variant="primary" size="lg" onClick={saveEquipment} disabled={equipmentBusy}>
                    {equipmentBusy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {t('save')}
                  </Button>
                )}
              </div>
            </StepBlock>
          )}

          {activeKey === 'checklist' && (
            <StepBlock
              done={checklistDone}
              title={t('stepChecklist')}
              hint={templates.map((c) => c.name).join(', ') || t('noData')}
            >
              {x.status === 'ASSIGNED' && canStart && (
                <Button variant="primary" size="lg" onClick={() => act('start')} disabled={busy || !equipmentDone}>{t('startWork')}</Button>
              )}
              {x.status === 'ASSIGNED' && !canStart && <span className="muted">{t('waitingLead')}</span>}
              {x.status === 'IN_PROGRESS' && canExecute && templates.map((ct) => {
                const doneRun = executions.some((e) => e.template_id === ct.id && e.submitted_at && e.result && e.result !== 'INCOMPLETE');
                return (
                  <Button key={ct.id} variant={doneRun ? 'outline' : 'primary'} size="lg" onClick={() => openChecklist(ct.id)} disabled={busy}>
                    {doneRun ? `${t('runChecklist')} (re-run)` : `${t('runChecklist')}: ${ct.name}`}
                  </Button>
                );
              })}
              {!done && x.status !== 'ASSIGNED' && !x.checklist_template_id && <span className="muted">{t('noData')}</span>}
            </StepBlock>
          )}

          {activeKey === 'location' && (
            <StepBlock done={locationDone} title={t('stepLocation')} hint={gps ? `${Number(gps.lat).toFixed(5)}, ${Number(gps.lng).toFixed(5)} · ±${gps.accuracy_m} m` : t('captureGps')}>
              <Button variant={locationDone ? 'outline' : 'primary'} size="lg" onClick={() => setSheet('gps')} disabled={busy}>
                <Navigation size={16} /> {t('useDeviceLocation')}
              </Button>
            </StepBlock>
          )}

          {activeKey === 'photos' && (
            <StepBlock done={photosDone} title={t('stepPhotos')} hint={`${attachments.length} ${t('photoEvidence').toLowerCase()}`}>
              <div className="flex flex-wrap gap-2">
                {canAttach && (
                  <Button variant={photosDone ? 'outline' : 'primary'} size="lg" onClick={() => setSheet('photo')} disabled={busy}>
                    <Camera size={16} /> {t('capturePhotoTitle')}
                  </Button>
                )}
                {!canAttach && <span className="muted">{t('noData')}</span>}
              </div>
              {attachments.length > 0 && (
                <ul className="muted mt-3 space-y-1 text-xs">
                  {attachments.slice(0, 6).map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <FileText size={13} /> <span className="truncate">{a.file_name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </StepBlock>
          )}

          {activeKey === 'handoff' && (
            <StepBlock done={done} title={t('stepHandoff')} hint={statusLabel(x.status)}>
              {x.status === 'IN_PROGRESS' && canLead && (
                <Button variant="primary" size="lg" onClick={() => act('submit')} disabled={busy}>{t('submitTask')}</Button>
              )}
              {x.status === 'IN_PROGRESS' && !canLead && <span className="muted">{t('waitingLead')}</span>}
              {x.status === 'ON_HOLD' && canLead && (
                <Button variant="primary" size="lg" onClick={() => act('resume')} disabled={busy}>{t('resumeTask')}</Button>
              )}
              {x.status === 'PENDING_VERIFICATION' && <span className="muted">{t('stPendingVerification')}</span>}
              {x.status === 'PENDING_VERIFICATION' && canLead && (
                <Button variant="outline" size="md" onClick={() => act('reopen')} disabled={busy}>{t('reopenTask')}</Button>
              )}
              {done && <span className="muted">{t('result')}: {x.result || statusLabel(x.status)}</span>}
              <Button variant={x.status === 'IN_PROGRESS' && canLead ? 'outline' : 'primary'} size="lg" onClick={onClose}>{t('done')}</Button>
            </StepBlock>
          )}
        </motion.div>
      </AnimatePresence>

      <ReadinessNotes taskId={taskId} />

      {executions.length > 0 && (
        <div className="muted mt-3 text-xs">
          {executions.map((e) => `${e.result || '—'} @ ${fmtDateTime(e.submitted_at)}`).join(' · ')}
        </div>
      )}

      {/* Thumb-reachable navigation footer. */}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
        <Button variant="ghost" size="md" onClick={() => move(-1)} disabled={activeIndex === 0 || busy}>
          <ChevronLeft size={16} /> {t('back')}
        </Button>
        <div className="flex items-center gap-1">
          {steps.map((s, i) => (
            <span key={s.key} className={cn('h-1.5 rounded-full transition-all', i === activeIndex ? 'w-5 bg-brand' : 'w-1.5 bg-slate-300 dark:bg-slate-700')} />
          ))}
        </div>
        <Button variant="ghost" size="md" onClick={() => move(1)} disabled={activeIndex === steps.length - 1 || busy}>
          {t('next')} <ChevronRight size={16} />
        </Button>
      </div>

      <CaptureSheets
        sheet={sheet}
        setSheet={setSheet}
        gps={gps}
        capture={capture}
        busy={busy}
        canAttach={canAttach}
        attachments={attachments}
        uploadFiles={uploadFiles}
        uploading={uploading}
      />
    </WorkPanelOverlay>
  );
}

function StepBlock({ done, title, hint, children }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <p className="muted truncate text-xs">{hint}</p>
        </div>
        <Badge tone={done ? 'success' : 'warn'}>{done ? <Check size={12} /> : t('status')}</Badge>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function CaptureSheets({ sheet, setSheet, gps, capture, busy, canAttach, attachments, uploadFiles, uploading }) {
  return (
    <>
      <Sheet open={sheet === 'gps'} onClose={() => setSheet(null)} title={t('captureLocationTitle')} description={t('stepLocation')} side="bottom">
        <div className="space-y-4">
          <div className="grid h-32 place-items-center rounded-2xl border border-dashed border-slate-300 text-slate-400 dark:border-slate-700">
            <div className="text-center">
              <MapPin size={28} className="mx-auto mb-1 text-brand" />
              <div className="text-xs">{t('captureGps')}</div>
            </div>
          </div>
          {gps && (
            <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800">
              <b>{Number(gps.lat).toFixed(5)}, {Number(gps.lng).toFixed(5)}</b>
              <div className="muted text-xs">{t('accuracy')} {gps.accuracy_m} m</div>
            </div>
          )}
          <Button variant="primary" size="lg" className="w-full" onClick={capture} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Navigation size={16} />} {t('useDeviceLocation')}
          </Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'photo'} onClose={() => setSheet(null)} title={t('capturePhotoTitle')} description={t('capturePhotoHint')} side="bottom">
        <div className="space-y-4">
          {canAttach && (
            <div className="space-y-3">
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 py-6 text-center transition-colors hover:border-brand hover:bg-emerald-50/40 dark:border-slate-700 dark:hover:bg-emerald-950/20">
                <Camera size={26} className="text-brand" />
                <span className="text-sm font-semibold">{t('capturePhotoTitle')}</span>
                <span className="muted text-xs">{t('capturePhotoHint')}</span>
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
              </label>
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 py-6 text-center transition-colors hover:border-brand hover:bg-emerald-50/40 dark:border-slate-700 dark:hover:bg-emerald-950/20">
                <Upload size={26} className="text-brand" />
                <span className="text-sm font-semibold">{t('uploadPhotos')}</span>
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
              </label>
            </div>
          )}
          {uploading && (
            <div className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <Loader2 size={14} className="animate-spin" /> {t('syncSaving')} {uploading}
            </div>
          )}
          {attachments.length > 0 && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-2 py-2 text-sm">
                  <FileText size={14} className="text-slate-400" />
                  <span className="truncate">{a.file_name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
    </>
  );
}
