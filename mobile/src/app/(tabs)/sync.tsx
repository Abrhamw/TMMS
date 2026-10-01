import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { displayName } from '../../api/types';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { listFailed, pendingCount, retryItem, type OutboxItem } from '../../db/outbox';
import { flush } from '../../sync/engine';
import { colors, radius, spacing } from '../../theme';

export default function SyncScreen() {
  const { user, serverUrl, signOut, client } = useAuth();
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const db = await getDb();
    setPending(await pendingCount(db));
    setFailed(await listFailed(db));
  }, []);

  const syncNow = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const db = await getDb();
      const result = await flush({ driver: db, client });
      setNotice(
        result.remaining === 0
          ? `Synced${result.sent ? ` ${result.sent} change${result.sent > 1 ? 's' : ''}` : ''}.`
          : `${result.remaining} change${result.remaining > 1 ? 's' : ''} still waiting to sync.`,
      );
      await refresh();
    } catch {
      setNotice('Sync failed — check your connection.');
    } finally {
      setBusy(false);
    }
  }, [client, refresh]);

  const retry = useCallback(
    async (id: number) => {
      const db = await getDb();
      await retryItem(db, id);
      await syncNow();
    },
    [syncNow],
  );

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

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
        <Text style={styles.value}>{pending}</Text>

        {failed.length > 0 ? (
          <>
            <Text style={styles.label}>Needs attention</Text>
            {failed.map((item) => (
              <View key={item.id} style={styles.failedRow}>
                <View style={styles.failedText}>
                  <Text style={styles.failedType}>{item.type}</Text>
                  <Text style={styles.failedError}>{item.last_error ?? 'Rejected by the server'}</Text>
                </View>
                <Pressable style={styles.retry} onPress={() => void retry(item.id)}>
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            ))}
          </>
        ) : null}
      </View>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <Pressable style={styles.sync} onPress={() => void syncNow()} disabled={busy}>
        {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.syncText}>Sync now</Text>}
      </Pressable>

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
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  failedText: { flex: 1, paddingRight: spacing.sm },
  failedType: { fontSize: 14, color: colors.text, fontWeight: '600' },
  failedError: { fontSize: 12, color: colors.danger, marginTop: 2 },
  retry: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  retryText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  notice: { color: colors.primaryDark, fontSize: 13, marginTop: spacing.md },
  sync: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  syncText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
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
