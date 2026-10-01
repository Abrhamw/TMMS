import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { listMessages } from '../../db/queries';
import { pullMailbox } from '../../sync/pull';
import { MAIL_FOLDERS, type MailMessage } from '../../api/mailTypes';
import { colors, radius, spacing } from '../../theme';

function formatAt(iso?: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

export default function MailScreen() {
  const { client } = useAuth();
  const [folder, setFolder] = useState<string>('mailinbox');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(
    async (target: string) => {
      const db = await getDb();
      const cached = await listMessages<MailMessage>(db, target);
      setMessages(cached);
      setLoading(false);
      try {
        const fresh = await pullMailbox(db, client, target);
        setMessages(fresh);
        setOffline(false);
      } catch {
        setOffline(true);
      }
    },
    [client],
  );

  useEffect(() => {
    setLoading(true);
    void load(folder);
  }, [folder, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(folder);
    setRefreshing(false);
  }, [folder, load]);

  return (
    <View style={styles.screen}>
      <View style={styles.folders}>
        {MAIL_FOLDERS.map((item) => (
          <Pressable
            key={item.key}
            onPress={() => setFolder(item.key)}
            style={[styles.chip, folder === item.key && styles.chipActive]}
          >
            <Text style={[styles.chipText, folder === item.key && styles.chipTextActive]}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {offline ? 'No saved mail yet. Reconnect to load your mailbox.' : 'No messages here.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => router.push({ pathname: '/mail/[id]', params: { id: String(item.id) } })}
            >
              <View style={styles.rowHeader}>
                <Text style={[styles.subject, item.unread && styles.unreadSubject]} numberOfLines={1}>
                  {item.subject || '(no subject)'}
                </Text>
                {item.unread ? <View style={styles.dot} /> : null}
              </View>
              <Text style={styles.actor} numberOfLines={1}>
                {item.outgoing ? `To ${item.recipient ?? '—'}` : item.actor ?? '—'}
              </Text>
              <Text style={styles.at}>{formatAt(item.at)}</Text>
            </Pressable>
          )}
        />
      )}

      <Pressable
        style={styles.compose}
        onPress={() => router.push({ pathname: '/mail/compose' })}
      >
        <Text style={styles.composeText}>Compose</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  folders: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  chipTextActive: { color: '#ffffff', fontWeight: '600' },
  loading: { flex: 1, backgroundColor: colors.bg },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  empty: { textAlign: 'center', color: colors.muted, marginTop: spacing.xl, fontSize: 14 },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  subject: { flex: 1, fontSize: 15, color: colors.text },
  unreadSubject: { fontWeight: '700' },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary },
  actor: { fontSize: 13, color: colors.muted, marginTop: 2 },
  at: { fontSize: 12, color: colors.muted, marginTop: 2 },
  compose: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  composeText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
});
