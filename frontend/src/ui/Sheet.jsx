import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from './cn';

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function Sheet({ open, onClose, title, description, side = 'right', children, footer, className }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => panelRef.current?.focus(), 40);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      clearTimeout(timer);
    };
  }, [open, onClose]);

  const from = side === 'bottom'
    ? { y: '100%' }
    : side === 'left'
      ? { x: '-100%' }
      : { x: '100%' };

  const panelPos = side === 'bottom'
    ? 'inset-x-0 bottom-0 max-h-[88vh] w-full rounded-t-2xl border-t'
    : side === 'left'
      ? 'inset-y-0 left-0 h-full w-full max-w-md border-r'
      : 'inset-y-0 right-0 h-full w-full max-w-md border-l';

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[1200]">
          <motion.div
            className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced() ? 0 : 0.18 }}
            onClick={onClose}
          />
          <motion.aside
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn(
              'absolute flex flex-col border-slate-200 bg-white shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-900',
              panelPos,
              className
            )}
            initial={reduced() ? false : from}
            animate={side === 'bottom' ? { y: 0 } : { x: 0 }}
            exit={reduced() ? { opacity: 0 } : from}
            transition={{ type: 'tween', duration: reduced() ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <div className="min-w-0">
                {title && <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>}
                {description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                <X size={18} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <footer className="border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</footer>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
