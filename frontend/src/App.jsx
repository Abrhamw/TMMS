import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Outlet, Navigate, useNavigate, useLocation } from 'react-router-dom';
import Landing from './pages/Landing';
import Home from './pages/Home';
import Overview from './pages/Overview';
import MapPage from './pages/MapPage';
import Assets from './pages/Assets';
import Tasks from './pages/Tasks';
import TaskDetail from './pages/TaskDetail';
import ErrorBoundary from './components/ErrorBoundary';
import Crews from './pages/Crews';
import Schedules from './pages/Schedules';
import Checklists from './pages/Checklists';
import Gps from './pages/Gps';
import Certifications from './pages/Certifications';
import Reports from './pages/Reports';
import Infrastructure from './pages/Infrastructure';
import Value from './pages/Value';
import Mailbox from './pages/Mailbox';
import ExecutiveSummary from './pages/ExecutiveSummary';
import Settings from './pages/Settings';
import Organization from './pages/Organization';
import OperatingModel from './pages/OperatingModel';
import Login from './pages/Login';
import GlobalSearch from './components/GlobalSearch';
import { getStoredUser, getStoredToken, logout, can, CREW_ROLES } from './auth';
import { t, LOCALES, getLang, setLanguage, getLocale } from './i18n';
import { setApiLocale } from './api';
import './styles.css';

function useI18n() {
  const [lang, setLangState] = useState(getLang());
  useEffect(() => {
    setLanguage(lang);
    setApiLocale(getLocale());
  }, [lang]);
  return [lang, setLangState];
}

function LanguageSwitcher() {
  const lang = getLang();
  return (
    <select
      className="lang-select"
      value={lang}
      onChange={(e) => {
        setLanguage(e.target.value);
        setApiLocale(getLocale());
        window.location.reload();
      }}
      title={t('language')}
    >
      {Object.entries(LOCALES).map(([code, l]) => (
        <option key={code} value={code}>{l.label}</option>
      ))}
    </select>
  );
}

function UserMenu() {
  const nav = useNavigate();
  const user = getStoredUser();
  async function signOut() {
    await logout();
    nav('/login', { replace: true });
    window.location.reload();
  }
  return (
    <div className="user-menu">
      <span className="avatar">{user?.first_name?.[0] || user?.username?.[0] || '?'}</span>
      <span className="um-name">
        <b>{user?.first_name ? `${user.first_name} ${user.last_name || ''}` : user?.username}</b>
        <small>{user?.role} · {user?.region_id ? `Region #${user.region_id}` : t('allRegions')}</small>
      </span>
      <button className="btn btn-sm" onClick={signOut}>{t('signOut')}</button>
    </div>
  );
}

function Shell() {
  const [lang, setLang] = useI18n();
  const user = getStoredUser();
  const isCrew = !!user && CREW_ROLES.includes(user.role);
  const isExecutive = !!user && user.role === 'EXECUTIVE';
  const isAdmin = !!user && user.role === 'ADMIN';
  const navItems = useMemo(() => buildNav(isCrew, isExecutive, isAdmin), [lang, isCrew, isExecutive, isAdmin]);
  const location = useLocation();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo"><em>T</em></div>
          <div><h1>TMMS</h1><small>Transmission Asset Mgt</small></div>
        </div>
        {navItems.map((g) => (
          <div className="nav-group" key={g.group}>
            <div className="g-label">{t(g.group)}</div>
            {g.items.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.to === '/'} title={t(it.key)} aria-label={t(it.key)} className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                <span className="ico">{it.ico}</span><span>{t(it.key)}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </aside>
      <div className="main-col">
        <div className="shell-topbar">
          <GlobalSearch />
          <LanguageSwitcher />
          <UserMenu />
        </div>
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function buildNav(isCrew, isExecutive, isAdmin) {
  if (isCrew) {
    return [
      { group: 'overviewGroup', items: [
        { to: '/home', key: 'myDay', ico: '⌂' },
        { to: '/mailbox', key: 'mailbox', ico: '✉' },
        { to: '/map', key: 'map', ico: '⌖' },
        { to: '/model', key: 'systemMap', ico: '⌗' },
      ]},
    ];
  }
  if (isExecutive) {
    return [
      { group: 'overviewGroup', items: [
        { to: '/home', key: 'home', ico: '⌂' },
        { to: '/mailbox', key: 'mailbox', ico: '✉' },
        { to: '/overview', key: 'dashboard', ico: '◫' },
        { to: '/map', key: 'map', ico: '⌖' },
        { to: '/executive', key: 'executiveSummary', ico: '◷' },
        { to: '/value', key: 'valueCost', ico: '◔' },
        { to: '/reports', key: 'reports', ico: '▤' },
      ]},
    ];
  }
  const nav = [
    { group: 'overviewGroup', items: [
      { to: '/home', key: 'home', ico: '⌂' },
      { to: '/mailbox', key: 'mailbox', ico: '✉' },
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
    { group: 'governanceGroup', items: [
      { to: '/organization', key: 'organization', ico: '⛊' },
      { to: '/model', key: 'systemMap', ico: '⌗' },
    ]},
  ];
  if (isAdmin) nav.splice(4, 0, { group: 'managementGroup', items: [
    { to: '/value', key: 'valueCost', ico: '◔' },
  ]});
  if (isAdmin) nav[0].items.push({ to: '/executive', key: 'executiveSummary', ico: '◷' });
  return nav;
}

function RequireAuth({ children }) {
  const token = getStoredToken();
  const user = getStoredUser();
  const loc = useLocation();
  if (!token || !user) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return children;
}

function RequireExecutive({ children }) {
  const user = getStoredUser();
  if (!user || !['ADMIN', 'EXECUTIVE'].includes(user.role)) return <Navigate to="/home" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth><Shell /></RequireAuth>}>
          <Route path="/home" element={<Home />} />
          <Route path="/mailbox" element={<Mailbox />} />
          <Route path="/executive" element={<RequireExecutive><ExecutiveSummary /></RequireExecutive>} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/regions" element={<Navigate to="/infrastructure?manage=regions" replace />} />
          <Route path="/substations" element={<Navigate to="/infrastructure?manage=substations" replace />} />
          <Route path="/lines" element={<Navigate to="/infrastructure?manage=lines" replace />} />
          <Route path="/towers" element={<Navigate to="/infrastructure?manage=towers" replace />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/crews" element={<Crews />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/checklists" element={<Checklists />} />
          <Route path="/gps" element={<Gps />} />
          <Route path="/certifications" element={<Certifications />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/value" element={<RequireExecutive><Value /></RequireExecutive>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/organization" element={<Organization />} />
          <Route path="/model" element={<OperatingModel />} />
          <Route path="/infrastructure" element={<Infrastructure />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
