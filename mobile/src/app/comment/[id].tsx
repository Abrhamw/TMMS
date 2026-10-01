import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { enqueue } from '../../db/outbox';
import { flush } from '../../sync/engine';
import { colors, radius, spacing } from '../../theme';

export default function CommentScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const taskId = Number(params.id);
  const { client } = useAuth();

  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!body.trim()) {
      setNotice('Write something first.');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const db = await getDb();
      await enqueue(db, {
        type: 'comment',
        entity: `task:${taskId}`,
        payload: { entity_type: 'task', entity_id: taskId, body: body.trim() },
      });
      const result = await flush({ driver: db, client });
      if (result.remaining > 0) {
        setNotice('Saved offline — it will sync when you reconnect.');
        return;
      }
      router.back();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not post the comment.');
    } finally {
      setBusy(false);
    }
  }, [body, taskId, client]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Add comment' }} />
      <TextInput
        style={styles.input}
        multiline
        placeholder="Write a comment about this task"
        placeholderTextColor={colors.muted}
        value={body}
        onChangeText={setBody}
        autoFocus
      />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <Pressable style={styles.save} onPress={save} disabled={busy}>
        {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.saveText}>Post comment</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 120,
    textAlignVertical: 'top',
    fontSize: 15,
    color: colors.text,
  },
  notice: { color: colors.danger, fontSize: 13, marginTop: spacing.md },
  save: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  saveText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
