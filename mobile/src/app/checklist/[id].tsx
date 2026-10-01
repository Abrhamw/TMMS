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
import { Stack, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { enqueue } from '../../db/outbox';
import { getChecklist } from '../../db/queries';
import { flush } from '../../sync/engine';
import { pullChecklist } from '../../sync/pull';
import { ChecklistItemInput } from '../../components/ChecklistItemInput';
import { getCurrentCoords } from '../../capture/location';
import type {
  ChecklistResponse,
  ChecklistSubmitItem,
  ChecklistTemplate,
} from '../../api/checklistTypes';
import { colors, radius, spacing } from '../../theme';

interface ItemState {
  response_value: unknown;
  comment: string;
}

function draftItemStates(template: ChecklistTemplate): Record<number, ItemState> {
  const states: Record<number, ItemState> = {};
  for (const item of template.items) {
    states[item.id] = { response_value: null, comment: '' };
  }
  if (template.draft?.items) {
    for (const saved of template.draft.items) {
      const item = template.items.find(
        (candidate) =>
          candidate.id === saved.template_item_id || candidate.sequence === saved.sequence,
      );
      if (item) {
        states[item.id] = {
          response_value: saved.response_value ?? null,
          comment: saved.comment ?? '',
        };
      }
    }
  }
  return states;
}

function unansweredRequired(template: ChecklistTemplate, states: Record<number, ItemState>): number {
  return template.items.filter((item) => {
    const required = item.required === true || item.required === 1;
    if (!required || item.response_type === 'GPS_POINT') return false;
    const value = states[item.id]?.response_value;
    return value === null || value === undefined || value === '';
  }).length;
}

export default function ChecklistScreen() {
  const params = useLocalSearchParams<{ id: string; templateId?: string }>();
  const id = Number(params.id);
  const { client } = useAuth();

  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [states, setStates] = useState<Record<number, ItemState>>({});
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const active = useMemo(
    () => templates.find((template) => template.id === activeId) ?? templates[0] ?? null,
    [templates, activeId],
  );

  const selectTemplate = useCallback((template: ChecklistTemplate) => {
    setActiveId(template.id);
    setStates(draftItemStates(template));
    setNotes(template.draft?.notes ?? '');
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const cached = await getChecklist<ChecklistTemplate>(db, id);
      if (alive && cached.length > 0) {
        const loaded = cached.map((row) => row.payload);
        setTemplates(loaded);
        const preferred =
          loaded.find((template) => String(template.id) === params.templateId) ?? loaded[0];
        if (preferred) {
          setActiveId(preferred.id);
          setStates(draftItemStates(preferred));
          setNotes(preferred.draft?.notes ?? '');
        }
        setLoading(false);
      }
      try {
        const fresh = await pullChecklist(db, client, id);
        if (!alive) return;
        const loaded = fresh.templates ?? [];
        setTemplates(loaded);
        const preferred =
          loaded.find((template) => String(template.id) === params.templateId) ?? loaded[0];
        if (preferred) {
          setActiveId(preferred.id);
          setStates(draftItemStates(preferred));
          setNotes(preferred.draft?.notes ?? '');
        }
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, client, params.templateId]);

  const submitItems = useCallback(
    (template: ChecklistTemplate): ChecklistSubmitItem[] =>
      template.items.map((item) => ({
        template_item_id: item.id,
        sequence: item.sequence,
        response_value: states[item.id]?.response_value ?? null,
        comment: states[item.id]?.comment || null,
      })),
    [states],
  );

  const saveDraft = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    setNotice(null);
    try {
      const db = await getDb();
      await enqueue(db, {
        type: 'checklist_draft',
        entity: `task:${id}:tpl:${active.id}`,
        payload: {
          task_id: id,
          template_id: active.id,
          notes,
          items: submitItems(active),
        },
      });
      const result = await flush({ driver: db, client });
      setNotice(
        result.remaining > 0
          ? 'Draft saved offline — it will sync when you reconnect.'
          : 'Draft saved.',
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save draft.');
    } finally {
      setBusy(false);
    }
  }, [active, id, notes, submitItems, client]);

  const submitRun = useCallback(async () => {
    if (!active) return;
    const missing = unansweredRequired(active, states);
    if (missing > 0) {
      setNotice(`${missing} required item${missing > 1 ? 's are' : ' is'} still unanswered.`);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      let finishGps: Awaited<ReturnType<typeof getCurrentCoords>> | null = null;
      try {
        finishGps = await getCurrentCoords();
      } catch {
        finishGps = null;
      }
      const db = await getDb();
      await enqueue(db, {
        type: 'checklist_submit',
        entity: `task:${id}:tpl:${active.id}`,
        payload: {
          task_id: id,
          template_id: active.id,
          notes,
          items: submitItems(active),
          finish_gps: finishGps,
        },
      });
      const result = await flush({ driver: db, client });
      setNotice(
        result.remaining > 0
          ? 'Checklist queued — it will submit when you reconnect.'
          : 'Checklist submitted.',
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not submit checklist.');
    } finally {
      setBusy(false);
    }
  }, [active, states, id, notes, submitItems, client]);

  if (loading && templates.length === 0) {
    return <ActivityIndicator style={styles.loading} color={colors.primary} />;
  }
  if (!active) {
    return (
      <View style={styles.loading}>
        <Text style={styles.muted}>
          {offline ? 'No saved checklist yet. Reconnect and reopen.' : 'This task has no checklist.'}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: active.name ?? 'Checklist' }} />

      {templates.length > 1 ? (
        <View style={styles.tabs}>
          {templates.map((template) => (
            <Pressable
              key={template.id}
              onPress={() => selectTemplate(template)}
              style={[styles.tab, template.id === active.id && styles.tabActive]}
            >
              <Text style={[styles.tabText, template.id === active.id && styles.tabTextActive]}>
                {template.name ?? template.code ?? `Template ${template.id}`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {offline ? <Text style={styles.offline}>Offline — showing saved checklist</Text> : null}
      {active.draft ? (
        <Text style={styles.draft}>Draft from {active.draft.updated_at?.slice(0, 16).replace('T', ' ')}</Text>
      ) : null}

      {active.items.map((item) => (
        <ChecklistItemInput
          key={item.id}
          item={item}
          value={states[item.id]?.response_value ?? null}
          comment={states[item.id]?.comment ?? ''}
          onValueChange={(value) =>
            setStates((prev) => ({
              ...prev,
              [item.id]: { response_value: value, comment: prev[item.id]?.comment ?? '' },
            }))
          }
          onCommentChange={(comment) =>
            setStates((prev) => ({
              ...prev,
              [item.id]: { response_value: prev[item.id]?.response_value ?? null, comment },
            }))
          }
        />
      ))}

      <Text style={styles.label}>Run notes</Text>
      <TextInput
        style={styles.notes}
        multiline
        placeholder="Notes for the whole run (optional)"
        placeholderTextColor={colors.muted}
        value={notes}
        onChangeText={setNotes}
      />

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <View style={styles.actions}>
        <Pressable style={[styles.button, styles.secondary]} onPress={saveDraft} disabled={busy}>
          <Text style={styles.secondaryText}>Save draft</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.primary]} onPress={submitRun} disabled={busy}>
          <Text style={styles.primaryText}>{busy ? 'Working…' : 'Submit checklist'}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: spacing.xl,
  },
  muted: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  tabs: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontSize: 13, color: colors.text },
  tabTextActive: { color: '#ffffff', fontWeight: '600' },
  offline: { color: colors.warning, fontSize: 12, marginBottom: spacing.sm },
  draft: { color: colors.muted, fontSize: 12, marginBottom: spacing.sm },
  label: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: spacing.xs },
  notes: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: 72,
    textAlignVertical: 'top',
    fontSize: 14,
    color: colors.text,
  },
  notice: { color: colors.primaryDark, fontSize: 13, marginTop: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  button: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  primary: { backgroundColor: colors.primary },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
