import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Zap, MapPin, Route, AlertTriangle, Radio, ClipboardList } from 'lucide-react';
import { Page } from '../components';
import { t } from '../i18n';
import { buildSearchSummary } from '../mergeSearchResults';
import SearchSchematic from '../components/SearchSchematic';
import {
  useRecordSearch,
  useDocumentViewer,
  DocumentStack,
  DeniedNotice,
  RecordResultGroups,
} from '../components/recordSearch';

const SAMPLE_QUERIES = [
  { q: 'tasks for me', icon: ClipboardList },
  { q: 'overdue towers in Central 1', icon: AlertTriangle },
  { q: 'failed inspections last week', icon: Radio },
  { q: '230 kV lines', icon: Zap },
  { q: 'substations in Central 1', icon: MapPin },
];

function NetworkBackdrop() {
  return (
    <svg className="gsearch-backdrop" viewBox="0 0 960 540" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="gsearch-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#16a34a" stopOpacity="0" />
          <stop offset="40%" stopColor="#16a34a" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#gsearch-line)" strokeWidth="2">
        <path d="M40 420 C 180 360, 240 220, 380 210 S 560 280, 700 160 S 860 80, 940 120" />
        <path d="M20 180 C 160 240, 280 300, 420 280 S 620 180, 780 260 S 900 340, 950 300" />
        <path d="M80 80 C 200 140, 260 260, 400 340 S 620 400, 820 360" />
      </g>
      <g>
        <circle cx="180" cy="360" r="7" fill="#16a34a" opacity="0.7" />
        <circle cx="380" cy="210" r="9" fill="#2563eb" opacity="0.75" />
        <circle cx="700" cy="160" r="7" fill="#b91c1c" opacity="0.7" />
        <circle cx="420" cy="280" r="6" fill="#ca8a04" opacity="0.7" />
        <circle cx="780" cy="260" r="8" fill="#16a34a" opacity="0.65" />
        <rect x="164" y="344" width="32" height="32" rx="4" fill="none" stroke="#16a34a" strokeWidth="1.4" opacity="0.5" />
        <rect x="364" y="194" width="32" height="32" rx="4" fill="none" stroke="#2563eb" strokeWidth="1.4" opacity="0.5" />
        <rect x="764" y="244" width="32" height="32" rx="4" fill="none" stroke="#16a34a" strokeWidth="1.4" opacity="0.45" />
      </g>
      <g className="gsearch-pulse">
        <circle cx="380" cy="210" r="16" fill="none" stroke="#2563eb" strokeWidth="1.2" opacity="0.35" />
        <circle cx="700" cy="160" r="14" fill="none" stroke="#b91c1c" strokeWidth="1.2" opacity="0.3" />
      </g>
    </svg>
  );
}

export default function SearchResults() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') || '';
  const [q, setQ] = useState(urlQuery);
  const [denied, setDenied] = useState(null);
  const [active, setActive] = useState(-1);
  const { loading, err, results } = useRecordSearch(q);
  const viewer = useDocumentViewer();
  const lastPushed = useRef(urlQuery);
  const inputRef = useRef(null);

  const flat = results?.groups.flatMap((g) => g.items) || [];
  const selected = active >= 0 ? flat[active] : (flat[0] || null);

  useEffect(() => {
    if (urlQuery !== lastPushed.current) {
      lastPushed.current = urlQuery;
      setQ(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => {
    const term = q.trim();
    if (term === lastPushed.current) return undefined;
    const handle = setTimeout(() => {
      lastPushed.current = term;
      setParams(term ? { q: term } : {}, { replace: true });
    }, 300);
    return () => clearTimeout(handle);
  }, [q, setParams]);

  useEffect(() => {
    setActive(-1);
  }, [q]);

  useEffect(() => {
    if (active < 0) return;
    const el = document.querySelector(`.search-results-list .gs-item[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const summary = results && results.total > 0
    ? buildSearchSummary(results.query || q.trim(), results.counts, t)
    : '';

  function choose(item) {
    if (!item) return;
    if (item.can_open === false) {
      setDenied(item);
      return;
    }
    setDenied(null);
    if (item.document_type) { viewer.openDocument(item.document_type, item.id, item.title); return; }
    if (item.href) nav(item.href);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(flat[active]);
      else if (flat.length === 1) choose(flat[0]);
    }
    else if (e.key === 'Escape') { setActive(-1); }
  }

  function applySample(text) {
    setQ(text);
    setDenied(null);
    inputRef.current?.focus();
  }

  const term = q.trim();
  const showEmpty = term && !loading && !err && results && results.total === 0;
  const highlight = term && !loading && !err && results && results.total > 0 ? selected : null;
  const idle = !term;

  return (
    <Page title={idle ? '' : t('searchResultsTitle')} crumbs={idle ? '' : 'TMMS / Search'} fill>
      <div className={'gsearch' + (idle ? ' is-idle' : ' is-results')}>
        {idle && <NetworkBackdrop />}

        <div className="gsearch-stage">
          {idle && (
            <div className="gsearch-brand">
              <div className="gsearch-mark"><em>T</em></div>
              <h1>TMMS</h1>
              <p>{t('tagline')}</p>
            </div>
          )}

          <form className="gsearch-form" onSubmit={(e) => { e.preventDefault(); inputRef.current?.blur(); }}>
            {!idle && <div className="gsearch-mini-mark"><em>T</em></div>}
            <label className="gsearch-box">
              <Search size={20} strokeWidth={2} className="gsearch-box-icon" aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                value={q}
                onChange={(e) => { setQ(e.target.value); setDenied(null); }}
                onKeyDown={onKey}
                placeholder={t('searchRecordsPlaceholder')}
                aria-label={t('searchRecordsLabel')}
                autoFocus
              />
            </label>
          </form>

          {idle && (
            <>
              <div className="gsearch-actions">
                <button type="button" className="gsearch-btn" onClick={() => inputRef.current?.focus()}>
                  {t('searchNav')}
                </button>
                <button type="button" className="gsearch-btn" onClick={() => applySample(SAMPLE_QUERIES[0].q)}>
                  {t('searchLucky')}
                </button>
              </div>
              <p className="gsearch-hint">{t('searchPrompt')}</p>
              <div className="gsearch-samples">
                {SAMPLE_QUERIES.map((s) => {
                  const Icon = s.icon;
                  return (
                    <button key={s.q} type="button" className="gsearch-sample" onClick={() => applySample(s.q)}>
                      <Icon size={13} /> {s.q}
                    </button>
                  );
                })}
              </div>
              <div className="gsearch-artifacts">
                <div className="gsearch-art">
                  <Route size={16} />
                  <div>
                    <b>{t('searchChipLine')}</b>
                    <span>{t('searchArtLine')}</span>
                  </div>
                </div>
                <div className="gsearch-art">
                  <MapPin size={16} />
                  <div>
                    <b>{t('searchChipSs')}</b>
                    <span>{t('searchArtSs')}</span>
                  </div>
                </div>
                <div className="gsearch-art">
                  <Zap size={16} />
                  <div>
                    <b>{t('searchArtLive')}</b>
                    <span>{t('searchArtLiveHint')}</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {!idle && (
          <div className="gsearch-body">
            {loading && <div className="gs-note">{t('search')}…</div>}
            {!loading && err && <div className="gs-note gs-error">{err}</div>}
            {showEmpty && <div className="search-hero">{t('searchEmpty')}</div>}
            <DeniedNotice item={denied} />
            <div className="search-workspace-body">
              <div className="search-workspace-list">
                {(summary || (results && results.total > 0)) && (
                  <div className="search-results-meta">
                    {summary}
                    <span className="search-results-hint">{t('searchEnterHint')}</span>
                  </div>
                )}
                <div className="search-results-list" role="listbox" aria-label={t('searchResultsTitle')}>
                  <RecordResultGroups
                    results={!loading && !err ? results : null}
                    active={active}
                    onActive={setActive}
                    onSelect={setActive}
                    onChoose={choose}
                    showOpenAction
                  />
                </div>
              </div>
              <div className="search-workspace-map">
                <SearchSchematic item={highlight} onOpen={choose} />
              </div>
            </div>
          </div>
        )}
      </div>
      <DocumentStack viewer={viewer} />
    </Page>
  );
}
