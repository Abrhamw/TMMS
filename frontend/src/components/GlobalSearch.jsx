import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { t } from '../i18n';
import { buildSearchSummary } from '../mergeSearchResults';
import {
  useRecordSearch,
  useDocumentViewer,
  DocumentStack,
  DeniedNotice,
  RecordResultGroups,
} from './recordSearch';

export default function GlobalSearch() {
  const nav = useNavigate();
  const rootRef = useRef(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [denied, setDenied] = useState(null);
  const { loading, err, results } = useRecordSearch(q);
  const viewer = useDocumentViewer();

  const flat = useMemo(
    () => (results?.groups || []).flatMap((g) => g.items),
    [results]
  );

  useEffect(() => {
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function viewAll() {
    const term = q.trim();
    if (!term) return;
    setOpen(false);
    setDenied(null);
    nav(`/search?q=${encodeURIComponent(term)}`);
  }

  function choose(item) {
    if (!item) return;
    if (item.can_open === false) {
      setDenied(item);
      return;
    }
    setDenied(null);
    setOpen(false);
    setActive(-1);
    setQ('');
    if (item.document_type) { viewer.openDocument(item.document_type, item.id, item.title); return; }
    if (item.href) nav(item.href);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) choose(flat[active]); else viewAll(); }
    else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  }

  const showPanel = open && !!q.trim();
  const summary = results && results.total > 0
    ? buildSearchSummary(results.query || q.trim(), results.counts, t)
    : '';
  return (
    <div className="global-search" ref={rootRef}>
      <label className="global-search-field">
        <Search size={15} strokeWidth={2} className="global-search-icon" aria-hidden="true" />
        <input
          className="global-search-input"
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={t('searchRecordsPlaceholder')}
          aria-label={t('searchRecordsLabel')}
        />
      </label>
      {showPanel && (
        <div className="global-search-panel">
          {loading && <div className="gs-note">{t('search')}…</div>}
          {!loading && err && <div className="gs-note gs-error">{err}</div>}
          {!loading && !err && results && results.total === 0 && <div className="gs-note">{t('searchEmpty')}</div>}
          <DeniedNotice item={denied} />
          <RecordResultGroups
            results={loading || err ? null : results}
            summary={summary}
            active={active}
            onActive={setActive}
            onChoose={choose}
          />
          {!loading && !err && results && results.total > 0 && (
            <button type="button" className="gs-view-all" onClick={viewAll}>
              {t('searchViewAll')}
            </button>
          )}
        </div>
      )}

      <DocumentStack viewer={viewer} />
    </div>
  );
}
