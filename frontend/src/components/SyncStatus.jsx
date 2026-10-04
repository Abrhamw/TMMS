import { WifiOff, Loader2, AlertTriangle, Check } from 'lucide-react';
import { useSyncState } from '../sync';
import { t } from '../i18n';
import { cn } from '../ui/cn';

// Persistent connectivity/save indicator. Writes drive the store through the API
// layer, so a field worker always sees whether their work reached the server.
export default function SyncStatus({ className, showLabel = true }) {
  const { online, pending, error } = useSyncState();

  let tone = 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900';
  let Icon = Check;
  let label = t('syncSaved');

  if (!online) {
    tone = 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900';
    Icon = WifiOff;
    label = t('syncOffline');
  } else if (pending > 0) {
    tone = 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900';
    Icon = Loader2;
    label = t('syncSaving');
  } else if (error) {
    tone = 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900';
    Icon = AlertTriangle;
    label = t('syncFailed');
  }

  return (
    <span
      role="status"
      aria-live="polite"
      title={label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
        tone,
        className
      )}
    >
      <Icon size={13} className={pending > 0 && online ? 'animate-spin' : undefined} />
      {showLabel && <span className="hidden sm:inline">{label}</span>}
    </span>
  );
}
