import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { queueAttachment } from '../../capture/photo';
import { getCurrentCoords } from '../../capture/location';
import { flush } from '../../sync/engine';
import { colors, radius, spacing } from '../../theme';

export default function PhotoScreen() {
  const params = useLocalSearchParams<{ id: string; findingId?: string; itemId?: string }>();
  const taskId = Number(params.id);
  const { client } = useAuth();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const capture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const shot = await camera.current?.takePictureAsync({ quality: 0.6 });
      if (!shot?.uri) {
        setNotice('Could not capture the photo.');
        return;
      }
      let gps = null;
      try {
        gps = await getCurrentCoords();
      } catch {
        gps = null;
      }
      const db = await getDb();
      await queueAttachment(db, {
        taskId,
        sourceUri: shot.uri,
        findingId: params.findingId ? Number(params.findingId) : null,
        checklistItemId: params.itemId ? Number(params.itemId) : null,
        gps,
      });
      setQueued((count) => count + 1);
      const result = await flush({ driver: db, client });
      if (result.remaining > 0) {
        setNotice('Saved offline — photos upload when you reconnect.');
      } else {
        setNotice(null);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the photo.');
    } finally {
      setBusy(false);
    }
  }, [busy, taskId, params.findingId, params.itemId, client]);

  if (!permission) {
    return <ActivityIndicator style={styles.center} color={colors.primary} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Camera' }} />
        <Text style={styles.permissionText}>Camera access is needed to capture site photos.</Text>
        <Pressable style={styles.permissionButton} onPress={() => void requestPermission()}>
          <Text style={styles.permissionButtonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Capture photo' }} />
      <CameraView ref={camera} style={styles.camera} facing="back" />
      <View style={styles.bar}>
        <Text style={styles.count}>{queued > 0 ? `${queued} photo${queued > 1 ? 's' : ''} captured` : ' '}</Text>
        <Text style={styles.notice}>{notice ?? ' '}</Text>
        <Pressable style={styles.shutter} onPress={() => void capture()} disabled={busy}>
          {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.shutterText}>Take photo</Text>}
        </Pressable>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000000' },
  camera: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: spacing.xl,
  },
  permissionText: { fontSize: 15, color: colors.text, textAlign: 'center', marginBottom: spacing.lg },
  permissionButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  permissionButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  bar: { padding: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  count: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  notice: { color: colors.warning, fontSize: 13, textAlign: 'center' },
  shutter: {
    width: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  shutterText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  done: { color: '#ffffff', fontSize: 15, paddingVertical: spacing.sm },
});
