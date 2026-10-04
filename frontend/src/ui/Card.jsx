import { cn } from './cn';

export function Card({ className, ...props }) {
  return <div className={cn('rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900', className)} {...props} />;
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('flex items-start justify-between gap-3 px-4 pt-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }) {
  return <h3 className={cn('text-sm font-semibold text-slate-900 dark:text-slate-100', className)} {...props} />;
}

export function CardSub({ className, ...props }) {
  return <p className={cn('text-xs text-slate-500 dark:text-slate-400', className)} {...props} />;
}

export function CardBody({ className, ...props }) {
  return <div className={cn('p-4', className)} {...props} />;
}
