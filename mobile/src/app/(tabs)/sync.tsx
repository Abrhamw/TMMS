import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { displayName } from '../../api/types';
import { useAuth } from '../../auth/context';
import { colors, radius, spacing } from '../../theme';

export default function SyncScreen() {
  const { user, serverUrl, signOut } = useAuth();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sync & Settings</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Signed in as</Text>
        <Text style={styles.value}>{user ? displayName(user) : '—'}</Text>
        <Text style={styles.meta}>{user?.role ?? ''}</Text>

        <Text style={styles.label}>Server</Text>
        <Text style={styles.value}>{serverUrl ?? '—'}</Text>

        <Text style={styles.label}>Pending changes</Text>
        <Text style={styles.value}>0</Text>
      </View>

      <Pressable style={styles.signOut} onPress={() => void signOut()}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  card: {
    marginTop: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  label: { fontSize: 12, color: colors.muted, marginTop: spacing.md, textTransform: 'uppercase' },
  value: { fontSize: 16, color: colors.text, marginTop: spacing.xs },
  meta: { fontSize: 13, color: colors.muted },
  signOut: {
    marginTop: spacing.xl,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  signOutText: { color: colors.danger, fontSize: 16, fontWeight: '600' },
});
