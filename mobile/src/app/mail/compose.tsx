import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { enqueue } from '../../db/outbox';
import { flush } from '../../sync/engine';
import { cachedRecipients, pullRecipients } from '../../mail/recipients';
import type { MailRecipient } from '../../api/mailTypes';
import { colors, radius, spacing } from '../../theme';

export default function ComposeScreen() {
  const params = useLocalSearchParams<{
    replyTo?: string;
    forwardOf?: string;
    subject?: string;
    to?: string;
  }>();
  const { client } = useAuth();

  const [recipients, setRecipients] = useState<MailRecipient[]>([]);
  const [selected, setSelected] = useState<number[]>(params.to ? [Number(params.to)] : []);
  const [search, setSearch] = useState('');
  const [subject, setSubject] = useState(params.subject ?? '');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const cached = await cachedRecipients(db);
      if (alive && cached.length > 0) setRecipients(cached);
      try {
        const fresh = await pullRecipients(db, client);
        if (alive) setRecipients(fresh);
      } catch {
        /* offline: use the cached address book */
      }
    })();
    return () => {
      alive = false;
    };
  }, [client]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipients.slice(0, 50);
    return recipients
      .filter((person) => person.name.toLowerCase().includes(q) || person.username?.toLowerCase().includes(q))
      .slice(0, 50);
  }, [recipients, search]);

  const toggle = useCallback((personId: number) => {
    setSelected((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId],
    );
  }, []);

  const save = useCallback(
    async (status: 'SENT' | 'DRAFT') => {
      if (status === 'SENT') {
        if (!subject.trim()) {
          setNotice('A subject is required to send.');
          return;
        }
        if (selected.length === 0) {
          setNotice('Choose at least one recipient.');
          return;
        }
      } else if (!subject.trim() && !body.trim()) {
        setNotice('Write a subject or a message before saving a draft.');
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const db = await getDb();
        await enqueue(db, {
          type: 'mail',
          entity: 'mail:compose',
          payload: {
            to: selected,
            subject: subject.trim(),
            body: body.trim(),
            status,
            category: 'GENERAL',
            priority: 'NORMAL',
            parent_id: params.replyTo ? Number(params.replyTo) : null,
            forward_of_id: params.forwardOf ? Number(params.forwardOf) : null,
          },
        });
        const result = await flush({ driver: db, client });
        if (result.remaining > 0) {
          setNotice('Saved offline — it will send when you reconnect.');
          return;
        }
        router.back();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not queue the message.');
      } finally {
        setBusy(false);
      }
    },
    [subject, body, selected, params.replyTo, params.forwardOf, client],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: params.replyTo ? 'Reply' : params.forwardOf ? 'Forward' : 'Compose' }} />

      {selected.length > 0 ? (
        <View style={styles.selectedRow}>
          {selected.map((personId) => {
            const person = recipients.find((candidate) => candidate.person_id === personId);
            return (
              <Pressable key={personId} style={styles.token} onPress={() => toggle(personId)}>
                <Text style={styles.tokenText}>{person?.name ?? `Person ${personId}`} ✕</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <TextInput
        style={styles.input}
        placeholder="Search people"
        placeholderTextColor={colors.muted}
        value={search}
        onChangeText={setSearch}
      />
      <View style={styles.people}>
        {filtered.map((person) => {
          const isSelected = selected.includes(person.person_id);
          return (
            <Pressable
              key={person.person_id}
              onPress={() => toggle(person.person_id)}
              style={[styles.person, isSelected && styles.personSelected]}
            >
              <Text style={[styles.personText, isSelected && styles.personTextSelected]}>
                {person.name}
                {person.title ? ` · ${person.title}` : ''}
              </Text>
            </Pressable>
          );
        })}
        {filtered.length === 0 ? <Text style={styles.muted}>No matching people.</Text> : null}
      </View>

      <TextInput
        style={styles.input}
        placeholder="Subject"
        placeholderTextColor={colors.muted}
        value={subject}
        onChangeText={setSubject}
      />
      <TextInput
        style={[styles.input, styles.body]}
        placeholder="Write your message"
        placeholderTextColor={colors.muted}
        value={body}
        onChangeText={setBody}
        multiline
      />

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <View style={styles.actions}>
        <Pressable style={[styles.button, styles.secondary]} onPress={() => void save('DRAFT')} disabled={busy}>
          <Text style={styles.secondaryText}>Save draft</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.primary]} onPress={() => void save('SENT')} disabled={busy}>
          {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.primaryText}>Send</Text>}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm },
  selectedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  token: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  tokenText: { color: '#ffffff', fontSize: 13 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: 15,
    color: colors.text,
  },
  people: { maxHeight: 220 },
  person: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  personSelected: { backgroundColor: '#eef2ff' },
  personText: { fontSize: 14, color: colors.text },
  personTextSelected: { fontWeight: '700', color: colors.primaryDark },
  body: { minHeight: 140, textAlignVertical: 'top' },
  muted: { color: colors.muted, fontSize: 13 },
  notice: { color: colors.danger, fontSize: 13 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  button: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  primary: { backgroundColor: colors.primary },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
