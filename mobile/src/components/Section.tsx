import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{title}</Text>
      {children}
    </View>
  );
}

export function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{String(value)}</Text>
    </View>
  );
}

export function BulletList({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) {
    return empty ? <Text style={styles.empty}>{empty}</Text> : null;
  }
  return (
    <View style={styles.bullets}>
      {items.map((item, index) => (
        <Text key={`${index}-${item}`} style={styles.bullet}>
          • {item}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  heading: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  field: { marginBottom: spacing.sm },
  fieldLabel: { fontSize: 12, color: colors.muted },
  fieldValue: { fontSize: 15, color: colors.text, marginTop: 2 },
  bullets: { gap: 2 },
  bullet: { fontSize: 14, color: colors.text },
  empty: { fontSize: 13, color: colors.muted },
});
