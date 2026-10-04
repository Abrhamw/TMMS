import { SearchSelect } from './components';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Outlet, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Moon, Sun, Home as HomeIcon, Mail, LayoutDashboard, Boxes, Wrench, Map as MapIcon, Settings as SettingsIcon, Gauge, ClipboardList, Search as SearchIcon, Menu, PanelLeftClose, PanelLeftOpen, X, MoreHorizontal } from 'lucide-react';
import { useTheme } from './theme';
import { CommandPalette } from './ui/Command';
import { Tooltip } from './ui/Tooltip';
import { HeaderSlotProvider } from './components/PageHeader';
import Landing from './pages/Landing';
import Home from './pages/Home';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';
import GlobalSearch from './components/GlobalSearch';
import { getStoredUser, getStoredToken, logout, can, CREW_ROLES, listOtherAccounts, switchAccount, removeAccount } from './auth';
import { t, LOCALES, getLang, setLanguage, getLocale } from './i18n';
import { api, setApiLocale } from './api';
import './styles.css';

// Heavier surfaces (Leaflet map pages, registers, report views) load on demand
// so a first visit only downloads the shell plus the page actually opened.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const AssetsHub = lazy(() => import('./pages/AssetsHub'));
const WorkHub = lazy(() => import('./pages/WorkHub'));
const AdminHub = lazy(() => import('./pages/AdminHub'));
const MapPage = lazy(() => import('./pages/MapPage'));
const Tasks = lazy(() => import('./pages/Tasks'));
const TaskDetail = lazy(() => import('./pages/TaskDetail'));
const Crews = lazy(() => import('./pages/Crews'));
const Schedules = lazy(() => import('./pages/Schedules'));
const Checklists = lazy(() => import('./pages/Checklists'));
const Gps = lazy(() => import('./pages/Gps'));
const Certifications = lazy(() => import('./pages/Certifications'));
const Reports = lazy(() => import('./pages/Reports'));
const Infrastructure = lazy(() => import('./pages/Infrastructure'));
const Value = lazy(() => import('./pages/Value'));
const Mailbox = lazy(() => import('./pages/Mailbox'));
const ExecutiveSummary = lazy(() => import('./pages/ExecutiveSummary'));
const Settings = lazy(() => import('./pages/Settings'));
const Organization = lazy(() => import('./pages/Organization'));
const OperatingModel = lazy(() => import('./pages/OperatingModel'));

function RouteFallback() {
  return <div className="empty" role="status" aria-live="polite">{t('loading')}</div>;
}

function Suspend({ children }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

// The signed-in person's job title when present, otherwise their role. Used in
// the top bar so the header reflects the person, not just the access level.
function personTitle(user) {
  if (!user) return '';
  const title = (user.title || '').trim();
  if (title && title.toLowerCase() !== String(user.role || '').toLowerCase()) return title;
  return String(user.role || '').replace(/_/g, ' ');
}

function useI18n() {
  const [lang, setLangState] = useState(getLang());
  useEffect(() => {
    setLanguage(lang);
    setApiLocale(getLocale());
  }, [lang]);
  return [lang, setLangState];
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" className="theme-toggle" onClick={toggle} title={theme === 'dark' ? 'Light mode' : 'Dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
      {theme === 'dark' ? <Sun size={17} strokeWidth={1.9} /> : <Moon size={17} strokeWidth={1.9} />}
    </button>
  );
}

function LanguageSwitcher() {
  const lang = getLang();
  return (
    <SearchSelect
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
    </SearchSelect>
  );
}

// A compact inbox chip in the shell top bar: live unread count next to the user
// account, polling the lightweight mailbox summary so the badge stays current
// without loading the whole mailbox.
function InboxChip() {
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/mailbox/summary')
      .then((s) => { if (alive) setUnread(s.unread_count || 0); })
      .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, []);
  return (
    <button type="button" className="inbox-chip" onClick={() => nav('/mailbox')} title={t('mailbox')} aria-label={t('mailbox')}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" />
      </svg>
      {unread > 0 && <span className="inbox-chip-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

function UserMenu() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const user = getStoredUser();
  const [others, setOthers] = useState(() => listOtherAccounts());

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!e.target.closest('.user-menu')) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const displayName = user?.first_name ? `${user.first_name} ${user.last_name || ''}`.trim() : user?.username;
  const initial = user?.first_name?.[0] || user?.username?.[0] || '?';

  async function signOut() {
    await logout();
    nav('/login', { replace: true });
    window.location.reload();
  }

  async function doSwitch(token) {
    setBusy(true);
    await switchAccount(token);
    window.location.reload();
  }

  function doRemove(userId, e) {
    e.stopPropagation();
    removeAccount(userId);
    setOthers(listOtherAccounts());
  }

  return (
    <div className="user-menu">
      <button type="button" className="um-trigger" aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOthers(listOtherAccounts()); setOpen((v) => !v); }}>
        <span className="avatar">{initial}</span>
        <span className="um-name">
          <b>{displayName}</b>
          <small>{personTitle(user) || user?.role} · {user?.region_id ? `Region #${user.region_id}` : t('allRegions')}</small>
        </span>
      </button>
      {open && (
        <div className="um-dropdown" role="menu">
          <div className="um-item um-current">
            <span className="avatar">{initial}</span>
            <span className="um-name"><b>{displayName}</b><small>{personTitle(user) || user?.role}</small></span>
            <span className="um-tag">{t('signedIn')}</span>
          </div>
          {others.map((a) => {
            const nm = a.user.first_name ? `${a.user.first_name} ${a.user.last_name || ''}`.trim() : a.user.username;
            return (
              <button key={a.user.id} type="button" className="um-item" role="menuitem" disabled={busy} onClick={() => doSwitch(a.token)}>
                <span className="avatar">{a.user.first_name?.[0] || a.user.username?.[0] || '?'}</span>
                <span className="um-name"><b>{nm}</b><small>{personTitle(a.user) || a.user.role}</small></span>
                <span className="um-remove" role="button" tabIndex={0} title={t('removeAccount')} aria-label={t('removeAccount')}
                  onClick={(e) => doRemove(a.user.id, e)}>×</span>
              </button>
            );
          })}
          <div className="um-sep" />
          <button type="button" className="um-item um-add" role="menuitem" onClick={() => { setOpen(false); nav('/login', { state: { addAccount: true } }); }}>
            + {t('addAccount')}
          </button>
          <button type="button" className="um-item" role="menuitem"
            onClick={() => { setOpen(false); window.open(`${window.location.origin}/login?add=1`, '_blank', 'noopener,noreferrer'); }}>
            {t('secondTab')}
          </button>
          <button type="button" className="um-item" role="menuitem" onClick={signOut}>{t('signOut')}</button>
        </div>
      )}
    </div>
  );
}

function NavGroups({ navItems, onNavigate }) {
  return (
    <>
      {navItems.map((g) => (
        <div className="nav-group" key={g.group}>
          <div className="g-label">{t(g.group)}</div>
          {g.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.to === '/'}
              title={t(it.key)}
              aria-label={t(it.key)}
              onClick={onNavigate}
              className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
            >
              <span className="ico">{it.icon}</span><span className="nav-text">{t(it.key)}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </>
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
  const navigate = useNavigate();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [headerSlot, setHeaderSlot] = useState(null);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem('tmms_rail') === 'collapsed'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem('tmms_rail', railCollapsed ? 'collapsed' : 'expanded'); } catch { /* storage unavailable */ }
  }, [railCollapsed]);

  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    document.body.classList.add('nav-drawer-open');
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.classList.remove('nav-drawer-open'); window.removeEventListener('keydown', onKey); };
  }, [navOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useMemo(
    () => navItems.flatMap((g) => g.items.map((it) => ({ label: t(it.key), sub: t(g.group), run: () => navigate(it.to) }))),
    [navItems, navigate]
  );

  const flatNav = useMemo(() => navItems.flatMap((g) => g.items), [navItems]);
  const bottomItems = flatNav.slice(0, 4);
  const hasMore = flatNav.length > bottomItems.length;

  return (
    <div className={'app-shell' + (railCollapsed ? ' rail-collapsed' : '')}>
      <aside className="sidebar">
        <div className="brand">
          <div className="logo"><em>T</em></div>
          <div className="brand-text"><h1>TMMS</h1><small>Transmission Asset Mgt</small></div>
        </div>
        <button type="button" className="rail-toggle" onClick={() => setRailCollapsed((v) => !v)}
          title={railCollapsed ? t('expandNav') : t('collapseNav')}
          aria-label={railCollapsed ? t('expandNav') : t('collapseNav')}>
          {railCollapsed ? <PanelLeftOpen {...ICON} /> : <PanelLeftClose {...ICON} />}
        </button>
        <nav className="nav-scroll" aria-label="Main navigation">
          <NavGroups navItems={navItems} />
        </nav>
      </aside>
      <HeaderSlotProvider slot={headerSlot}>
        <div className="main-col">
          <div className="shell-topbar">
            <button type="button" className="mobile-menu-btn" onClick={() => setNavOpen(true)} aria-label={t('openNav')} title={t('openNav')}>
              <Menu {...ICON} />
            </button>
            {!isExecutive && <GlobalSearch />}
            <Tooltip label="Search · Ctrl K">
              <button type="button" className="theme-toggle" onClick={() => setCmdOpen(true)} aria-label="Open command palette">
                <SearchIcon size={17} strokeWidth={1.9} />
              </button>
            </Tooltip>
            <ThemeToggle />
            <LanguageSwitcher />
            <InboxChip />
            <UserMenu />
          </div>
          <div className="shell-page-header-slot" ref={setHeaderSlot} />
          <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} commands={commands} searchable={!isExecutive} />
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </HeaderSlotProvider>

      <div className={'nav-drawer-scrim' + (navOpen ? ' open' : '')} onClick={() => setNavOpen(false)} />
      <aside className={'nav-drawer' + (navOpen ? ' open' : '')} role="dialog" aria-modal="true" aria-label="Navigation" aria-hidden={!navOpen}>
        <div className="nav-drawer-head">
          <div className="brand">
            <div className="logo"><em>T</em></div>
            <div className="brand-text"><h1>TMMS</h1><small>Transmission Asset Mgt</small></div>
          </div>
          <button type="button" className="nav-drawer-close" onClick={() => setNavOpen(false)} aria-label={t('closeNav')}>
            <X {...ICON} />
          </button>
        </div>
        <nav className="nav-scroll" aria-label="Main navigation">
          <NavGroups navItems={navItems} onNavigate={() => setNavOpen(false)} />
        </nav>
      </aside>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {bottomItems.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to === '/'} title={t(it.key)} aria-label={t(it.key)}
            className={({ isActive }) => 'mobile-nav-link' + (isActive ? ' active' : '')}>
            <span className="ico">{it.icon}</span><span className="mobile-nav-text">{t(it.key)}</span>
          </NavLink>
        ))}
        {hasMore && (
          <button type="button" className="mobile-nav-link" onClick={() => setNavOpen(true)} aria-label={t('more')} title={t('more')}>
            <span className="ico"><MoreHorizontal {...ICON} /></span><span className="mobile-nav-text">{t('more')}</span>
          </button>
        )}
      </nav>
    </div>
  );
}

const ICON = { size: 17, strokeWidth: 1.9 };

function navIcon(type) {
  if (type === 'mailbox') return <Mail {...ICON} />;
  if (type === 'myDay') return <ClipboardList {...ICON} />;
  if (type === 'dashboard') return <LayoutDashboard {...ICON} />;
  if (type === 'assets') return <Boxes {...ICON} />;
  if (type === 'work') return <Wrench {...ICON} />;
  if (type === 'map') return <MapIcon {...ICON} />;
  if (type === 'admin') return <SettingsIcon {...ICON} />;
  if (type === 'executiveSummary') return <Gauge {...ICON} />;
  return <HomeIcon {...ICON} />;
}

function buildNav(isCrew, isExecutive, isAdmin) {
  if (isExecutive) {
    return [
      { group: 'overviewGroup', items: [
        { to: '/home', key: 'home', icon: navIcon('home') },
        { to: '/mailbox', key: 'mailbox', icon: navIcon('mailbox') },
      ]},
      { group: 'workspaceGroup', items: [
        { to: '/dashboard', key: 'dashboard', icon: navIcon('dashboard') },
        { to: '/map', key: 'map', icon: navIcon('map') },
      ]},
      { group: 'managementGroup', items: [
        { to: '/executive', key: 'executiveSummary', icon: navIcon('executiveSummary') },
      ]},
    ];
  }
  const nav = [
    { group: 'overviewGroup', items: [
      { to: '/home', key: isCrew ? 'myDay' : 'home', icon: navIcon(isCrew ? 'myDay' : 'home') },
      { to: '/mailbox', key: 'mailbox', icon: navIcon('mailbox') },
    ]},
    { group: 'workspaceGroup', items: [
      { to: '/dashboard', key: 'dashboard', icon: navIcon('dashboard') },
      { to: '/assets', key: 'assets', icon: navIcon('assets') },
      { to: '/work', key: 'work', icon: navIcon('work') },
      { to: '/map', key: 'map', icon: navIcon('map') },
    ]},
  ];
  if (isAdmin) {
    nav.push({ group: 'managementGroup', items: [
      { to: '/admin', key: 'admin', icon: navIcon('admin') },
      { to: '/executive', key: 'executiveSummary', icon: navIcon('executiveSummary') },
    ]});
  }
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

function RequireAdmin({ children }) {
  const user = getStoredUser();
  if (!user || user.role !== 'ADMIN') {
    return <Navigate to={user?.role === 'EXECUTIVE' ? '/executive' : '/home'} replace />;
  }
  return children;
}

// Executives get a briefing surface (Executive Summary, Dashboard, Map) and are
// redirected away from the operational registers and work pages that directors,
// managers, and crews use.
function BlockExecutive({ children }) {
  const user = getStoredUser();
  if (user?.role === 'EXECUTIVE') return <Navigate to="/executive" replace />;
  return children;
}

// Reports are a management/oversight surface. A role without `report:read`
// (field crews) is sent home rather than shown an empty, forbidden page.
function RequireReportAccess({ children }) {
  const user = getStoredUser();
  if (user?.role === 'EXECUTIVE') return <Navigate to="/executive" replace />;
  if (!user || !can(user, 'report:read')) return <Navigate to="/home" replace />;
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
          <Route path="/mailbox" element={<Suspend><Mailbox /></Suspend>} />
          <Route path="/executive" element={<RequireExecutive><Suspend><ExecutiveSummary /></Suspend></RequireExecutive>} />
          <Route path="/dashboard" element={<Suspend><Dashboard /></Suspend>} />
          <Route path="/overview" element={<Navigate to="/dashboard" replace />} />
          <Route path="/map" element={<Suspend><MapPage /></Suspend>} />
          <Route path="/regions" element={<BlockExecutive><Navigate to="/assets?area=infrastructure&manage=regions" replace /></BlockExecutive>} />
          <Route path="/substations" element={<BlockExecutive><Navigate to="/assets?area=infrastructure&manage=substations" replace /></BlockExecutive>} />
          <Route path="/lines" element={<BlockExecutive><Navigate to="/assets?area=infrastructure&manage=lines" replace /></BlockExecutive>} />
          <Route path="/towers" element={<BlockExecutive><Navigate to="/assets?area=infrastructure&manage=towers" replace /></BlockExecutive>} />
          <Route path="/assets" element={<BlockExecutive><Suspend><AssetsHub /></Suspend></BlockExecutive>} />
          <Route path="/work" element={<BlockExecutive><Suspend><WorkHub /></Suspend></BlockExecutive>} />
          <Route path="/tasks" element={<BlockExecutive><Suspend><Tasks /></Suspend></BlockExecutive>} />
          <Route path="/tasks/:id" element={<BlockExecutive><Suspend><TaskDetail /></Suspend></BlockExecutive>} />
          <Route path="/crews" element={<BlockExecutive><Suspend><Crews /></Suspend></BlockExecutive>} />
          <Route path="/schedules" element={<BlockExecutive><Suspend><Schedules /></Suspend></BlockExecutive>} />
          <Route path="/checklists" element={<BlockExecutive><Suspend><Checklists /></Suspend></BlockExecutive>} />
          <Route path="/certifications" element={<BlockExecutive><Suspend><Certifications /></Suspend></BlockExecutive>} />
          <Route path="/admin" element={<RequireAdmin><Suspend><AdminHub /></Suspend></RequireAdmin>} />
          <Route path="/admin/reports" element={<RequireAdmin><Suspend><Reports /></Suspend></RequireAdmin>} />
          <Route path="/admin/value" element={<RequireAdmin><Suspend><Value /></Suspend></RequireAdmin>} />
          <Route path="/admin/organization" element={<RequireAdmin><Suspend><Organization /></Suspend></RequireAdmin>} />
          <Route path="/admin/settings" element={<RequireAdmin><Suspend><Settings /></Suspend></RequireAdmin>} />
          <Route path="/admin/tools" element={<RequireAdmin><Suspend><OperatingModel /></Suspend></RequireAdmin>} />
          <Route path="/gps" element={<BlockExecutive><Suspend><Gps /></Suspend></BlockExecutive>} />
          <Route path="/reports" element={<RequireReportAccess><Suspend><Reports /></Suspend></RequireReportAccess>} />
          <Route path="/value" element={<RequireAdmin><Suspend><Value /></Suspend></RequireAdmin>} />
          <Route path="/settings" element={<BlockExecutive><Suspend><Settings /></Suspend></BlockExecutive>} />
          <Route path="/organization" element={<BlockExecutive><Suspend><Organization /></Suspend></BlockExecutive>} />
          <Route path="/model" element={<BlockExecutive><Suspend><OperatingModel /></Suspend></BlockExecutive>} />
          <Route path="/infrastructure" element={<BlockExecutive><Suspend><Infrastructure /></Suspend></BlockExecutive>} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
