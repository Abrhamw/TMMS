import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

interface PlaceholderProps {
  title: string;
  subtitle?: string;
  message: string;
}

export function Placeholder({ title, subtitle, message }: PlaceholderProps) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      <View style={styles.card}>
        <Text style={styles.cardText}>{message}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 13, color: colors.muted, marginTop: spacing.xs },
  card: {
    marginTop: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardText: { fontSize: 14, color: colors.muted },
});
