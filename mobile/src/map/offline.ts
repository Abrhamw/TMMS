import { Directory, File, Paths } from 'expo-file-system';
import { OfflineManager, type OfflinePack } from '@maplibre/maplibre-react-native';
import type { MapLine } from '../api/mapTypes';
import { boundsForLine } from './bbox';
import { OSM_STYLE } from './osmStyle';

export const OFFLINE_MIN_ZOOM = 8;
export const OFFLINE_MAX_ZOOM = 13;
export const OFFLINE_TILE_LIMIT = 4000;
export const OFFLINE_PACK_PREFIX = 'line';

let styleUriPromise: Promise<string> | null = null;

export function styleFileUri(): Promise<string> {
  if (!styleUriPromise) {
    styleUriPromise = Promise.resolve().then(() => {
      const dir = new Directory(Paths.document, 'map');
      dir.create({ intermediates: true, idempotent: true });
      const file = new File(dir, 'osm-style.json');
      file.write(JSON.stringify(OSM_STYLE));
      return file.uri;
    });
  }
  return styleUriPromise;
}

export interface OfflineProgress {
  lineId: number;
  percentage: number;
  state: string;
}

function packLineId(pack: OfflinePack): number | null {
  const value = pack.metadata?.line_id;
  return value == null ? null : Number(value);
}

export async function cachedLineIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const packs = await OfflineManager.getPacks();
    for (const pack of packs) {
      const id = packLineId(pack);
      if (id != null) ids.add(id);
    }
  } catch {
    /* native offline storage is unavailable in some runtimes */
  }
  return ids;
}

export async function cacheLineTiles(
  line: MapLine,
  onProgress?: (progress: OfflineProgress) => void,
): Promise<boolean> {
  if (!boundsForLine(line)) return false;
  try {
    OfflineManager.setTileCountLimit(OFFLINE_TILE_LIMIT);
  } catch {
    /* the tile-count setter is best-effort */
  }
  const existing = await cachedLineIds();
  if (existing.has(line.id)) return false;
  const mapStyle = await styleFileUri();
  await OfflineManager.createPack(
    {
      mapStyle,
      bounds: boundsForLine(line)!,
      minZoom: OFFLINE_MIN_ZOOM,
      maxZoom: OFFLINE_MAX_ZOOM,
      metadata: { line_id: line.id, name: line.name ?? `Line ${line.id}` },
    },
    (pack, status) => {
      onProgress?.({
        lineId: packLineId(pack) ?? line.id,
        percentage: status.percentage,
        state: status.state,
      });
    },
    () => onProgress?.({ lineId: line.id, percentage: 0, state: 'error' }),
  );
  return true;
}
