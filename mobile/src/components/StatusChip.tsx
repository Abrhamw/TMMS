import { StyleSheet, Text, View } from 'react-native';
import { radius } from '../theme';

const STATUS_COLORS: Record<string, string> = {
  ASSIGNED: '#3b82f6',
  ON_SITE: '#3b82f6',
  IN_PROGRESS: '#3b82f6',
  ON_TASK: '#0ea5e9',
  COMPLETED: '#16a34a',
  VERIFIED: '#16a34a',
  REJECTED: '#dc2626',
  ON_HOLD: '#f97316',
  PENDING_VERIFICATION: '#a855f7',
  CANCELLED: '#64748b',
  DRAFT: '#94a3b8',
  CRITICAL: '#dc2626',
  HIGH: '#ea580c',
  MEDIUM: '#d97706',
  LOW: '#16a34a',
};

export function statusColor(status?: string | null): string {
  if (status && STATUS_COLORS[status]) return STATUS_COLORS[status];
  return '#64748b';
}

export function StatusChip({ status }: { status?: string | null }) {
  const color = statusColor(status);
  return (
    <View style={[styles.chip, { borderColor: color, backgroundColor: `${color}1a` }]}>
      <Text style={[styles.text, { color }]}>{(status ?? '—').replace(/_/g, ' ')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  text: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
});
