import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { getStoredToken } from '../auth';
import { t } from '../i18n';

const PERSONAS = [
  { key: 'crew', ico: '🔧', title: 'Field Crew', subtitle: 'My assigned maintenance jobs', desc: 'See your task queue, run checklists, capture GPS on site.' },
  { key: 'director', ico: '🗂', title: 'Director / Manager', subtitle: 'My region\u2019s health: tasks, violations, schedules, certs', desc: 'Region overview, GPS violations, upcoming work, expiring certifications.' },
  { key: 'executive', ico: '🏛', title: 'Executive', subtitle: 'Whole-of-company overview & governance', desc: 'Company-wide activity across all directorates and divisions.' },
  { key: 'planner', ico: '🗓', title: 'Planner / Dispatcher', subtitle: 'Create and schedule work', desc: 'Draft and schedule tasks, assign crews, manage the calendar.' },
  { key: 'auditor', ico: '🔍', title: 'Auditor', subtitle: 'Review evidence and compliance', desc: 'Audit trail, pending verifications, GPS and certification compliance.' },
  { key: 'other', ico: '👤', title: 'Other / Sign in', subtitle: 'I have an account', desc: 'Administrators and everyone else sign in here.' },
];

function LandingSearch() {
  const nav = useNavigate();
  const seqRef = useRef(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [results, setResults] = useState(null);
  const [active, setActive] = useState(-1);

  const flat = useMemo(
    () => (results?.groups || []).flatMap((g) => g.items.map((it) => ({ ...it, group: g.label }))),
    [results]
  );

  useEffect(() => {
    const term = q.trim();
    const my = ++seqRef.current;
    if (!term) { setResults(null); setLoading(false); setErr(null); return undefined; }
    setLoading(true);
    const handle = setTimeout(() => {
      fetch(`/api/search/public?q=${encodeURIComponent(term)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((r) => { if (my === seqRef.current) { setResults(r); setErr(null); } })
        .catch((e) => { if (my === seqRef.current) setErr(e.message); })
        .finally(() => { if (my === seqRef.current) setLoading(false); });
    }, 220);
    return () => clearTimeout(handle);
  }, [q]);

  function openItem(item) {
    if (!item?.href) return;
    nav(`/login?persona=other&next=${encodeURIComponent(item.href)}`);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(flat.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); openItem(flat[active >= 0 ? active : 0]); }
    else if (e.key === 'Escape') { setQ(''); setResults(null); setActive(-1); }
  }

  const term = q.trim();
  let rowIndex = -1;
  return (
    <aside className="landing-search" aria-label={t('landingSearchTitle')}>
      <div className="landing-search-head">
        <h2>{t('landingSearchTitle')}</h2>
        <p>{t('landingSearchHint')}</p>
      </div>
      <label className="landing-search-field">
        <Search size={18} strokeWidth={1.9} aria-hidden="true" />
        <input
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(-1); }}
          onKeyDown={onKey}
          placeholder={t('landingSearchPlaceholder')}
          aria-label={t('landingSearchTitle')}
          autoComplete="off"
        />
      </label>
      <div className="landing-search-body" role="listbox" aria-label={t('landingSearchTitle')}>
        {!term && <div className="ls-note">{t('landingSearchHint')}</div>}
        {term && loading && <div className="ls-note">{t('search')}…</div>}
        {term && !loading && err && <div className="ls-note ls-error">{err}</div>}
        {term && !loading && !err && results && results.total === 0 && <div className="ls-note">{t('landingSearchEmpty')}</div>}
        {term && results && results.groups.map((g) => (
          <div className="ls-group" key={g.type}>
            <div className="ls-group-label">{g.label}<span>{g.total}</span></div>
            {g.items.map((it) => {
              rowIndex += 1;
              const i = rowIndex;
              return (
                <button
                  key={`${it.type}-${it.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={'ls-item' + (i === active ? ' active' : '')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => openItem(it)}
                >
                  <span className="ls-item-title">{it.title}</span>
                  {it.subtitle && <span className="ls-item-sub">{it.subtitle}</span>}
                  <span className="ls-item-go">{t('landingSearchSignIn')}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

export default function Landing() {
  const nav = useNavigate();
  useEffect(() => {
    if (getStoredToken()) nav('/home', { replace: true });
  }, [nav]);
  return (
    <div className="landing">
      <div className="landing-main">
        <div className="landing-hero">
          <div className="landing-logo"><em>T</em></div>
          <h1>{t('appName')}</h1>
          <p>{t('tagline')}</p>
          <div className="landing-hint">Who are you? Choose your role to get the view you deserve.</div>
        </div>
        <div className="landing-grid">
          {PERSONAS.map((p) => (
            <button key={p.key} className="landing-card" onClick={() => nav(`/login?persona=${p.key}`)}>
              <div className="landing-ico">{p.ico}</div>
              <div className="landing-title">{p.title}</div>
              <div className="landing-sub">{p.subtitle}</div>
              <div className="landing-desc">{p.desc}</div>
              <div className="landing-go">Continue →</div>
            </button>
          ))}
        </div>
        <div className="landing-footer">Ethiopian Electric Power · Transmission Maintenance Management System</div>
      </div>
      <LandingSearch />
    </div>
  );
}
