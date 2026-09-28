import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';

// Shared map search: filters a prebuilt index of map features and reports the
// chosen item back to the caller, which owns the "fly to + reveal" behaviour.
// Keyboard: Up/Down move the highlight, Enter reveals, Esc clears.
export default function MapSearchBox({ items = [], onSelect, placeholder, autoFocus = false, className = '' }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items
      .filter((i) => `${i.label || ''} ${i.meta || ''} ${i.type || ''}`.toLowerCase().includes(s))
      .slice(0, 8);
  }, [q, items]);

  useEffect(() => { setActive(0); }, [q]);

  function choose(item) {
    if (!item) return;
    if (onSelect) onSelect(item);
    setQ('');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { setQ(''); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
  }

  return (
    <div className={'map-searchbox' + (className ? ' ' + className : '')}>
      <div className="map-search">
        <span className="map-search-icon" aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          type="text"
          value={q}
          placeholder={placeholder || t('mapSearch')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          aria-label={placeholder || t('mapSearch')}
        />
        {q && <button type="button" className="map-search-clear" onClick={() => setQ('')} aria-label={t('mapClearSearch')}>×</button>}
      </div>
      {q && (
        <div className="map-results">
          {results.length === 0 ? (
            <div className="map-result is-empty">{t('mapNoResults')}</div>
          ) : results.map((r, i) => (
            <button
              type="button"
              key={r.key}
              className={'map-result' + (i === active ? ' is-active' : '')}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <span className="map-result-type" style={{ background: r.color || '#64748b' }}>{r.type}</span>
              <span className="map-result-text">
                <span className="map-result-label">{r.label}</span>
                {r.meta && <span className="map-result-meta">{r.meta}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
