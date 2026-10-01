import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { getMessage } from '../../db/queries';
import { pullMessage } from '../../sync/pull';
import { Section, Field } from '../../components/Section';
import type { MailMessage } from '../../api/mailTypes';
import { colors, radius, spacing } from '../../theme';

export default function MailDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Number(params.id);
  const { client } = useAuth();
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const cached = await getMessage<MailMessage>(db, id);
      if (alive && cached) {
        setMessage(cached);
        setLoading(false);
      }
      try {
        const fresh = await pullMessage(db, client, id);
        if (alive) {
          setMessage(fresh);
          setOffline(false);
        }
      } catch {
        if (alive) setOffline(true);
      } finally {
        if (alive) setLoading(false);
      }
      try {
        await client.put(`/mailbox/messages/${id}/read`);
      } catch {
        /* read receipt is best-effort offline */
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, client]);

  const reply = useCallback(() => {
    if (!message) return;
    router.push({
      pathname: '/mail/compose',
      params: {
        replyTo: String(message.id),
        subject: message.subject?.startsWith('Re:') ? message.subject : `Re: ${message.subject ?? ''}`,
        to: String(message.sender_person_id ?? ''),
      },
    });
  }, [message]);

  const forward = useCallback(() => {
    if (!message) return;
    router.push({
      pathname: '/mail/compose',
      params: {
        forwardOf: String(message.id),
        subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject ?? ''}`,
      },
    });
  }, [message]);

  if (loading && !message) {
    return <ActivityIndicator style={styles.loading} color={colors.primary} />;
  }
  if (!message) {
    return (
      <View style={styles.loading}>
        <Text style={styles.muted}>Not available offline yet. Reconnect and reopen.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Message' }} />
      <Text style={styles.subject}>{message.subject || '(no subject)'}</Text>
      {offline ? <Text style={styles.offline}>Offline — showing saved message</Text> : null}

      <Section title="Envelope">
        <Field label="From" value={message.actor} />
        <Field label="To" value={message.recipient} />
        <Field label="Date" value={message.at?.slice(0, 16).replace('T', ' ')} />
        <Field label="Status" value={message.status} />
        {message.category ? <Field label="Category" value={message.category} /> : null}
        {message.priority && message.priority !== 'NORMAL' ? (
          <Field label="Priority" value={message.priority} />
        ) : null}
      </Section>

      <Section title="Body">
        <Text style={styles.body}>{message.body || '(empty)'}</Text>
      </Section>

      {Array.isArray(message.attachments) && message.attachments.length > 0 ? (
        <Section title="Attachments">
          <Field label="Files" value={message.attachments.length} />
        </Section>
      ) : null}

      <View style={styles.actions}>
        <Pressable style={[styles.button, styles.secondary]} onPress={reply}>
          <Text style={styles.secondaryText}>Reply</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.secondary]} onPress={forward}>
          <Text style={styles.secondaryText}>Forward</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: spacing.xl,
  },
  muted: { color: colors.muted, fontSize: 14 },
  subject: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  offline: { color: colors.warning, fontSize: 12, marginBottom: spacing.sm },
  body: { fontSize: 15, color: colors.text, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  button: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
});
