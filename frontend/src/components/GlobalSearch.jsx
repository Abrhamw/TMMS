import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Modal, ErrorNote } from '../components';
import DossierReport from './DossierReport';
import { t } from '../i18n';

// Global, always-available backend search. Results are grouped by entity and
// scoped server-side; selecting a result navigates to its page, opens its
// dossier, or jumps to the Infrastructure hub.
export default function GlobalSearch() {
  const nav = useNavigate();
  const rootRef = useRef(null);
  const seqRef = useRef(0);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [results, setResults] = useState(null);
  const [active, setActive] = useState(-1);
  const [dossiers, setDossiers] = useState([]);

  const flat = useMemo(
    () => (results?.groups || []).flatMap((g) => g.items.map((it) => ({ ...it, group: g.label }))),
    [results]
  );

  useEffect(() => {
    const term = q.trim();
    const my = ++seqRef.current;
    if (!term) { setResults(null); setLoading(false); setErr(null); return; }
    setLoading(true);
    const handle = setTimeout(() => {
      api.get(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (my === seqRef.current) { setResults(r); setErr(null); } })
        .catch((e) => { if (my === seqRef.current) setErr(e.message); })
        .finally(() => { if (my === seqRef.current) setLoading(false); });
    }, 220);
    return () => clearTimeout(handle);
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function openDossier(type, id, label) {
    if (!type || id == null) return;
    const key = `${Date.now()}-${Math.random()}`;
    setDossiers((d) => [...d, { key, type, id, label, loading: true }]);
    api.get(`/reports/dossier?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`)
      .then((res) => setDossiers((d) => d.map((x) => (x.key === key ? { ...x, data: res.data ?? res, loading: false } : x))))
      .catch((e) => setDossiers((d) => d.map((x) => (x.key === key ? { ...x, error: e.message, loading: false } : x))));
  }
  const popDossier = () => setDossiers((d) => d.slice(0, -1));

  function choose(item) {
    if (!item) return;
    setOpen(false);
    setActive(-1);
    setQ('');
    setResults(null);
    if (item.dossier_type) { openDossier(item.dossier_type, item.id, item.title); return; }
    if (item.href) nav(item.href);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active >= 0 ? active : 0]); }
    else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  }

  const showPanel = open && !!q.trim();
  let rowIndex = -1;
  return (
    <div className="global-search" ref={rootRef}>
      <input
        className="global-search-input"
        type="search"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={t('searchPlaceholder')}
        aria-label={t('search')}
      />
      {showPanel && (
        <div className="global-search-panel">
          {loading && <div className="gs-note">{t('search')}…</div>}
          {!loading && err && <div className="gs-note gs-error">{err}</div>}
          {!loading && !err && results && results.total === 0 && <div className="gs-note">No matches.</div>}
          {!loading && results && results.groups.map((g) => (
            <div className="gs-group" key={g.type}>
              <div className="gs-group-label">{g.label}<span className="muted">{g.total}</span></div>
              {g.items.map((it) => {
                rowIndex += 1;
                const i = rowIndex;
                return (
                  <button
                    key={`${it.type}-${it.id}`}
                    type="button"
                    className={'gs-item' + (i === active ? ' active' : '')}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(it)}
                  >
                    <span className="gs-item-title">{it.title}</span>
                    {it.subtitle && <span className="gs-item-sub">{it.subtitle}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {dossiers.length > 0 && (() => {
        const top = dossiers[dossiers.length - 1];
        return (
          <Modal
            title={top.data?.title || top.label || 'Details'}
            onClose={() => (dossiers.length > 1 ? popDossier() : setDossiers([]))}
            wide
            printable
            footer={<>
              {dossiers.length > 1 && <button className="btn" onClick={popDossier}>Back</button>}
              <button className="btn btn-primary" onClick={() => setDossiers([])}>Close</button>
            </>}
          >
            {top.loading ? <div className="muted">Loading…</div>
              : top.error ? <ErrorNote error={top.error} />
                : <DossierReport data={top.data} onOpenEntity={openDossier} />}
          </Modal>
        );
      })()}
    </div>
  );
}
