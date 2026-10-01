import { useCallback, useState } from 'react';
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
import { getCurrentCoords } from '../../capture/location';
import type { GpsPoint } from '../../api/checklistTypes';
import { colors, radius, spacing } from '../../theme';

const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export default function FindingScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const taskId = Number(params.id);
  const { client } = useAuth();

  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [severity, setSeverity] = useState('MEDIUM');
  const [equipment, setEquipment] = useState('');
  const [gps, setGps] = useState<GpsPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const capture = useCallback(async () => {
    try {
      setGps(await getCurrentCoords());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not capture location');
    }
  }, []);

  const save = useCallback(async () => {
    if (!title.trim()) {
      setNotice('A finding title is required.');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const db = await getDb();
      await enqueue(db, {
        type: 'finding',
        entity: `task:${taskId}`,
        payload: {
          task_id: taskId,
          title: title.trim(),
          detail: detail.trim() || null,
          severity,
          equipment_name: equipment.trim() || null,
          lat: gps?.lat ?? null,
          lng: gps?.lng ?? null,
          captured_at: new Date().toISOString(),
        },
      });
      const result = await flush({ driver: db, client });
      if (result.remaining > 0) {
        setNotice('Saved offline — it will sync when you reconnect.');
        return;
      }
      router.back();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the finding.');
    } finally {
      setBusy(false);
    }
  }, [title, detail, severity, equipment, gps, taskId, client]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Log finding' }} />

      <Text style={styles.label}>Title</Text>
      <TextInput
        style={styles.input}
        placeholder="What did you find?"
        placeholderTextColor={colors.muted}
        value={title}
        onChangeText={setTitle}
      />

      <Text style={styles.label}>Severity</Text>
      <View style={styles.chips}>
        {SEVERITIES.map((option) => (
          <Pressable
            key={option}
            onPress={() => setSeverity(option)}
            style={[styles.chip, severity === option && styles.chipActive]}
          >
            <Text style={[styles.chipText, severity === option && styles.chipTextActive]}>{option}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Detail</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        multiline
        placeholder="Describe the issue (optional)"
        placeholderTextColor={colors.muted}
        value={detail}
        onChangeText={setDetail}
      />

      <Text style={styles.label}>Equipment (optional)</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. Insulator string"
        placeholderTextColor={colors.muted}
        value={equipment}
        onChangeText={setEquipment}
      />

      <Pressable style={styles.gpsButton} onPress={capture}>
        <Text style={styles.gpsButtonText}>
          {gps ? `Location: ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : 'Attach current location'}
        </Text>
      </Pressable>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <Pressable style={styles.save} onPress={save} disabled={busy}>
        {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.saveText}>Save finding</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  label: { fontSize: 13, fontWeight: '600', color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
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
  gpsButton: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  gpsButtonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
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
