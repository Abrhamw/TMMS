import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
} from '@maplibre/maplibre-react-native';
import type { Feature, FeatureCollection } from 'geojson';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { listLines } from '../../db/queries';
import { pullMapData } from '../../sync/pull';
import { OSM_STYLE } from '../../map/osmStyle';
import type { MapLine, MapTower } from '../../api/mapTypes';
import { colors, radius, spacing } from '../../theme';

const ETHIOPIA_CENTER: [number, number] = [38.7469, 9.025];

function linesToGeoJson(lines: MapLine[]): FeatureCollection {
  const features: Array<Feature> = [];
  for (const line of lines) {
    if (!Array.isArray(line.route) || line.route.length < 2) continue;
    features.push({
      type: 'Feature',
      id: line.id,
      properties: { id: line.id, color: line.color ?? colors.primary, name: line.name ?? '' },
      geometry: {
        type: 'LineString',
        coordinates: line.route.map(([lat, lng]) => [lng, lat]),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function towersToGeoJson(towers: MapTower[], lineIds: Set<number>): FeatureCollection {
  const features: Array<Feature> = [];
  for (const tower of towers) {
    if (!lineIds.has(tower.line_id ?? -1)) continue;
    features.push({
      type: 'Feature',
      id: tower.id,
      properties: { id: tower.id, color: tower.color ?? '#334155', name: tower.tower_id ?? '' },
      geometry: { type: 'Point', coordinates: tower.position },
    });
  }
  return { type: 'FeatureCollection', features };
}

export default function MapScreen() {
  const { client } = useAuth();
  const [lines, setLines] = useState<MapLine[]>([]);
  const [towers, setTowers] = useState<MapTower[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const cached = await listLines(db);
      if (alive && cached.length > 0) {
        setLines(cached as unknown as MapLine[]);
        setLoading(false);
      }
      try {
        const data = await pullMapData(db, client);
        if (!alive) return;
        setLines(data.lines);
        setTowers(data.towers);
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
  }, [client]);

  const lineFeatures = useMemo(() => linesToGeoJson(lines), [lines]);
  const lineIds = useMemo(() => new Set(lines.map((line) => line.id)), [lines]);
  const towerFeatures = useMemo(() => towersToGeoJson(towers, lineIds), [towers, lineIds]);

  const initialCenter = useMemo<[number, number]>(() => {
    for (const line of lines) {
      if (line.route && line.route.length > 0) {
        const [lat, lng] = line.route[0]!;
        return [lng, lat];
      }
    }
    return ETHIOPIA_CENTER;
  }, [lines]);

  if (loading && lines.length === 0) {
    return <ActivityIndicator style={styles.loading} color={colors.primary} />;
  }

  return (
    <View style={styles.screen}>
      <Map mapStyle={OSM_STYLE} style={styles.map} logo={false} attribution compass>
        <Camera center={initialCenter} zoom={8} duration={0} />
        <GeoJSONSource id="lines" data={lineFeatures}>
          <Layer
            id="line-layer"
            type="line"
            paint={{ 'line-color': ['get', 'color'], 'line-width': 3 }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="towers" data={towerFeatures}>
          <Layer
            id="tower-layer"
            type="circle"
            minzoom={13}
            paint={{
              'circle-color': ['get', 'color'],
              'circle-radius': 3,
              'circle-stroke-width': 1,
              'circle-stroke-color': '#ffffff',
            }}
          />
        </GeoJSONSource>
      </Map>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Network overview</Text>
        <Text style={styles.panelMeta}>
          {lines.length} line{lines.length === 1 ? '' : 's'}
          {towers.length > 0 ? ` · ${towers.length} towers` : ''}
        </Text>
        {offline ? <Text style={styles.offline}>Offline — showing cached lines</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  map: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
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
  },
  panelTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  panelMeta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  offline: { fontSize: 12, color: colors.warning, marginTop: 2 },
});
