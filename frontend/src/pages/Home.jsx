import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, AlertTriangle, Clock, ChevronRight } from 'lucide-react';
import { api, fmtDate, fmtDateTime } from '../api';
import { Page, Pill, Loading, ErrorNote, SearchField, useSearchFilter } from '../components';
import { getStoredUser } from '../auth';
import { priorityLabel, statusLabel, taskTypeLabel } from '../labels';
import TaskWorkPanel from '../components/TaskWorkPanel';
import TaskRunner from '../components/TaskRunner';
import SyncStatus from '../components/SyncStatus';
import { cn } from '../ui/cn';
import { t } from '../i18n';

const CRUMBS = 'TMMS / Home';

export default function Home() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('mine');
  const [openTask, setOpenTask] = useState(null);
  const [activeBucket, setActiveBucket] = useState(null);
  const [details, setDetails] = useState({});
  const [groupBy, setGroupBy] = useState({});
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const loadingRef = useRef(new Set());

  useEffect(() => {
    api.get('/home').then(setData).catch((e) => setError(e.message));
  }, []);

  // Open the primary category (or the first that has work) by default, so the
  // page reads as a set of tabs with counts and one category panel below.
  useEffect(() => {
    if (!data || !data.buckets || activeBucket) return;
    const list = data.buckets || [];
    const preferred = list.find((b) => b.key === 'assigned' && b.count > 0)
      || list.find((b) => b.primary && b.count > 0)
      || list.find((b) => b.count > 0)
      || list[0];
    if (preferred) {
      setActiveBucket(preferred.key);
      loadBucketDetail(preferred.key);
    }
  }, [data]);

  if (error) return <Page title={t('home')} crumbs={CRUMBS}><ErrorNote error={error} /></Page>;
  if (!data) return <Page title={t('home')} crumbs={CRUMBS}><Loading /></Page>;

  const me = getStoredUser();
  const isCrew = data.persona === 'crew';

  function open(item, readOnly = false) {
    if (item.kind === 'task') setOpenTask({ id: item.id, readOnly, reason: item.reason });
    else if (item.href) nav(item.href);
  }

  // The full bucket (all rows, with grouping facets) is fetched the first time
  // a card is opened, so the count on the card and the sub-categories inside it
  // always come from the same set.
  function loadBucketDetail(key) {
    if (details[key] || loadingRef.current.has(key)) return;
    loadingRef.current.add(key);
    api.get(`/home/bucket/${key}`)
      .then((d) => setDetails((p) => ({ ...p, [key]: d })))
      .catch(() => {})
      .finally(() => loadingRef.current.delete(key));
  }

  function selectBucket(key) {
    setActiveBucket(key);
    loadBucketDetail(key);
  }

  function toggleGroup(gkey, next) {
    setCollapsedGroups((c) => ({ ...c, [gkey]: next }));
  }

  function reload() {
    api.get('/home').then(setData).catch(() => {});
  }

  if (isCrew) {
    return (
      <Page title={t('myDay')} crumbs={CRUMBS}>
        <div className="workbench">
          <div className="workbench-main">
            <CrewMyDay data={data} me={me} onOpen={open} />
          </div>
          {openTask && (
            <TaskRunner
              key={openTask.id}
              taskId={openTask.id}
              onClose={() => setOpenTask(null)}
              onChanged={reload}
            />
          )}
        </div>
      </Page>
    );
  }

  const scopeLine = data.scope.crew
    ? `Crew: ${data.scope.crew.name}`
    : data.scope.global ? 'All regions' : (data.scope.region ? data.scope.region.name : '—');
  const historyRows = tab === 'mine' ? data.history.mine : data.history.area;

  return (
    <Page title={t('home')} crumbs={CRUMBS}>
      <div className="workbench">
        <div className="workbench-main">
          <div className="home-greeting">
            <div className="avatar lg">{me?.first_name?.[0] || me?.username?.[0] || '?'}</div>
            <div>
              <div className="home-hello">{t('welcome')}, <b>{data.name || me?.username}</b></div>
              <div className="muted">{scopeLine}</div>
            </div>
          </div>

          {data.function && (
            <div className="card card-pad" style={{ marginBottom: 12 }}>
              <div className="spread" style={{ alignItems: 'center' }}>
                <div>
                  <b>{data.function.label}</b>
                  <div className="muted" style={{ fontSize: 12 }}>{data.function.band}</div>
                </div>
                <button className="btn btn-sm" onClick={() => nav('/model')}>{t('systemMap')}</button>
              </div>
            </div>
          )}

          {(data.buckets || []).length === 0 && (
            <>
              <h3 className="section-title">Waiting on you</h3>
              <TaskList rows={data.inbox} onOpen={(it) => open(it, false)} empty="You're clear." />
            </>
          )}

          {(data.buckets || []).length > 0 && (
            <>
              <div className="spread" style={{ alignItems: 'baseline', marginBottom: 10 }}>
                <h3 className="section-title" style={{ margin: 0 }}>Your work by category</h3>
                <span className="muted" style={{ fontSize: 12 }}>Pick a category tab</span>
              </div>
              <BucketTabs
                buckets={data.buckets || []}
                details={details}
                activeKey={activeBucket}
                onSelect={selectBucket}
                groupBy={groupBy}
                collapsedGroups={collapsedGroups}
                onToggleGroup={toggleGroup}
                onGroupBy={(key, dim) => setGroupBy((g) => ({ ...g, [key]: dim }))}
                onOpen={open}
                onRaise={() => nav('/tasks?task_type=EMERGENCY')}
                onViewAll={() => nav('/tasks')}
              />
            </>
          )}

          <div className="spread mt">
            <h3 className="section-title" style={{ marginBottom: 0 }}>History</h3>
            <div className="wb-tabs">
              <button className={'wb-tab' + (tab === 'mine' ? ' active' : '')} onClick={() => setTab('mine')}>Mine</button>
              <button className={'wb-tab' + (tab === 'area' ? ' active' : '')} onClick={() => setTab('area')}>In my area</button>
            </div>
          </div>
          <HistoryRows rows={historyRows} onOpen={(it) => open(it, true)} empty="No recent history." />
        </div>
        {openTask && (
          <TaskWorkPanel
            key={openTask.id}
            taskId={openTask.id}
            readOnly={openTask.readOnly}
            reason={openTask.reason}
            onClose={() => setOpenTask(null)}
            onChanged={reload}
          />
        )}
      </div>
    </Page>
  );
}

const ACTION_LABEL = () => ({
  start: t('startWork'),
  capture: t('continueWork'),
  submit: t('submitTask'),
  resume: t('resumeTask'),
  open: t('open'),
});

function CrewMyDay({ data, me, onOpen }) {
  const scope = data.scope.crew ? data.scope.crew.name : '';
  const actions = ACTION_LABEL();
  const { query, setQuery, results: inbox } = useSearchFilter(data.inbox);
  const openCount = data.inbox.length;
  const overdueCount = data.inbox.filter((it) => it.overdue).length;
  const historyCount = data.history.mine.length;

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3 rounded-2xl bg-gradient-to-br from-emerald-900 via-emerald-800 to-teal-800 p-4 text-white shadow-sm">
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-white/15 text-xl font-bold">
          {me?.first_name?.[0] || me?.username?.[0] || '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{t('welcome')}, {data.name || me?.username}</div>
          <div className="truncate text-xs text-emerald-100/90">{t('myDaySubtitle')}{scope ? ` · ${scope}` : ''}</div>
        </div>
        <SyncStatus />
      </header>

      <div className="grid grid-cols-3 gap-2">
        <StatChip icon={<ClipboardList size={15} />} label={t('openTasks')} value={openCount} />
        <StatChip icon={<AlertTriangle size={15} />} label={t('overdue')} value={overdueCount} danger={overdueCount > 0} />
        <StatChip icon={<Clock size={15} />} label={t('recentHistory')} value={historyCount} />
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('openTasks')}</h3>
          {openCount > 0 && <SearchField value={query} onChange={setQuery} placeholder={t('search')} />}
        </div>
        {openCount === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">{t('allDone')}</div>
        ) : inbox.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">{t('noMatches')}</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {inbox.map((it) => (
              <button
                key={it.id}
                onClick={() => onOpen(it)}
                className={cn(
                  'group flex min-h-[7.5rem] flex-col gap-2 rounded-2xl border bg-white p-4 text-left shadow-sm outline-none transition-transform hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-[0.99] dark:bg-slate-900',
                  it.overdue ? 'border-red-300 dark:border-red-900' : 'border-slate-200 dark:border-slate-800'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{it.task_number || `#${it.id}`}</span>
                  <Pill value={it.status} />
                </div>
                <div className="text-sm font-semibold leading-snug text-slate-900 dark:text-slate-50">{it.title}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{taskTypeLabel(it.task_type)} · {priorityLabel(it.priority)} · {it.where || '—'}</div>
                {it.reason && <div className="text-[11px] text-slate-500 dark:text-slate-400">{it.reason}</div>}
                <div className="mt-auto flex items-center justify-between gap-2">
                  <span className={cn('text-xs', it.overdue ? 'font-semibold text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>{t('due')}: {fmtDate(it.due_date)}</span>
                  <span className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white group-hover:bg-brand-light">
                    {actions[it.primary_action] || t('open')}<ChevronRight size={14} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">{t('recentHistory')}</h3>
        {historyCount === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">{t('noData')}</div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {data.history.mine.map((it) => (
              <button
                key={it.id}
                onClick={() => onOpen(it)}
                className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
              >
                <div className="min-w-0">
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{it.task_number || `#${it.id}`}</span>
                  <div className="truncate text-sm">{it.title}</div>
                </div>
                <div className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{fmtDateTime(it.due_date)}</div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatChip({ icon, label, value, danger }) {
  return (
    <div className={cn('rounded-2xl border bg-white p-3 dark:bg-slate-900', danger ? 'border-red-200 dark:border-red-900' : 'border-slate-200 dark:border-slate-800')}>
      <div className={cn('flex items-center gap-1 text-[11px] font-medium', danger ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
        {icon}<span className="truncate">{label}</span>
      </div>
      <div className={cn('mt-0.5 text-xl font-bold', danger ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-50')}>{value}</div>
    </div>
  );
}

function TaskList({ rows, onOpen, empty }) {
  const [query, setQuery] = useState('');
  const all = rows || [];
  const results = useSearchFilter(all, query);
  if (all.length === 0) return <div className="card card-pad muted">{empty}</div>;
  return (
    <div className="card">
      <div className="card-pad" style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 0 }}>
        <SearchField value={query} onChange={setQuery} placeholder={`${t('search')}…`} />
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Task</th><th>Type</th><th>Priority</th><th>Status</th><th>Due</th><th>Where</th><th>Crew</th><th></th></tr>
          </thead>
          <tbody>
            {results.length === 0 && <tr><td colSpan={8} className="search-empty">{t('noMatches')}</td></tr>}
            {results.map((it) => (
              <tr key={`${it.kind}-${it.id}`} onClick={() => onOpen(it)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className="mono">{it.task_number || it.kind.toUpperCase()}</span><br />
                  <span>{it.title}</span>
                  {it.reason && <div className="muted" style={{ fontSize: 11 }}>{it.reason}</div>}
                </td>
                <td>{it.task_type ? taskTypeLabel(it.task_type) : '—'}</td>
                <td>{it.priority ? priorityLabel(it.priority) : '—'}</td>
                <td><Pill value={it.status} /></td>
                <td className="nowrap">{it.overdue ? <b className="overdue">{fmtDate(it.due_date)}</b> : fmtDate(it.due_date)}</td>
                <td>{it.where}</td>
                <td>{typeof it.crew === 'string' ? it.crew : it.crew?.name || '—'}</td>
                <td><button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); onOpen(it); }}>{labelFor(it)}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function labelFor(it) {
  return ACTION_LABEL()[it.primary_action] || t('open');
}

// One accent per task bucket so the categories are visually distinct. The
// colour is passed down as a CSS variable to the card, icon chip and count.
const BUCKET_ACCENT = {
  execute: '#16a34a',
  schedule: '#4338ca',
  assign: '#0ea5e9',
  assigned: '#7c3aed',
  verify: '#0d9488',
  emergency: '#dc2626',
  audit: '#64748b',
  oversight: '#d97706',
};

// Sub-categories a bucket can be split by. Status and task type are workflow
// codes translated in the UI; substation, line and asset category are names
// resolved by the API and carried on each item's `facets`.
const GROUP_DIMS = ['status', 'task_type', 'substation', 'line', 'asset'];
const GROUP_LABELS = {
  status: 'byStatus',
  task_type: 'byType',
  substation: 'bySubstation',
  line: 'byLine',
  asset: 'byAsset',
};

function facetOf(item, dim) {
  const f = item.facets || {};
  if (dim === 'status') return { key: f.status || '_none', label: statusLabel(f.status) };
  if (dim === 'task_type') return { key: f.task_type || '_none', label: taskTypeLabel(f.task_type) };
  const v = f[dim];
  return v ? { key: String(v.key), label: v.label } : { key: '_none', label: t('ungrouped') };
}

function groupItems(items, dim) {
  const map = new Map();
  for (const it of (items || [])) {
    const g = facetOf(it, dim);
    if (!map.has(g.key)) map.set(g.key, { key: g.key, label: g.label, items: [] });
    map.get(g.key).items.push(it);
  }
  // Insertion order keeps the most urgent sub-category first.
  return [...map.values()];
}

// Only offer dimensions that actually split the bucket; status and type stay
// available even when a bucket happens to hold a single value.
function availableDims(items) {
  const dims = GROUP_DIMS.filter((d) => {
    if (d === 'status' || d === 'task_type') return true;
    return new Set((items || []).map((it) => facetOf(it, d).key)).size > 1;
  });
  return dims.length ? dims : ['status'];
}

function BucketTabs({ buckets, details, activeKey, onSelect, groupBy, collapsedGroups, onToggleGroup, onGroupBy, onOpen, onRaise, onViewAll }) {
  const active = buckets.find((b) => b.key === activeKey) || buckets[0];
  if (!active) return null;
  return (
    <div className="bucket-tabs-wrap" style={{ '--bucket-accent': BUCKET_ACCENT[active.key] || 'var(--primary)' }}>
      <div className="bucket-tabs" role="tablist" aria-label="Work categories">
        {buckets.map((b) => {
          const selected = b.key === active.key;
          return (
            <button
              key={b.key}
              type="button"
              role="tab"
              aria-selected={selected}
              className={'bucket-tab' + (selected ? ' active' : '')}
              style={{ '--bucket-accent': BUCKET_ACCENT[b.key] || 'var(--primary)' }}
              onClick={() => onSelect(b.key)}
            >
              <span className="bucket-tab-ico"><BucketIcon name={b.key} /></span>
              <span className="bucket-tab-label">{b.label}</span>
              <span className={'bucket-count' + (b.count ? ' hot' : ' zero')}>{b.count}</span>
            </button>
          );
        })}
      </div>
      <BucketPanel
        key={active.key}
        bucket={active}
        detail={details[active.key]}
        groupBy={groupBy[active.key] || 'status'}
        collapsedGroups={collapsedGroups}
        onToggleGroup={onToggleGroup}
        onGroupBy={(dim) => onGroupBy(active.key, dim)}
        onOpen={onOpen}
        onRaise={onRaise}
        onViewAll={onViewAll}
      />
    </div>
  );
}

// The active category: one panel with a search box, the sub-category grouping
// toolbar and the tasks themselves. Remounted per category (key) so the search
// resets when the user switches tabs.
function BucketPanel({ bucket, detail, groupBy, collapsedGroups, onToggleGroup, onGroupBy, onOpen, onRaise, onViewAll }) {
  const items = (detail || bucket).items || [];
  const total = detail ? detail.count : bucket.count;
  const extra = total - items.length;
  const dims = availableDims(items);
  const activeDim = dims.includes(groupBy) ? groupBy : dims[0];
  const { query, setQuery, results } = useSearchFilter(items);
  return (
    <div className="bucket-panel">
      <div className="bucket-panel-head">
        <span className="bucket-ico"><BucketIcon name={bucket.key} /></span>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div className="bucket-title-row">
            <span className="bucket-title">{bucket.label}</span>
            {bucket.primary && <span className="bucket-tag">Primary</span>}
            {bucket.readOnly && <span className="bucket-tag ghost">Read-only</span>}
          </div>
          <span className="bucket-hint">{bucket.hint}</span>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder={t('search')} />
        {bucket.canCreate && (
          <button className="btn btn-sm btn-primary" onClick={onRaise}>+ {t('raiseEmergency')}</button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="muted bucket-empty">{t('allDone')}</div>
      ) : (
        <>
          {detail && dims.length > 1 && (
            <div className="bucket-toolbar">
              <span className="muted bucket-toolbar-label">{t('groupBy')}</span>
              {dims.map((d) => (
                <button key={d} className={'bucket-chip' + (d === activeDim ? ' active' : '')} onClick={() => onGroupBy(d)}>
                  {t(GROUP_LABELS[d])}
                </button>
              ))}
            </div>
          )}
          {query && results.length === 0 ? (
            <div className="search-empty">{t('noMatches')}</div>
          ) : detail ? (
            <BucketGroups
              prefix={bucket.key}
              items={results}
              dim={activeDim}
              collapsedGroups={collapsedGroups}
              onToggleGroup={onToggleGroup}
              onOpen={onOpen}
              readOnly={bucket.readOnly}
            />
          ) : (
            <div className="bucket-tasks">
              {results.map((it) => (
                <BucketTask key={`${it.kind}-${it.id}`} item={it} onOpen={() => onOpen(it, bucket.readOnly)} />
              ))}
            </div>
          )}
          {extra > 0 && (
            <button className="link" style={{ marginTop: 10, background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer' }} onClick={onViewAll}>
              View all {total} tasks
            </button>
          )}
        </>
      )}
    </div>
  );
}

// The sub-categories of one bucket. Each one is a collapsible heading with its
// own count, holding the task cards that fall into it.
function BucketGroups({ prefix, items, dim, collapsedGroups, onToggleGroup, onOpen, readOnly }) {
  const groups = groupItems(items, dim);
  return (
    <div className="bucket-groups">
      {groups.map((g, idx) => {
        const gkey = `${prefix}:${dim}:${g.key}`;
        const collapsed = collapsedGroups[gkey] === undefined ? idx !== 0 : collapsedGroups[gkey];
        return (
          <div className={'bucket-group' + (collapsed ? ' collapsed' : '')} key={g.key}>
            <button className="bucket-group-head" onClick={() => onToggleGroup(gkey, !collapsed)} aria-expanded={!collapsed}>
              <span className="bucket-group-title">{g.label}</span>
              <span className="bucket-group-count">{g.items.length}</span>
              <span className="bucket-chevron">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s ease' }}>
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </button>
            {!collapsed && (
              <div className="bucket-tasks">
                {g.items.map((it) => (
                  <BucketTask key={`${it.kind}-${it.id}`} item={it} onOpen={() => onOpen(it, readOnly)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BucketTask({ item, onOpen }) {
  return (
    <button className="bucket-task" onClick={onOpen}>
      <span className="spread">
        <span className="mono muted" style={{ fontSize: 11 }}>{item.task_number || `#${item.id}`}</span>
        <Pill value={item.status} />
      </span>
      <span className="bucket-task-title">{item.title}</span>
      <span className="bucket-task-meta">
        {[taskTypeLabel(item.task_type), priorityLabel(item.priority), item.where].filter(Boolean).join(' · ')}
      </span>
      {item.reason && <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>{item.reason}</span>}
      <span className="spread">
        <span className={item.overdue ? 'overdue' : 'muted'} style={{ fontSize: 12 }}>{fmtDate(item.due_date)}</span>
        <span className="btn btn-sm btn-primary">{labelFor(item)}</span>
      </span>
    </button>
  );
}

function BucketIcon({ name }) {
  const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'execute':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M10 8.5l6 3.5-6 3.5z" /></svg>;
    case 'schedule':
      return <svg {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></svg>;
    case 'assign':
      return <svg {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>;
    case 'assigned':
      return <svg {...p}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 14l2 2 4-4" /></svg>;
    case 'verify':
      return <svg {...p}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>;
    case 'emergency':
      return <svg {...p}><path d="M12 3l9 16H3z" /><path d="M12 9v5M12 17h.01" /></svg>;
    case 'audit':
      return <svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'oversight':
      return <svg {...p}><path d="M3 12h4l3 7 4-14 3 7h4" /></svg>;
    default:
      return <svg {...p}><circle cx="12" cy="12" r="8" /></svg>;
  }
}

// History as compact rows (a task title is a link, not a table row). The search
// box filters both history scopes instantly.
function HistoryRows({ rows, onOpen, empty }) {
  const { query, setQuery, results } = useSearchFilter(rows);
  if (!rows || rows.length === 0) return <div className="card card-pad muted">{empty}</div>;
  return (
    <div className="card">
      <div className="filters" style={{ margin: 0, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <SearchField value={query} onChange={setQuery} placeholder={t('search')} />
        <span className="muted" style={{ fontSize: 12 }}>{results.length} of {rows.length}</span>
      </div>
      {results.length === 0 ? (
        <div className="search-empty">{t('noMatches')}</div>
      ) : results.map((it) => (
        <div key={`${it.kind}-${it.id}`} className="myday-row" onClick={() => onOpen(it)}>
          <div style={{ minWidth: 0 }}>
            <span className="mono muted" style={{ fontSize: 11 }}>{it.task_number || it.kind.toUpperCase()}</span>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</div>
          </div>
          <div className="actions nowrap">
            {it.status && <Pill value={it.status} />}
            <span className="muted" style={{ fontSize: 12 }}>{fmtDate(it.due_date)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
