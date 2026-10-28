import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Modal, ErrorNote } from '../components';
import DocumentReport from './DocumentReport';
import { t } from '../i18n';
import { mergeSearchResults } from '../mergeSearchResults';

export function useRecordSearch(term) {
  const seqRef = useRef(0);
  const [state, setState] = useState({ loading: false, err: null, results: null });

  useEffect(() => {
    const query = String(term == null ? '' : term).trim();
    const my = ++seqRef.current;
    if (!query) {
      setState({ loading: false, err: null, results: null });
      return undefined;
    }
    setState((prev) => ({ ...prev, loading: true, err: null }));
    const handle = setTimeout(() => {
      Promise.all([
        api.get(`/search/public?q=${encodeURIComponent(query)}`),
        api.get(`/search?q=${encodeURIComponent(query)}`).catch(() => ({ groups: [] })),
      ])
        .then(([catalog, scoped]) => {
          if (my !== seqRef.current) return;
          setState({ loading: false, err: null, results: mergeSearchResults(catalog, scoped) });
        })
        .catch((e) => {
          if (my !== seqRef.current) return;
          setState({ loading: false, err: e.message, results: null });
        });
    }, 220);
    return () => clearTimeout(handle);
  }, [term]);

  return state;
}

export function useDocumentViewer() {
  const [documents, setDocuments] = useState([]);

  function openDocument(type, id, label) {
    if (!type || id == null) return;
    const key = `${Date.now()}-${Math.random()}`;
    setDocuments((d) => [...d, { key, type, id, label, loading: true }]);
    api.get(`/reports/document?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`)
      .then((res) => setDocuments((d) => d.map((x) => (x.key === key ? { ...x, data: res.data ?? res, loading: false } : x))))
      .catch((e) => setDocuments((d) => d.map((x) => (x.key === key ? { ...x, error: e.message, loading: false } : x))));
  }

  const popDocument = () => setDocuments((d) => d.slice(0, -1));
  const closeDocuments = () => setDocuments([]);

  return { documents, openDocument, popDocument, closeDocuments };
}

export function DocumentStack({ viewer }) {
  const { documents, openDocument, popDocument, closeDocuments } = viewer;
  if (!documents || !documents.length) return null;
  const top = documents[documents.length - 1];
  return (
    <Modal
      title={top.data?.title || top.label || 'Details'}
      onClose={() => (documents.length > 1 ? popDocument() : closeDocuments())}
      wide
      printable
      footer={<>
        {documents.length > 1 && <button className="btn" onClick={popDocument}>Back</button>}
        <button className="btn btn-primary" onClick={closeDocuments}>Close</button>
      </>}
    >
      {top.loading ? <div className="muted">Loading…</div>
        : top.error ? <ErrorNote error={top.error} />
          : <DocumentReport data={top.data} onOpenEntity={openDocument} />}
    </Modal>
  );
}

export function DeniedNotice({ item }) {
  if (!item) return null;
  return (
    <div className="gs-denied" role="status">
      <span className="gs-denied-mark" aria-hidden="true">!</span>
      <div className="gs-denied-copy">
        <b>{t('searchDeniedTitle')}</b>
        <span>{t('searchDeniedBody')}</span>
      </div>
    </div>
  );
}

export function RecordResultGroups({ results, summary, active = -1, onActive, onChoose }) {
  if (!results) return null;
  let rowIndex = -1;
  return (
    <>
      {summary && <div className="gs-summary">{summary}</div>}
      {results.groups.map((g) => (
        <div className="gs-group" key={g.type}>
          <div className="gs-group-label">{g.label}<span className="muted">{g.total}</span></div>
          {g.items.map((it) => {
            rowIndex += 1;
            const i = rowIndex;
            const locked = it.can_open === false;
            return (
              <button
                key={`${it.type}-${it.id}`}
                type="button"
                className={'gs-item' + (i === active ? ' active' : '') + (locked ? ' locked' : '')}
                onMouseEnter={onActive ? () => onActive(i) : undefined}
                onClick={() => onChoose(it)}
              >
                <span className="gs-item-head">
                  {it.tag && <span className="gs-tag">{it.tag}</span>}
                  <span className="gs-item-title">{it.title}</span>
                </span>
                {(it.description || it.subtitle) && <span className="gs-item-desc">{it.description || it.subtitle}</span>}
                {it.match === 'related' && it.via && it.via.length > 0 && (
                  <span className="gs-item-via">{t('searchVia')} {it.via.join(', ')}</span>
                )}
                {locked && <span className="gs-item-sub">{t('searchViewOnly')}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}
