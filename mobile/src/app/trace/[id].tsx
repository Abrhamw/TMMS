import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import type { FeatureCollection } from 'geojson';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import type { SqlDriver } from '../../db/driver';
import { getTask, listLines } from '../../db/queries';
import { queueTrace, type TracePoint } from '../../capture/trace';
import { formatDistance, totalDistanceMeters } from '../../capture/geo';
import { flush } from '../../sync/engine';
import { OSM_STYLE } from '../../map/osmStyle';
import { colors, radius, spacing } from '../../theme';

const FLUSH_EVERY = 50;

function breadcrumbGeoJson(points: TracePoint[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      points.length > 1
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: points.map((point) => [point.lng, point.lat]),
              },
            },
          ]
        : [],
  };
}

function routeGeoJson(route: Array<[number, number]>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      route.length > 1
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: route.map(([lat, lng]) => [lng, lat]),
              },
            },
          ]
        : [],
  };
}

export default function TraceScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const taskId = Number(params.id);
  const { client } = useAuth();

  const dbRef = useRef<SqlDriver | null>(null);
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const bufferRef = useRef<TracePoint[]>([]);
  const [points, setPoints] = useState<TracePoint[]>([]);
  const [route, setRoute] = useState<Array<[number, number]>>([]);
  const [crewId, setCrewId] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const db = await getDb();
      dbRef.current = db;
      const task = await getTask(db, taskId);
      setCrewId(task?.crew_id ?? null);
      if (task?.line_id) {
        const lines = await listLines(db);
        const line = lines.find((candidate) => candidate.id === task.line_id);
        if (line?.route) setRoute(line.route);
      }
    })();
    return () => {
      subRef.current?.remove();
      subRef.current = null;
    };
  }, [taskId]);

  const flushPoints = useCallback(
    async (batch: TracePoint[]) => {
      if (batch.length === 0) return;
      const db = dbRef.current ?? (await getDb());
      await queueTrace(db, { taskId, crewId, points: batch });
      await flush({ driver: db, client });
    },
    [taskId, crewId, client],
  );

  const onUpdate = useCallback(
    (location: Location.LocationObject) => {
      const point: TracePoint = {
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        accuracy_m: location.coords.accuracy ?? null,
        recorded_at: new Date(location.timestamp).toISOString(),
      };
      bufferRef.current.push(point);
      setPoints((prev) => [...prev, point]);
      if (bufferRef.current.length >= FLUSH_EVERY) {
        const batch = bufferRef.current;
        bufferRef.current = [];
        void flushPoints(batch);
      }
    },
    [flushPoints],
  );

  const start = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setNotice('Location permission is required to trace the route.');
        return;
      }
      subRef.current = await Location.watchPositionAsync(
        { accuracy: Location.LocationAccuracy.High, distanceInterval: 10, timeInterval: 15000 },
        onUpdate,
      );
      setRecording(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start tracing.');
    } finally {
      setBusy(false);
    }
  }, [onUpdate]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      subRef.current?.remove();
      subRef.current = null;
      setRecording(false);
      const batch = bufferRef.current;
      bufferRef.current = [];
      await flushPoints(batch);
      setNotice('Trace saved — it syncs when you have a connection.');
    } finally {
      setBusy(false);
    }
  }, [flushPoints]);

  const distance = useMemo(() => totalDistanceMeters(points), [points]);
  const breadcrumb = useMemo(() => breadcrumbGeoJson(points), [points]);
  const routeFeatures = useMemo(() => routeGeoJson(route), [route]);
  const center = useMemo<[number, number]>(() => {
    const first = points[0] ?? (route[0] ? { lat: route[0][0], lng: route[0][1] } : null);
    return first ? [first.lng, first.lat] : [38.7469, 9.025];
  }, [points, route]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Route tracing' }} />
      <Map mapStyle={OSM_STYLE} style={styles.map} logo={false} attribution compass>
        <Camera center={center} zoom={points.length > 0 ? 14 : 11} duration={400} />
        <GeoJSONSource id="route" data={routeFeatures}>
          <Layer
            id="route-line"
            type="line"
            paint={{ 'line-color': colors.primary, 'line-width': 3 }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="breadcrumb" data={breadcrumb}>
          <Layer
            id="breadcrumb-line"
            type="line"
            paint={{ 'line-color': colors.success, 'line-width': 4 }}
          />
        </GeoJSONSource>
      </Map>

      <View style={styles.panel}>
        <Text style={styles.stats}>
          {recording ? 'Recording' : 'Idle'} · {formatDistance(distance)} · {points.length} points
        </Text>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Pressable
          style={[styles.button, recording ? styles.stop : styles.start]}
          onPress={() => void (recording ? stop() : start())}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.buttonText}>{recording ? 'Stop tracing' : 'Start tracing'}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  map: { flex: 1 },
  panel: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  stats: { fontSize: 14, fontWeight: '600', color: colors.text },
  notice: { fontSize: 12, color: colors.muted },
  button: { borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  start: { backgroundColor: colors.primary },
  stop: { backgroundColor: colors.danger },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
