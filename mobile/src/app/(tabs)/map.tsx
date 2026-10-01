import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
} from '@maplibre/maplibre-react-native';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { Feature, FeatureCollection } from 'geojson';
import { useAuth } from '../../auth/context';
import { getDb } from '../../db';
import { listLines } from '../../db/queries';
import { pullMapData } from '../../sync/pull';
import { OSM_STYLE } from '../../map/osmStyle';
import { cacheLineTiles, cachedLineIds, styleFileUri } from '../../map/offline';
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
  const [mapStyle, setMapStyle] = useState<string | StyleSpecification>(OSM_STYLE);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void styleFileUri()
      .then((uri) => {
        if (alive) setMapStyle(uri);
      })
      .catch(() => {
        /* fall back to the inline style when the file cannot be written */
      });
    void cachedLineIds().then((ids) => {
      if (alive) setSaved(ids);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  const cacheableLines = useMemo(
    () => lines.filter((line) => Array.isArray(line.route) && line.route.length >= 2),
    [lines],
  );

  const saveOffline = useCallback(async () => {
    setSaving(true);
    setNotice(null);
    const next = new Set(saved);
    let added = 0;
    try {
      for (const line of cacheableLines) {
        if (next.has(line.id)) continue;
        const created = await cacheLineTiles(line, (update) => {
          setProgress((prev) => ({ ...prev, [update.lineId]: update.percentage }));
        });
        if (created) {
          next.add(line.id);
          added += 1;
        }
      }
      setSaved(next);
      setNotice(
        added > 0
          ? `Saving ${added} line${added === 1 ? '' : 's'} for offline use.`
          : 'All lines are already saved offline.',
      );
    } catch {
      setNotice('Could not start the offline download.');
    } finally {
      setSaving(false);
    }
  }, [cacheableLines, saved]);

  const activePercent = useMemo(() => {
    const values = Object.values(progress).filter((value) => value > 0 && value < 100);
    if (values.length === 0) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }, [progress]);

  if (loading && lines.length === 0) {
    return <ActivityIndicator style={styles.loading} color={colors.primary} />;
  }

  return (
    <View style={styles.screen}>
      <Map mapStyle={mapStyle} style={styles.map} logo={false} attribution compass>
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
          {` · ${saved.size} offline`}
        </Text>
        {offline ? <Text style={styles.offline}>Offline — showing cached lines</Text> : null}
        {activePercent != null ? (
          <Text style={styles.offline}>Downloading tiles {activePercent}%</Text>
        ) : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Pressable
          style={[styles.save, saving && styles.saveDisabled]}
          onPress={() => void saveOffline()}
          disabled={saving || cacheableLines.length === 0}
        >
          <Text style={styles.saveText}>
            {saving ? 'Saving tiles…' : 'Save map offline'}
          </Text>
        </Pressable>
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
  notice: { fontSize: 12, color: colors.muted, marginTop: 2 },
  save: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  saveDisabled: { opacity: 0.6 },
  saveText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
});
