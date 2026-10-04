import { cn } from './cn';

export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div role="tablist" className={cn('inline-flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800', className)}>
      {(tabs || []).map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
            value === t.key
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
