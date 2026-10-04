import { cn } from './cn';

export function Skeleton({ className, ...props }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/80 dark:bg-slate-700/60', className)} {...props} />;
}
