import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { cn } from './cn';

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function CommandPalette({ open, onClose, commands = [], searchable = true }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [results, setResults] = useState([]);
  const seq = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setResults([]);
      const timer = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open || !searchable) return undefined;
    const term = q.trim();
    if (term.length < 2) { setResults([]); return undefined; }
    const my = ++seq.current;
    const timer = setTimeout(() => {
      api.get(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (my !== seq.current) return;
          setResults((r.groups || []).flatMap((g) => g.items.map((it) => ({ ...it, group: g.label }))).filter((it) => it.href).slice(0, 6));
        })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [q, open, searchable]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return commands.filter((c) => !term || c.label.toLowerCase().includes(term)).slice(0, 8);
  }, [commands, q]);

  const rows = useMemo(
    () => [...filtered.map((c) => ({ kind: 'cmd', ...c })), ...results.map((r) => ({ kind: 'res', label: r.title, sub: r.group, href: r.href }))],
    [filtered, results]
  );

  function choose(row) {
    if (!row) return;
    onClose?.();
    if (row.kind === 'cmd') row.run?.();
    else if (row.href) nav(row.href);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(rows[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
  }

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[1250] flex items-start justify-center p-4 pt-[12vh]">
          <motion.div
            className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced() ? 0 : 0.16 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
            initial={reduced() ? false : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced() ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: reduced() ? 0 : 0.18 }}
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
              <Search size={17} className="text-slate-400" />
              <input
                ref={inputRef}
                value={q}
                autoFocus
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={onKey}
                placeholder="Search pages, assets, tasks…"
                className="h-12 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
                aria-label="Command input"
              />
              <kbd className="hidden rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-400 dark:border-slate-700 sm:block">ESC</kbd>
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {rows.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-400">No matches</div>}
              {rows.map((row, i) => (
                <button
                  key={`${row.kind}-${row.href || row.label}-${i}`}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(row)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm',
                    i === active ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  )}
                >
                  <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">{row.label}</span>
                  {row.sub && <span className="shrink-0 text-[11px] text-slate-400">{row.sub}</span>}
                </button>
              ))}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
