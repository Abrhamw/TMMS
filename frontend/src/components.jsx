import { useMemo, useState } from 'react';
import { STATUS_COLORS } from './api';
import { codeLabel } from './labels';

export function Pill({ value, children }) {
  const text = children ?? codeLabel(value);
  const color = STATUS_COLORS[String(value ?? text)] || '#64748b';
  return (
    <span className="pill" style={{ background: `${color}1a`, color }}>
      <span className="pill-dot" style={{ background: color }} />
      {text}
    </span>
  );
}

export function CondPill({ rating }) {
  const color = rating <= 3 ? '#dc2626' : rating <= 5 ? '#ea580c' : rating <= 7 ? '#d97706' : '#16a34a';
  return <span className="pill" style={{ background: `${color}1a`, color }}>{rating}/10</span>;
}

export function StatCard({ label, value, sub, color }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function MoneyCard({ label, value, sub, color }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide, printable }) {
  return (
    <div className={'modal-backdrop' + (printable ? ' print-area print-report-scope' : '')} onClick={onClose}>
      <div className="modal" style={wide ? { maxWidth: 900 } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn btn-ghost no-print" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Page({ title, crumbs, actions, children }) {
  return (
    <div className="main">
      <div className="topbar">
        <div>
          {crumbs && <div className="crumbs">{crumbs}</div>}
          <h2>{title}</h2>
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
      <div className="content">{children}</div>
    </div>
  );
}

export function Empty({ message = 'No records found' }) {
  return <div className="empty">{message}</div>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="alert alert-error">{String(error)}</div>;
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

export function ConfirmButton({ label, onConfirm, title, confirmLabel = 'Delete' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-sm btn-danger" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { onConfirm(); setOpen(false); }}>{confirmLabel}</button>
          </>}>
          <p className="muted">This action cannot be undone.</p>
        </Modal>
      )}
    </>
  );
}

export function PrintButton({ label = 'Print', className = 'btn btn-sm', title = 'Print this view' }) {
  const onClick = () => {
    const scoped = !!document.querySelector('.print-report-scope');
    if (scoped) document.body.classList.add('report-printing');
    const done = () => document.body.classList.remove('report-printing');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    setTimeout(done, 1000);
  };
  return (
    <button type="button" className={`${className} no-print`} onClick={onClick} title={title}>
      <span aria-hidden style={{ marginRight: 4 }}>⎙</span>{label}
    </button>
  );
}

export function Progress({ pct, graded, passed, width = 60 }) {
  if (!graded) return <span className="muted" style={{ fontSize: 12 }}>no data</span>;
  const color = pct === 100 ? '#16a34a' : pct >= 60 ? 'var(--accent)' : '#dc2626';
  return (
    <div title={`${passed}/${graded} graded items passed`} style={{ width, display: 'inline-block' }}>
      <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, background: color, height: '100%' }} />
      </div>
      <div className="muted" style={{ fontSize: 11 }}>{pct}% · {passed}/{graded}</div>
    </div>
  );
}

// Instant search: one round field every list can drop in, and a generic text
// filter that matches any value inside a row (including nested names and
// codes). No schema knowledge needed, so it works for every "box" in the app.
export function SearchField({ value, onChange, placeholder = 'Search…', className = '' }) {
  return (
    <span className={'search-field' + (className ? ` ${className}` : '')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.4-3.4" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value ? (
        <button type="button" className="search-clear" onClick={() => onChange('')} aria-label="Clear search">✕</button>
      ) : null}
    </span>
  );
}

const SEARCH_CACHE = new WeakMap();

function searchableText(item) {
  if (item == null) return '';
  if (typeof item !== 'object') return String(item).toLowerCase();
  const hit = SEARCH_CACHE.get(item);
  if (hit !== undefined) return hit;
  const parts = [];
  const seen = new Set();
  const push = (s) => {
    const low = String(s).toLowerCase();
    if (!low) return;
    parts.push(low);
    if (/[_\-/]/.test(low)) parts.push(low.replace(/[_\-/]+/g, ' '));
  };
  const walk = (v, depth) => {
    if (v == null) return;
    const type = typeof v;
    if (type === 'string' || type === 'number' || type === 'boolean') { push(v); return; }
    if (depth >= 3) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (type === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    }
  };
  walk(item, 0);
  const text = parts.join(' ');
  SEARCH_CACHE.set(item, text);
  return text;
}

export function filterItems(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return list;
  return list.filter((it) => {
    const hay = searchableText(it);
    return terms.every((term) => hay.includes(term));
  });
}

export function useSearchFilter(items) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => filterItems(items, query), [items, query]);
  return { query, setQuery, results };
}
