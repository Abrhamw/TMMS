import { useEffect, useMemo, useRef, useState } from 'react';
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
  const { loading, err, results } = useRecordSearch(q);
  const viewer = useDocumentViewer();
  const lastPushed = useRef(urlQuery);

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

  const term = q.trim();
  return (
    <Page title={t('searchResultsTitle')} crumbs="TMMS / Search">
      <div className="search-results">
        <label className="global-search-field search-results-field">
          <Search size={17} strokeWidth={2} className="global-search-icon" aria-hidden="true" />
          <input
            className="global-search-input"
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setDenied(null); }}
            placeholder={t('searchRecordsPlaceholder')}
            aria-label={t('searchRecordsLabel')}
            autoFocus
          />
        </label>

        {!term && <div className="gs-note">{t('searchPrompt')}</div>}
        {term && loading && <div className="gs-note">{t('search')}…</div>}
        {term && !loading && err && <div className="gs-note gs-error">{err}</div>}
        {term && !loading && !err && results && results.total === 0 && <div className="gs-note">{t('searchEmpty')}</div>}

        <DeniedNotice item={denied} />

        <div className="search-results-list">
          <RecordResultGroups
            results={term && !loading && !err ? results : null}
            summary={summary}
            onChoose={choose}
          />
        </div>
      </div>
      <DocumentStack viewer={viewer} />
    </Page>
  );
}
