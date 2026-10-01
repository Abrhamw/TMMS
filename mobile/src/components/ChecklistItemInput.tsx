import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { getCurrentCoords } from '../capture/location';
import { isCritical, isRequired, type ChecklistItem, type GpsPoint } from '../api/checklistTypes';
import { colors, radius, spacing } from '../theme';

interface ChoiceProps {
  options: Array<{ label: string; value: unknown }>;
  value: unknown;
  onSelect: (value: unknown) => void;
}

function Choice({ options, value, onSelect }: ChoiceProps) {
  return (
    <View style={styles.choiceRow}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onSelect(selected ? null : option.value)}
            style={[styles.choice, selected && styles.choiceSelected]}
          >
            <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function passOptions(item: ChecklistItem): string[] | null {
  const criteria = item.pass_criteria as { pass?: unknown; options?: unknown } | null;
  if (criteria && Array.isArray(criteria.options)) return criteria.options.map(String);
  if (criteria && Array.isArray(criteria.pass)) return criteria.pass.map(String);
  return null;
}

interface Props {
  item: ChecklistItem;
  value: unknown;
  comment: string;
  onValueChange: (value: unknown) => void;
  onCommentChange: (comment: string) => void;
}

export function ChecklistItemInput({ item, value, comment, onValueChange, onCommentChange }: Props) {
  const [capturing, setCapturing] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  async function captureGps() {
    setCapturing(true);
    setGpsError(null);
    try {
      const coords = await getCurrentCoords();
      onValueChange(coords satisfies GpsPoint);
    } catch (error) {
      setGpsError(error instanceof Error ? error.message : 'Could not capture location');
    } finally {
      setCapturing(false);
    }
  }

  const options = item.response_type === 'SELECT' ? passOptions(item) : null;
  const gps = item.response_type === 'GPS_POINT' ? (value as GpsPoint | null) : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.sequence}>{item.sequence}.</Text>
        <Text style={styles.instruction}>{item.instruction}</Text>
      </View>
      <View style={styles.tags}>
        {isRequired(item) ? <Text style={styles.tagRequired}>Required</Text> : null}
        {isCritical(item) ? <Text style={styles.tagCritical}>Critical</Text> : null}
        {item.test_equipment ? <Text style={styles.tagMeta}>{item.test_equipment}</Text> : null}
      </View>

      {item.response_type === 'YES_NO' || item.response_type === 'PASS_FAIL' ? (
        <Choice
          value={value}
          onSelect={onValueChange}
          options={[
            { label: 'Yes / Pass', value: true },
            { label: 'No / Fail', value: false },
          ]}
        />
      ) : null}

      {item.response_type === 'NUMERIC' ? (
        <TextInput
          style={styles.input}
          keyboardType="numeric"
          placeholder="Enter a number"
          placeholderTextColor={colors.muted}
          value={value === null || value === undefined ? '' : String(value)}
          onChangeText={(text) => onValueChange(text === '' ? null : text)}
        />
      ) : null}

      {item.response_type === 'TEXT' || item.response_type === 'PHOTO' ? (
        <TextInput
          style={[styles.input, styles.multiline]}
          multiline
          placeholder="Enter a response"
          placeholderTextColor={colors.muted}
          value={value === null || value === undefined ? '' : String(value)}
          onChangeText={onValueChange}
        />
      ) : null}

      {options ? (
        <Choice
          value={value}
          onSelect={onValueChange}
          options={options.map((option) => ({ label: option, value: option }))}
        />
      ) : null}

      {item.response_type === 'GPS_POINT' ? (
        <View>
          <Pressable style={styles.gpsButton} onPress={captureGps} disabled={capturing}>
            {capturing ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={styles.gpsButtonText}>{gps ? 'Recapture location' : 'Capture current location'}</Text>
            )}
          </Pressable>
          {gps ? (
            <Text style={styles.gpsValue}>
              {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
              {gps.accuracy_m != null ? ` · ±${Math.round(gps.accuracy_m)}m` : ''}
            </Text>
          ) : null}
          {gpsError ? <Text style={styles.gpsError}>{gpsError}</Text> : null}
        </View>
      ) : null}

      <TextInput
        style={[styles.input, styles.note]}
        placeholder="Note (optional)"
        placeholderTextColor={colors.muted}
        value={comment}
        onChangeText={onCommentChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  header: { flexDirection: 'row', gap: spacing.sm },
  sequence: { fontSize: 14, fontWeight: '700', color: colors.muted },
  instruction: { flex: 1, fontSize: 15, color: colors.text, lineHeight: 21 },
  tags: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  tagRequired: { fontSize: 11, color: colors.warning, fontWeight: '600' },
  tagCritical: { fontSize: 11, color: colors.danger, fontWeight: '600' },
  tagMeta: { fontSize: 11, color: colors.muted },
  choiceRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  choice: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  choiceSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceText: { fontSize: 14, color: colors.text },
  choiceTextSelected: { color: '#ffffff', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
    marginTop: spacing.sm,
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  note: { fontSize: 13 },
  gpsButton: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  gpsButtonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  gpsValue: { fontSize: 13, color: colors.success, marginTop: spacing.xs },
  gpsError: { fontSize: 12, color: colors.danger, marginTop: spacing.xs },
});
