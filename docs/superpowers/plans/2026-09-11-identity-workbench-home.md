# Identity Workbench Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the persona-section Home with one identity-scoped workbench — a personal "Waiting on you" inbox, a two-tab History (Mine / In my area), and an inline work panel — for every role.

**Architecture:** A new `backend/homeFeed.js` holds the feed builders (scoping, ranking, primary-action) and `backend/routes/home.js` becomes a thin `GET /api/home` handler returning `{ name, role, persona, scope, inbox, history }`. The frontend rewrites `Home.jsx` around that payload, adds `TaskWorkPanel.jsx` which drives the existing task state/checklist endpoints, and branches `buildNav()` in `App.jsx` so crew roles get Home + Map and office roles keep the full sidebar.

**Tech Stack:** Express 5 + `node:sqlite` (`DatabaseSync`), React 18 + Vite, existing `api.js`, `auth.js`, task state machine in `backend/routes/tasks.js`.

## Global Constraints

- Never initialize, read, or write the real `backend/tmms.db`; every DB-touching check uses `TMMS_DB=/tmp/<name>.db`.
- Do not add frontend dependencies and do not add a test framework. Verify with `node --check`, plain `/tmp/*.js` scripts, scratch-server `curl`, and `npm run build`.
- Reuse the existing task state machine (`POST /tasks/:id/state`), checklist (`GET`/`POST /tasks/:id/checklist`), findings, and attachments endpoints. Do not add new execute endpoints.
- Permission checks mirror `backend/auth.js` `hasPerm` exactly; the panel's `primary_action` is only a suggestion and the API stays authoritative.
- `GET /api/home` must return `inbox` and `history` and must NOT return `sections`.
- Sort inbox: overdue first, then earliest `due_date`, then `CRITICAL > HIGH > MEDIUM > LOW`, then `id`. Cap inbox 25; cap each history tab 25; history window 30 days; history statuses only `COMPLETED`, `FAILED`, `CANCELLED`.
- Crew roles (`CREW_LEAD`, `CREW_MEMBER`, `FIELD_CREW`) nav = Home + Map only; office keeps the current sidebar.
- Never stage runtime files (`backend/tmms.db*`, `backend/uploads/`, `frontend/dist/`).
- Commits on `master`; commit only files changed by the task; do not push.

---

### Task 1: Backend feed module + `GET /api/home` rewrite

**Files:**
- Create: `backend/homeFeed.js`
- Modify: `backend/routes/home.js` (replace the whole file)
- Test: `/tmp/home-feed-check.js` (scratch, not committed)

**Interfaces:**
- Consumes: `backend/util.js` → `db` (unused directly), `list(table)`, `get(table, id)`; `backend/auth.js` → `isGlobal(user)`, `isCrewUser(user)`, `getUserCrew(user)`, `hasPerm(user, perm)`.
- Produces:
  - `personaFor(role)` → `'crew' | 'planner' | 'manager' | 'auditor' | 'executive' | 'viewer'`
  - `primaryAction(user, task)` → `'schedule' | 'assign' | 'start' | 'capture' | 'submit' | 'resume' | 'verify' | 'open'`
  - `sortItems(items)` → new array sorted by the Global Constraints rule
  - `buildHome(user)` → `{ name, role, persona, scope, inbox, history: { mine, area } }`
  - `module.exports = { personaFor, primaryAction, sortItems, buildHome }`

- [ ] **Step 1: Write the module `backend/homeFeed.js`**

```js
const { db, list, get } = require('./util');
const { isGlobal, isCrewUser, getUserCrew, hasPerm } = require('./auth');

const OPEN = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
const CLOSED = ['COMPLETED', 'FAILED', 'CANCELLED'];
const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const CAP = 25;
const HISTORY_DAYS = 30;
const CERT_DAYS = 90;

const CREW_MEMBER_STATUSES = ['ASSIGNED', 'IN_PROGRESS'];
const CREW_LEAD_STATUSES = ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];
const MANAGER_ROLES = [
  'REGION_DIRECTOR', 'REGION_MANAGER', 'SUBSTATION_MANAGER',
  'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER', 'SUPERVISOR',
];

function personaFor(role) {
  if (isCrewRoleString(role)) return 'crew';
  if (['PLANNER', 'DISPATCHER'].includes(role)) return 'planner';
  if (role === 'AUDITOR') return 'auditor';
  if (MANAGER_ROLES.includes(role)) return 'manager';
  if (role === 'VIEWER') return 'viewer';
  return 'executive';
}

function isCrewRoleString(role) {
  return ['CREW_LEAD', 'CREW_MEMBER', 'FIELD_CREW'].includes(role);
}

function has(user, perm) {
  return hasPerm(user, perm);
}

function canManage(user) { return has(user, 'task:manage'); }
function canAssign(user) { return has(user, 'task:assign'); }
function canStart(user) { return has(user, 'task:start'); }
function canLead(user) { return has(user, 'task:lead'); }

// The next legal step for this user. The API remains authoritative; this is a
// label + suggested action only. VIEWER is always read-only.
function primaryAction(user, t) {
  if (user.role === 'VIEWER') return 'open';
  switch (t.status) {
    case 'DRAFT':
      return canAssign(user) || canManage(user) ? 'schedule' : 'open';
    case 'SCHEDULED':
      return !t.crew_id && canAssign(user) ? 'assign' : 'open';
    case 'ASSIGNED':
      return canStart(user) || canManage(user) ? 'start' : 'open';
    case 'IN_PROGRESS':
      if (canLead(user) || canStart(user) || canManage(user)) return 'submit';
      return has(user, 'task:execute') ? 'capture' : 'open';
    case 'ON_HOLD':
      return canLead(user) || canStart(user) || canManage(user) ? 'resume' : 'open';
    case 'PENDING_VERIFICATION':
      return has(user, 'task:verify') ? 'verify' : 'open';
    default:
      return 'open';
  }
}

function whereLabel(t) {
  if (t.tower_id) { const tw = get('tower', t.tower_id); if (tw) return tw.tower_id; }
  if (t.asset_id) { const a = get('asset', t.asset_id); if (a) return a.name; }
  if (t.substation_id) { const s = get('substation', t.substation_id); if (s) return s.name; }
  if (t.line_id) { const l = get('transmission_line', t.line_id); if (l) return l.name; }
  return '—';
}

function crewOf(t) {
  if (!t.crew_id) return null;
  const c = get('crew', t.crew_id);
  return { id: t.crew_id, name: c ? c.name : null };
}

function isOverdue(t, now) {
  return !!t.due_date && t.due_date < now && OPEN.includes(t.status);
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const ad = a.due_date || '9999-12-31';
    const bd = b.due_date || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const pr = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (pr !== 0) return pr;
    return a.id - b.id;
  });
}

function reasonFor(user, t, now) {
  if (t.status === 'PENDING_VERIFICATION') return 'Needs verification';
  if (isOverdue(t, now)) return 'Overdue';
  if (t.status === 'SCHEDULED' && !t.crew_id) return 'No crew assigned';
  if (t.status === 'DRAFT') return 'Draft to finish';
  if (isCrewUser(user)) return 'Assigned to your crew';
  return 'Waiting on you';
}

function taskItem(user, t, now, { withReason = true, action = null } = {}) {
  return {
    kind: 'task',
    id: t.id,
    task_number: t.task_number,
    title: t.title,
    task_type: t.task_type,
    priority: t.priority,
    status: t.status,
    due_date: t.due_date,
    overdue: isOverdue(t, now),
    where: whereLabel(t),
    crew: crewOf(t),
    reason: withReason ? reasonFor(user, t, now) : null,
    primary_action: action || primaryAction(user, t),
  };
}

function regionScope(user, rows) {
  if (isGlobal(user)) return rows;
  return rows.filter((t) => t.region_id === user.region_id);
}

function failedGpsItems(user, now, limit) {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
  let rows = db.prepare(
    "SELECT * FROM gps_validation WHERE (result = 'FAIL' OR inside_geofence = 0 OR violation IS NOT NULL) AND validated_at >= ? ORDER BY validated_at DESC"
  ).all(cutoff);
  if (!isGlobal(user)) rows = rows.filter((v) => v.region_id === user.region_id);
  return rows.slice(0, limit).map((v) => ({
    kind: 'gps',
    id: v.id,
    title: `GPS ${v.result || 'REVIEW'} on ${v.target_type} #${v.target_id}`,
    status: v.result,
    due_date: v.validated_at,
    overdue: true,
    where: v.target_type,
    crew: null,
    reason: 'GPS failed',
    primary_action: 'open',
    href: '/gps',
  }));
}

function expiringCertItems(user, limit) {
  let certs = list('certification');
  if (!isGlobal(user)) {
    const people = new Set();
    for (const c of list('crew').filter((c) => c.region_id === user.region_id)) {
      people.add(c.leader_person_id);
      for (const m of db.prepare('SELECT person_id FROM crew_member WHERE crew_id = ?').all(c.id)) people.add(m.person_id);
    }
    certs = certs.filter((c) => people.has(c.person_id));
  }
  const horizon = new Date(Date.now() + CERT_DAYS * 864e5).toISOString();
  return certs.filter((c) => c.expires_at <= horizon).slice(0, limit).map((c) => {
    const expired = c.expires_at < new Date().toISOString();
    return {
      kind: 'cert',
      id: c.id,
      title: `${c.cert_type} — ${c.person_id ? `person #${c.person_id}` : 'crew'}`,
      status: expired ? 'EXPIRED' : 'EXPIRING',
      due_date: c.expires_at,
      overdue: expired,
      where: 'Certification',
      crew: null,
      reason: expired ? 'Cert expired' : 'Cert expiring',
      primary_action: 'open',
      href: '/certifications',
    };
  });
}

function inboxFor(user, now) {
  const items = [];
  const all = list('task');

  if (isCrewUser(user)) {
    const cid = user.crew_id || (getUserCrew(user) || {}).id || null;
    if (!cid) return [];
    const statuses = user.role === 'CREW_MEMBER' ? CREW_MEMBER_STATUSES : CREW_LEAD_STATUSES;
    all.filter((t) => t.crew_id === cid && statuses.includes(t.status))
      .forEach((t) => items.push(taskItem(user, t, now)));
    return sortItems(items).slice(0, CAP);
  }

  if (user.role === 'PLANNER') {
    regionScope(user, all).filter((t) => t.status === 'DRAFT' || (t.status === 'SCHEDULED' && !t.crew_id))
      .forEach((t) => items.push(taskItem(user, t, now)));
  } else if (user.role === 'DISPATCHER') {
    regionScope(user, all).filter((t) => (t.status === 'SCHEDULED' && !t.crew_id) || t.status === 'DRAFT')
      .forEach((t) => items.push(taskItem(user, t, now)));
  } else if (MANAGER_ROLES.includes(user.role)) {
    regionScope(user, all).filter((t) =>
      (OPEN.includes(t.status) && isOverdue(t, now)) ||
      t.status === 'PENDING_VERIFICATION' ||
      (t.status === 'SCHEDULED' && !t.crew_id)
    ).forEach((t) => items.push(taskItem(user, t, now)));
  } else if (user.role === 'AUDITOR') {
    all.filter((t) => t.status === 'PENDING_VERIFICATION').forEach((t) => items.push(taskItem(user, t, now)));
    items.push(...failedGpsItems(user, now, CAP));
  } else {
    // EXECUTIVE, ADMIN, VIEWER — exceptions only.
    all.filter((t) => t.priority === 'CRITICAL' && OPEN.includes(t.status) && isOverdue(t, now))
      .forEach((t) => items.push(taskItem(user, t, now)));
    items.push(...failedGpsItems(user, now, CAP));
    items.push(...expiringCertItems(user, CAP));
  }

  return sortItems(items).slice(0, CAP);
}

function isMineCrew(user, t) {
  const cid = user.crew_id || (getUserCrew(user) || {}).id || null;
  return !!cid && t.crew_id === cid;
}

function isMine(user, t) {
  if (isCrewUser(user) && isMineCrew(user, t)) return true;
  if (user.person_id && [t.created_by, t.assigned_by, t.verified_by].includes(user.person_id)) return true;
  if (user.person_id) {
    const n = db.prepare('SELECT COUNT(*) c FROM checklist_execution WHERE task_id = ? AND executed_by = ?').get(t.id, user.person_id).c;
    if (n > 0) return true;
  }
  return false;
}

function areaRows(user, rows) {
  if (isGlobal(user)) return rows;
  if (isCrewUser(user)) {
    const c = getUserCrew(user);
    const rid = (c && c.region_id) || user.region_id;
    return rows.filter((t) => t.region_id === rid);
  }
  return rows.filter((t) => t.region_id === user.region_id);
}

function historyFor(user, now) {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
  const closed = list('task')
    .filter((t) => CLOSED.includes(t.status))
    .filter((t) => (t.actual_end || t.updated_at || t.created_at || '') >= cutoff);
  const newestFirst = (a, b) => {
    const ad = a.actual_end || a.updated_at || a.created_at || '';
    const bd = b.actual_end || b.updated_at || b.created_at || '';
    if (ad !== bd) return ad < bd ? 1 : -1;
    return b.id - a.id;
  };
  const mine = closed.filter((t) => isMine(user, t)).sort(newestFirst).slice(0, CAP)
    .map((t) => taskItem(user, t, now, { withReason: false, action: 'open' }));
  const area = areaRows(user, closed).sort(newestFirst).slice(0, CAP)
    .map((t) => taskItem(user, t, now, { withReason: false, action: 'open' }));
  return { mine, area };
}

function personName(user) {
  if (!user) return '';
  const p = user.person_id ? get('person', user.person_id) : null;
  if (p) return `${p.first_name} ${p.last_name}`.trim();
  return user.username || '';
}

function scopeFor(user) {
  const crew = isCrewUser(user) ? getUserCrew(user) : null;
  const region = user.region_id ? get('region', user.region_id) : null;
  return {
    crew: crew ? { id: crew.id, name: crew.name } : null,
    region: region ? { id: region.id, name: region.name } : null,
    global: isGlobal(user),
  };
}

function buildHome(user) {
  const now = new Date().toISOString();
  return {
    name: personName(user),
    role: user.role,
    persona: personaFor(user.role),
    scope: scopeFor(user),
    inbox: inboxFor(user, now),
    history: historyFor(user, now),
  };
}

module.exports = { personaFor, primaryAction, sortItems, buildHome };
```

- [ ] **Step 2: Replace `backend/routes/home.js` with the thin handler**

```js
const express = require('express');
const { buildHome } = require('../homeFeed');

const router = express.Router();

router.get('/home', (req, res) => {
  res.json(buildHome(req.user));
});

module.exports = router;
```

- [ ] **Step 3: Syntax check**

Run: `node --check backend/homeFeed.js && node --check backend/routes/home.js`
Expected: no output, exit 0.

- [ ] **Step 4: Write the failing feed check `/tmp/home-feed-check.js`**

```js
const assert = require('assert');
process.env.TMMS_DB = '/tmp/tmms-home-check.db';

const { personaFor, primaryAction, sortItems } = require('/workspace/backend/homeFeed');

assert.strictEqual(personaFor('CREW_LEAD'), 'crew');
assert.strictEqual(personaFor('CREW_MEMBER'), 'crew');
assert.strictEqual(personaFor('FIELD_CREW'), 'crew');
assert.strictEqual(personaFor('PLANNER'), 'planner');
assert.strictEqual(personaFor('SUPERVISOR'), 'manager');
assert.strictEqual(personaFor('AUDITOR'), 'auditor');
assert.strictEqual(personaFor('EXECUTIVE'), 'executive');
assert.strictEqual(personaFor('VIEWER'), 'viewer');

const viewer = { role: 'VIEWER' };
assert.strictEqual(primaryAction(viewer, { status: 'PENDING_VERIFICATION' }), 'open');

const crewLead = { role: 'CREW_LEAD' };
assert.strictEqual(primaryAction(crewLead, { status: 'IN_PROGRESS' }), 'submit');

const crewMember = { role: 'CREW_MEMBER' };
assert.strictEqual(primaryAction(crewMember, { status: 'IN_PROGRESS' }), 'capture');
assert.strictEqual(primaryAction(crewMember, { status: 'ASSIGNED' }), 'open');

const mgr = { role: 'SUPERVISOR' };
assert.strictEqual(primaryAction(mgr, { status: 'PENDING_VERIFICATION' }), 'verify');

const sorted = sortItems([
  { id: 3, overdue: false, due_date: '2026-09-20', priority: 'LOW' },
  { id: 1, overdue: true, due_date: '2026-09-25', priority: 'LOW' },
  { id: 2, overdue: false, due_date: '2026-09-10', priority: 'CRITICAL' },
]);
assert.deepStrictEqual(sorted.map((x) => x.id), [1, 3, 2]);

console.log('home-feed-check OK');
```

- [ ] **Step 5: Run the check**

Run: `TMMS_DB=/tmp/tmms-home-check.db node /tmp/home-feed-check.js`
Expected: `home-feed-check OK`.

- [ ] **Step 6: Integration smoke on a scratch server**

Start a scratch server in the background (this seeds `/tmp/tmms-home-smoke.db` and never touches the real DB):

```bash
TMMS_DB=/tmp/tmms-home-smoke.db PORT=3025 node backend/server.js
```

Wait for `TMMS backend listening on http://localhost:3025`, then:

```bash
TOKEN=$(curl -s -X POST http://localhost:3025/api/auth/login -H 'Content-Type: application/json' -d '{"username":"crew.c1","password":"Crew@123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
curl -s http://localhost:3025/api/home -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('persona',j.persona,'sections' in j,'inbox',j.inbox.length,'mine',j.history.mine.length,'area',j.history.area.length)})"
```

Expected: `persona crew false inbox <n> mine <n> area <n>`.

Repeat the two commands for `mgr.c1.tlom` / `Manager@123` (expect `persona manager`) and `admin` / `Admin@123` (expect `persona executive`). Stop the scratch server by its background terminal id (never `pkill`).

- [ ] **Step 7: Commit**

```bash
git add backend/homeFeed.js backend/routes/home.js
git commit -m "feat(home): identity-scoped inbox and history feed"
```

---

### Task 2: Home workbench lists + crew/office nav

**Files:**
- Modify: `frontend/src/pages/Home.jsx` (replace the whole file)
- Modify: `frontend/src/App.jsx:75-106` (`Shell` + add `isCrewUser` import) and `frontend/src/App.jsx:108-138` (`buildNav`)
- Modify: `frontend/src/styles.css` (append workbench styles)
- Test: `npm run build`

**Interfaces:**
- Consumes: `GET /api/home` → `{ name, role, persona, scope, inbox[], history: { mine[], area[] } }` from Task 1; `frontend/src/auth.js` → `getStoredUser()`, `CREW_ROLES`; `frontend/src/api.js` → `api`, `fmtDate`.
- Produces: `Home` renders the two lists and calls `onOpen(item)`; rows navigate to `/tasks/:id` for `kind: 'task'` and to `item.href` otherwise. Task 3 replaces the task navigation with the panel.

- [ ] **Step 1: Replace `frontend/src/pages/Home.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Page, Pill, Loading, ErrorNote } from '../components';
import { getStoredUser } from '../auth';

const TITLE = 'My Workspace';
const CRUMBS = 'TMMS / Home';

export default function Home() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('mine');

  useEffect(() => {
    api.get('/home').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <Page title={TITLE} crumbs={CRUMBS}><ErrorNote error={error} /></Page>;
  if (!data) return <Page title={TITLE} crumbs={CRUMBS}><Loading /></Page>;

  const me = getStoredUser();
  const scopeLine = data.scope.crew
    ? `Crew: ${data.scope.crew.name}`
    : data.scope.global ? 'All regions' : (data.scope.region ? data.scope.region.name : '—');

  function open(item) {
    if (item.kind === 'task') nav(`/tasks/${item.id}`);
    else if (item.href) nav(item.href);
  }

  const historyRows = tab === 'mine' ? data.history.mine : data.history.area;

  return (
    <Page title={TITLE} crumbs={CRUMBS}>
      <div className="home-greeting">
        <div className="avatar lg">{me?.first_name?.[0] || me?.username?.[0] || '?'}</div>
        <div>
          <div className="home-hello">Welcome back, <b>{data.name || me?.username}</b></div>
          <div className="muted">{String(data.role).replace(/_/g, ' ')} · {scopeLine}</div>
        </div>
      </div>

      <h3 className="section-title">Waiting on you</h3>
      <TaskList rows={data.inbox} onOpen={open} empty="You're clear." />

      <div className="spread mt">
        <h3 className="section-title" style={{ marginBottom: 0 }}>History</h3>
        <div className="tabs">
          <button className={'tab' + (tab === 'mine' ? ' active' : '')} onClick={() => setTab('mine')}>Mine</button>
          <button className={'tab' + (tab === 'area' ? ' active' : '')} onClick={() => setTab('area')}>In my area</button>
        </div>
      </div>
      <TaskList rows={historyRows} onOpen={open} empty="No recent history." />
    </Page>
  );
}

function TaskList({ rows, onOpen, empty }) {
  if (!rows || rows.length === 0) return <div className="card card-pad muted">{empty}</div>;
  return (
    <div className="card">
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Task</th><th>Type</th><th>Priority</th><th>Status</th><th>Due</th><th>Where</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <tr key={`${it.kind}-${it.id}`} onClick={() => onOpen(it)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className="mono">{it.task_number || it.kind.toUpperCase()}</span><br />
                  <span>{it.title}</span>
                  {it.reason && <div className="muted" style={{ fontSize: 11 }}>{it.reason}</div>}
                </td>
                <td>{it.task_type || '—'}</td>
                <td>{it.priority || '—'}</td>
                <td><Pill value={it.status} /></td>
                <td className="nowrap">{it.overdue ? <b className="overdue">{fmtDate(it.due_date)}</b> : fmtDate(it.due_date)}</td>
                <td>{it.where}</td>
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
  return {
    schedule: 'Schedule', assign: 'Assign', start: 'Start', capture: 'Continue',
    submit: 'Submit', resume: 'Resume', verify: 'Verify', open: 'Open',
  }[it.primary_action] || 'Open';
}
```

- [ ] **Step 2: Branch the nav in `frontend/src/App.jsx`**

Add `CREW_ROLES` to the auth import on line 21:

```jsx
import { getStoredUser, getStoredToken, logout, can, CREW_ROLES } from './auth';
```

Replace the `const navItems = useMemo(() => buildNav(), [lang]);` line in `Shell` with:

```jsx
  const isCrew = !!user && CREW_ROLES.includes(user.role);
  const navItems = useMemo(() => buildNav(isCrew), [lang, isCrew]);
```

Replace the whole `buildNav` function (lines 108-138) with:

```jsx
function buildNav(isCrew) {
  if (isCrew) {
    return [
      { group: 'overviewGroup', items: [
        { to: '/home', key: 'home', ico: '⌂' },
        { to: '/map', key: 'map', ico: '⌖' },
      ]},
    ];
  }
  return [
    { group: 'overviewGroup', items: [
      { to: '/home', key: 'home', ico: '⌂' },
      { to: '/overview', key: 'dashboard', ico: '◫' },
      { to: '/map', key: 'map', ico: '⌖' },
    ]},
    { group: 'infrastructureGroup', items: [
      { to: '/infrastructure', key: 'infrastructure', ico: '▣' },
      { to: '/assets', key: 'assets', ico: '▤' },
    ]},
    { group: 'operationsGroup', items: [
      { to: '/tasks', key: 'tasks', ico: '☰' },
      { to: '/crews', key: 'crews', ico: '☺' },
      { to: '/schedules', key: 'schedules', ico: '⟲' },
      { to: '/checklists', key: 'checklists', ico: '☑' },
    ]},
    { group: 'complianceGroup', items: [
      { to: '/gps', key: 'gps', ico: '⌘' },
      { to: '/certifications', key: 'certifications', ico: '⊚' },
      { to: '/reports', key: 'reports', ico: '▤' },
      { to: '/settings', key: 'settings', ico: '⚙' },
    ]},
    { group: 'managementGroup', items: [
      { to: '/value', key: 'valueCost', ico: '◔' },
    ]},
    { group: 'governanceGroup', items: [
      { to: '/organization', key: 'organization', ico: '⛊' },
    ]},
  ];
}
```

- [ ] **Step 3: Append workbench styles to `frontend/src/styles.css`**

```css
/* Identity workbench home */
.tabs { display: flex; gap: 6px; margin-bottom: 8px; }
.tab { border: 1px solid var(--border); background: #fff; color: var(--text); border-radius: 8px; padding: 5px 12px; cursor: pointer; font: inherit; font-size: 13px; }
.tab.active { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
```

- [ ] **Step 4: Build**

Run: `npm run build` (in `frontend`)
Expected: exit 0, `dist/` written.

- [ ] **Step 5: Manual smoke**

With the scratch server from Task 1 Step 6 running on `:3025` (or the normal `:3001`/`:5173` dev pair), sign in as `crew.c1` and confirm the sidebar shows only Home and Map, the page shows Waiting on you plus History Mine / In my area, and a row opens `/tasks/:id`. Sign in as `admin` and confirm the full sidebar is back.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Home.jsx frontend/src/App.jsx frontend/src/styles.css
git commit -m "feat(home): workbench lists and role-split navigation"
```

---

### Task 3: Inline work panel

**Files:**
- Create: `frontend/src/components/TaskWorkPanel.jsx`
- Modify: `frontend/src/pages/Home.jsx` (open the panel for `kind: 'task'`, refresh after an action)
- Test: `npm run build` + manual smoke

**Interfaces:**
- Consumes: `GET /tasks/:id` (detail with `gps_validations`, `findings`, `attachments`, `executions`), `POST /tasks/:id/state`, `GET`/`POST /tasks/:id/checklist`, `POST /tasks/:id/findings`, `POST /tasks/:id/attachments`, `GET /crews`; `frontend/src/auth.js` `can`.
- Produces: `<TaskWorkPanel taskId readOnly onClose onChanged />`. `readOnly` hides every action (history rows). `onChanged()` refetches `GET /api/home`.

- [ ] **Step 1: Create `frontend/src/components/TaskWorkPanel.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '../api';
import { Pill, Loading, ErrorNote } from './index';
import { can, getStoredUser } from '../auth';

const GPS_TOLERANCE = 500;

export default function TaskWorkPanel({ taskId, readOnly = false, onClose, onChanged }) {
  const me = getStoredUser();
  const [task, setTask] = useState(null);
  const [crews, setCrews] = useState([]);
  const [error, setError] = useState(null);
  const [notif, setNotif] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [crewPick, setCrewPick] = useState('');
  const [verifyForm, setVerifyForm] = useState({ result: 'PASS', summary: '', cost: '' });

  const canAssign = !readOnly && can(me, 'task:assign');
  const canManage = !readOnly && can(me, 'task:manage');
  const canStart = !readOnly && (can(me, 'task:start') || can(me, 'task:manage'));
  const canLead = !readOnly && (can(me, 'task:lead') || can(me, 'task:manage'));
  const canExecute = !readOnly && can(me, 'task:execute');
  const canVerify = !readOnly && can(me, 'task:verify');
  const canAmend = !readOnly && can(me, 'task:amend');
  const canAttach = !readOnly && can(me, 'attachment:write');

  const load = () => api.get(`/tasks/${taskId}`).then((t) => { setTask(t); setCrewPick(t.crew_id || ''); }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    if (!readOnly) api.get('/crews').then(setCrews).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function act(action, extra) {
    try {
      await api.post(`/tasks/${taskId}/state`, { action, ...extra });
      setNotif(`Action "${action}" applied`);
      await load();
      if (onChanged) onChanged();
      setTimeout(() => setNotif(null), 2500);
    } catch (e) { setError(e.message); }
  }

  async function runChecklist() {
    try {
      const data = await api.get(`/tasks/${taskId}/checklist`);
      const items = {};
      data.template.items.forEach((it) => { items[it.id] = { value: null, comment: '' }; });
      setTpl(data.template);
      setChecklist(items);
    } catch (e) { setError(e.message); }
  }

  async function submitChecklist() {
    try {
      const items = Object.entries(checklist).map(([tid, v]) => ({ template_item_id: Number(tid), response_value: v.value, comment: v.comment }));
      const res = await api.post(`/tasks/${taskId}/checklist`, { items });
      setNotif(`Checklist submitted — result ${res.result}`);
      setChecklist(null); setTpl(null);
      await load();
      if (onChanged) onChanged();
      setTimeout(() => setNotif(null), 3000);
    } catch (e) { setError(e.message); }
  }

  async function saveFinding(f) {
    try { await api.post(`/tasks/${taskId}/findings`, f); await load(); if (onChanged) onChanged(); }
    catch (e) { setError(e.message); }
  }

  async function uploadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = String(reader.result || '').split(',')[1] || '';
        const isImg = String(file.type || '').startsWith('image/');
        await api.post(`/tasks/${taskId}/attachments`, { file_name: file.name, mime: file.type || 'application/octet-stream', kind: isImg ? 'PHOTO' : 'DOC', data, note: '' });
        await load();
      } catch (e) { setError(e.message); }
    };
    reader.readAsDataURL(file);
  }

  const t = task;
  const body = !t ? <Loading /> : (
    <>
      {notif && <div className="alert alert-success">{notif}</div>}
      {error && <ErrorNote error={error} />}

      <div className="kv">
        <span className="k">Status</span><span><Pill value={t.status} /></span>
        <span className="k">Type</span><span>{t.task_type}</span>
        <span className="k">Priority</span><span>{t.priority}</span>
        <span className="k">Due</span><span>{fmtDateTime(t.due_date)}</span>
        <span className="k">Region</span><span>{t.region?.name || '—'}</span>
        <span className="k">Crew</span><span>{t.crew?.name || '—'}</span>
        <span className="k">Checklist</span><span>{t.checklist_template?.name || '—'}</span>
        <span className="k">Result</span><span>{t.result || '—'}</span>
      </div>
      <p className="muted">{t.description || 'No description.'}</p>

      {!readOnly && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {t.status === 'DRAFT' && (canAssign || canManage) && <button className="btn btn-primary" onClick={() => act('schedule')}>Schedule task</button>}
          {t.status === 'SCHEDULED' && canAssign && (
            <div className="flex">
              <select value={crewPick} onChange={(e) => setCrewPick(e.target.value)}>
                <option value="">Choose crew…</option>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn btn-primary" disabled={!crewPick} onClick={() => act('assign', { crew_id: Number(crewPick) })}>Assign</button>
            </div>
          )}
          {t.status === 'ASSIGNED' && canStart && <button className="btn btn-primary" onClick={() => act('start')}>Start work</button>}
          {t.status === 'IN_PROGRESS' && (
            <>
              {t.checklist_template_id && canExecute && <button className="btn btn-primary" onClick={runChecklist}>Run checklist</button>}
              {canLead && <button className="btn btn-primary" onClick={() => act('submit')}>Submit for verification</button>}
              {canLead && <button className="btn" onClick={() => act('hold')}>Hold (blocked)</button>}
            </>
          )}
          {t.status === 'ON_HOLD' && canLead && <button className="btn btn-primary" onClick={() => act('resume')}>Resume work</button>}
          {t.status === 'PENDING_VERIFICATION' && canVerify && (
            <>
              <div className="field"><label>Result</label>
                <select value={verifyForm.result} onChange={(e) => setVerifyForm({ ...verifyForm, result: e.target.value })}>
                  <option>PASS</option><option>FAIL</option><option>PARTIAL</option><option>DEFERRED</option>
                </select>
              </div>
              <div className="field"><label>Completion summary</label><textarea value={verifyForm.summary} onChange={(e) => setVerifyForm({ ...verifyForm, summary: e.target.value })} /></div>
              <button className="btn btn-primary" onClick={() => act('verify', { result: verifyForm.result, completion_summary: verifyForm.summary, cost: verifyForm.cost === '' ? null : Number(verifyForm.cost) })}>Verify &amp; complete</button>
            </>
          )}
          {t.status === 'PENDING_VERIFICATION' && canLead && <button className="btn" onClick={() => act('reopen')}>Reopen (rework)</button>}
          {!['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status) && canManage && <button className="btn btn-danger" onClick={() => act('cancel', { reason: 'Cancelled by user' })}>Cancel task</button>}
        </div>
      )}

      {!readOnly && canAmend && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status) && (
        <button className="btn btn-sm btn-primary mt" onClick={() => saveFinding({ severity: 'MEDIUM', title: 'On-site finding', detail: '' })}>+ Quick finding</button>
      )}

      {!readOnly && canAttach && (
        <label className="btn btn-sm mt" style={{ cursor: 'pointer' }}>
          + Add photo / file
          <input type="file" style={{ display: 'none' }} onChange={(e) => { uploadFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      )}

      {(t.gps_validations || []).length > 0 && (
        <div className="box mt">
          {t.gps_validations.map((g, i) => (
            <div key={i} className="muted" style={{ fontSize: 12 }}>
              <b className={g.result === 'PASS' ? 'ok' : g.result === 'FAIL' ? 'bad' : 'warn'}>{g.result}</b>{' '}
              dist {Math.round(g.distance_m ?? 0)} m / tol {g.tolerance_m} m · {fmtDateTime(g.validated_at)}
            </div>
          ))}
        </div>
      )}

      {(t.executions || []).length > 0 && (
        <div className="muted mt" style={{ fontSize: 12 }}>
          Executions: {t.executions.map((e) => `${e.result || 'INCOMPLETE'} @ ${fmtDate(e.submitted_at)}`).join(' · ')}
        </div>
      )}
    </>
  );

  return (
    <div className={checklist === null ? 'work-panel' : 'work-panel work-panel--modal'}>
      <div className="work-panel-head">
        <div>
          <b>{t ? t.task_number : 'Task'} — {t ? t.title : ''}</b>
        </div>
        <div className="flex">
          <a className="btn btn-sm" href={`/tasks/${taskId}`}>Open full task</a>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>

      {checklist !== null ? (
        <div className="work-panel-checklist">
          <div className="spread"><b>Checklist</b><button className="btn btn-sm" onClick={() => { setChecklist(null); setTpl(null); }}>Cancel</button></div>
          {tpl.items.map((it) => (
            <div key={it.id} className="box mt">
              <b>{it.sequence}. {it.instruction}</b>
              <div className="mt">
                <ItemInput item={it} state={checklist[it.id]} setState={(s) => setChecklist({ ...checklist, [it.id]: s })} />
              </div>
            </div>
          ))}
          <button className="btn btn-primary mt" onClick={submitChecklist}>Submit execution</button>
        </div>
      ) : body}
    </div>
  );
}

function ItemInput({ item, state, setState }) {
  const set = (value) => setState({ ...state, value });
  if (item.response_type === 'PASS_FAIL' || item.response_type === 'YES_NO') {
    return (
      <select value={state.value ?? ''} onChange={(e) => set(e.target.value === 'true' ? true : e.target.value === 'false' ? false : null)}>
        <option value="">Select…</option><option value="true">Pass / Yes</option><option value="false">Fail / No</option>
      </select>
    );
  }
  if (item.response_type === 'NUMERIC') {
    return <input type="number" style={{ width: 180 }} value={state.value ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} placeholder="Enter value" />;
  }
  if (item.response_type === 'SELECT') {
    const opts = item.pass_criteria?.options || [];
    return (
      <select value={state.value ?? ''} onChange={(e) => set(e.target.value)}>
        <option value="">Select…</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (item.response_type === 'GPS_POINT') {
    let pos = null;
    try { pos = typeof state.value === 'string' ? JSON.parse(state.value) : state.value; } catch (_) { /* ignore */ }
    return (
      <div>
        <button className="btn btn-sm" onClick={() => {
          if (!navigator.geolocation) return;
          navigator.geolocation.getCurrentPosition((p) => {
            set(JSON.stringify({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy || 5) }));
          });
        }}>Capture location</button>
        {pos && <span className="muted" style={{ marginLeft: 8 }}>{Number(pos.lat).toFixed(5)}, {Number(pos.lng).toFixed(5)}</span>}
      </div>
    );
  }
  return <input value={state.value ?? ''} onChange={(e) => set(e.target.value)} />;
}
```

- [ ] **Step 2: Wire the panel into `frontend/src/pages/Home.jsx`**

Add the import:

```jsx
import TaskWorkPanel from '../components/TaskWorkPanel';
```

Change the state block to hold the open task:

```jsx
  const [openTask, setOpenTask] = useState(null);
```

Replace the `open(item)` function body with:

```jsx
  function open(item) {
    if (item.kind === 'task') setOpenTask(item.id);
    else if (item.href) nav(item.href);
  }

  function reload() {
    api.get('/home').then(setData).catch(() => {});
  }
```

Wrap the returned `<Page>` children so the panel renders beside the lists:

```jsx
  return (
    <Page title={TITLE} crumbs={CRUMBS}>
      <div className="workbench">
        <div className="workbench-main">
          {/* existing greeting + Waiting on you + History markup goes here unchanged */}
        </div>
        {openTask && (
          <TaskWorkPanel
            taskId={openTask}
            onClose={() => setOpenTask(null)}
            onChanged={reload}
          />
        )}
      </div>
    </Page>
  );
```

Move the existing greeting/`Waiting on you`/`History` JSX (from Task 2 Step 1) inside `<div className="workbench-main">`.

- [ ] **Step 3: Append panel styles to `frontend/src/styles.css`**

```css
.workbench { display: flex; gap: 16px; align-items: flex-start; }
.workbench-main { flex: 1; min-width: 0; }
.work-panel { width: 420px; max-width: 42vw; background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 14px; position: sticky; top: 12px; }
.work-panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
.work-panel--modal { position: fixed; inset: 4% 6%; width: auto; max-width: none; overflow: auto; z-index: 60; }
.work-panel-checklist { max-height: 70vh; overflow: auto; }
@media (max-width: 900px) {
  .workbench { flex-direction: column; }
  .work-panel { position: static; width: 100%; max-width: none; }
  .work-panel--modal { inset: 0; border-radius: 0; }
}
```

- [ ] **Step 4: Build**

Run: `npm run build` (in `frontend`)
Expected: exit 0.

- [ ] **Step 5: Manual smoke on the scratch server**

As `crew.c1` on the scratch server, open an assigned task from Waiting on you: the panel opens beside the lists, Start and Run checklist appear, and after submitting the checklist the row drops off Waiting on you (History Mine gains a row). Open a History row: the panel is read-only (no action buttons). As `mgr.c1.tlom`, a PENDING_VERIFICATION row offers Verify.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/TaskWorkPanel.jsx frontend/src/pages/Home.jsx frontend/src/styles.css
git commit -m "feat(home): inline task work panel"
```

---

## Self-Review

- **Spec coverage:** inbox per role (Task 1 `inboxFor`), history Mine/area (Task 1 `historyFor`), 25 cap + 30-day window + closed statuses (Task 1), work panel with state/checklist/findings/attachments/GPS evidence (Task 3), `primary_action` table (Task 1 `primaryAction`), `GET /api/home` shape (Task 1), crew vs office nav (Task 2), full Task Detail still linked (Task 3 panel header), Overview unchanged (untouched).
- **Placeholder scan:** no TBD/TODO; each step has concrete code or commands.
- **Type consistency:** `buildHome` return keys match `Home.jsx` reads (`scope.crew.name`, `history.mine`, `history.area`, `primary_action`, `href`); `TaskWorkPanel` props match the `Home.jsx` call site (`taskId`, `readOnly`, `onClose`, `onChanged`).
- **Deviations from spec to note:** history row click opens the read-only panel (spec 8.3) which is wired in Task 3; the GPS inline capture in the panel uses the browser geolocation and writes through the checklist `GPS_POINT` item, matching Task Detail's mechanism rather than a new endpoint.
