import { cn } from './cn';

export function Tooltip({ label, side = 'top', className, children }) {
  const pos = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[side];
  return (
    <span className={cn('group/tt relative inline-flex', className)}>
      {children}
      {label ? (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute z-[1300] whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover/tt:opacity-100 dark:bg-slate-700',
            pos
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
