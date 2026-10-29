import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Page } from '../components';
import { t } from '../i18n';
import { buildSearchSummary } from '../mergeSearchResults';
import {
  useRecordSearch,
  useDocumentViewer,
  DocumentStack,
  DeniedNotice,
  RecordResultGroups,
} from '../components/recordSearch';

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

  const term = q.trim();
  const showEmpty = term && !loading && !err && results && results.total === 0;
  return (
    <Page title={t('searchResultsTitle')} crumbs="TMMS / Search">
      <div className="search-results">
        <label className="global-search-field search-results-field">
          <Search size={19} strokeWidth={2} className="global-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="global-search-input"
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setDenied(null); }}
            onKeyDown={onKey}
            placeholder={t('searchRecordsPlaceholder')}
            aria-label={t('searchRecordsLabel')}
            autoFocus
          />
        </label>

        {!term && <div className="search-hero">{t('searchPrompt')}</div>}
        {term && loading && <div className="gs-note">{t('search')}…</div>}
        {term && !loading && err && <div className="gs-note gs-error">{err}</div>}
        {showEmpty && <div className="search-hero">{t('searchEmpty')}</div>}

        <DeniedNotice item={denied} />

        {(summary || (results && results.total > 0)) && (
          <div className="search-results-meta">
            {summary}
            <span className="search-results-hint">{t('searchEnterHint')}</span>
          </div>
        )}

        <div className="search-results-list" role="listbox" aria-label={t('searchResultsTitle')}>
          <RecordResultGroups
            results={term && !loading && !err ? results : null}
            active={active}
            onActive={setActive}
            onChoose={choose}
          />
        </div>
      </div>
      <DocumentStack viewer={viewer} />
    </Page>
  );
}
