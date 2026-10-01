import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../../auth/context';
import { colors, radius, spacing } from '../../theme';

export default function SetupScreen() {
  const { serverUrl, signIn } = useAuth();
  const [url, setUrl] = useState(serverUrl ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = url.trim().length > 0 && username.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(url, username.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>TMMS Field</Text>
        <Text style={styles.subtitle}>Transmission maintenance, in the field</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Server address</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://tmms.example.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
          />

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="username"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            autoCapitalize="none"
            onSubmitEditing={submit}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            onPress={submit}
            disabled={!canSubmit}
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.hint}>
          Ask your administrator for the TMMS server address.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  brand: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.primaryDark,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    marginBottom: spacing.xs,
    marginTop: spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 16,
    color: colors.text,
    backgroundColor: '#fff',
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.md,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
    minHeight: 48,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  hint: {
    textAlign: 'center',
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing.lg,
  },
});
