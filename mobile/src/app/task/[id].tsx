import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { getTaskDetail } from '../../db/queries';
import { pullTaskDetail } from '../../sync/pull';
import { StatusChip } from '../../components/StatusChip';
import { BulletList, Field, Section } from '../../components/Section';
import { targetLabel, type TaskDetail } from '../../api/taskTypes';
import { colors, radius, spacing } from '../../theme';

function fmtDate(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  return iso.slice(0, 16).replace('T', ' ');
}

export default function TaskDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Number(params.id);
  const { client } = useAuth();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const loadLocal = useCallback(async () => {
    const db = await getDb();
    return getTaskDetail<TaskDetail>(db, id);
  }, [id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const cached = await loadLocal();
      if (active && cached) setDetail(cached);
      if (active) setLoading(false);
      try {
        const db = await getDb();
        const fresh = (await pullTaskDetail(db, client, id)) as unknown as TaskDetail;
        if (active) {
          setDetail(fresh);
          setOffline(false);
        }
      } catch {
        if (active) setOffline(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, client, loadLocal]);

  if (loading && !detail) {
    return <ActivityIndicator style={styles.loading} color={colors.primary} />;
  }
  if (!detail) {
    return (
      <View style={styles.loading}>
        <Text style={styles.muted}>Not available offline yet. Reconnect and reopen.</Text>
      </View>
    );
  }

  const readiness = detail.readiness;
  const templates = detail.checklist_templates ?? [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: detail.task_number ?? 'Task' }} />

      <View style={styles.headerRow}>
        <StatusChip status={detail.status} />
        <StatusChip status={detail.priority} />
      </View>
      <Text style={styles.title}>{detail.title ?? 'Untitled task'}</Text>
      {offline ? <Text style={styles.offline}>Offline — showing saved detail</Text> : null}

      <Section title="Target">
        <Field label="Location" value={targetLabel(detail.target, detail.line)} />
        <Field label="Crew" value={detail.crew?.name} />
        <Field label="Region" value={detail.region?.name} />
      </Section>

      <Section title="Schedule">
        <Field label="Due" value={detail.due_date?.slice(0, 10)} />
        <Field label="Scheduled start" value={fmtDate(detail.scheduled_start)} />
        <Field label="Started" value={fmtDate(detail.actual_start)} />
      </Section>

      {detail.description ? (
        <Section title="Description">
          <Text style={styles.body}>{detail.description}</Text>
        </Section>
      ) : null}

      {readiness ? (
        <Section title="Readiness">
          <Field label="Eligible" value={readiness.eligible ? 'Yes' : 'Not yet'} />
          <Text style={styles.subheading}>Equipment to secure</Text>
          <BulletList items={readiness.equipment_to_secure ?? []} empty="None listed" />
          {readiness.missing_certs && readiness.missing_certs.length > 0 ? (
            <>
              <Text style={styles.subheading}>Missing certifications</Text>
              <BulletList items={readiness.missing_certs} />
            </>
          ) : null}
          {readiness.warnings && readiness.warnings.length > 0 ? (
            <>
              <Text style={styles.subheading}>Warnings</Text>
              <BulletList items={readiness.warnings} />
            </>
          ) : null}
        </Section>
      ) : null}

      <Section title="Checklists">
        {templates.length === 0 ? (
          <Text style={styles.muted}>No checklist templates.</Text>
        ) : (
          templates.map((t) => (
            <Pressable
              key={t.id}
              style={styles.template}
              onPress={() =>
                router.push({
                  pathname: '/checklist/[id]',
                  params: { id: String(detail.id), templateId: String(t.id) },
                })
              }
            >
              <Text style={styles.templateName}>{t.name ?? t.code ?? `Template ${t.id}`}</Text>
              <Text style={styles.templateMeta}>
                {[t.code, t.estimated_minutes ? `${t.estimated_minutes} min` : null, t.is_mandatory ? 'Mandatory' : null]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
              <Text style={styles.templateAction}>Open checklist ›</Text>
            </Pressable>
          ))
        )}
      </Section>

      <Section title="Capture">
        <Pressable
          style={styles.action}
          onPress={() => router.push({ pathname: '/photo/[id]', params: { id: String(detail.id) } })}
        >
          <Text style={styles.actionText}>Take a photo</Text>
        </Pressable>
        {detail.line?.id ? (
          <Pressable
            style={styles.action}
            onPress={() => router.push({ pathname: '/trace/[id]', params: { id: String(detail.id) } })}
          >
            <Text style={styles.actionText}>Trace the line</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.action}
          onPress={() => router.push({ pathname: '/finding/[id]', params: { id: String(detail.id) } })}
        >
          <Text style={styles.actionText}>Log a finding</Text>
        </Pressable>
        <Pressable
          style={styles.action}
          onPress={() => router.push({ pathname: '/comment/[id]', params: { id: String(detail.id) } })}
        >
          <Text style={styles.actionText}>Add a comment</Text>
        </Pressable>
      </Section>

      <Section title="Activity">
        <Field label="Findings" value={(detail.findings ?? []).length} />
        <Field label="Attachments" value={(detail.attachments ?? []).length} />
        <Field label="Executions" value={(detail.executions ?? []).length} />
        <Field label="GPS validations" value={(detail.gps_validations ?? []).length} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: spacing.xl },
  muted: { color: colors.muted, fontSize: 14 },
  headerRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  offline: { color: colors.warning, fontSize: 12, marginBottom: spacing.sm },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  subheading: { fontSize: 13, fontWeight: '600', color: colors.text, marginTop: spacing.sm, marginBottom: 2 },
  template: { paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border },
  templateName: { fontSize: 15, color: colors.text, fontWeight: '600' },
  templateMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  templateAction: { fontSize: 13, color: colors.primary, marginTop: 2, fontWeight: '600' },
  action: {
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  actionText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
});
