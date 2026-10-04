import { cva } from 'class-variance-authority';
import { cn } from './cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none',
  {
    variants: {
      tone: {
        neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
        brand: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
        success: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
        warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
        danger: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
        info: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
);

export function Badge({ className, tone, ...props }) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
