import L from 'leaflet';

// Selectable base maps. Kept dependency-free (plain XYZ tiles) so the map works
// with the existing leaflet install. `subdomains` defaults to 'abc' in Leaflet,
// so only set it when the provider expects a different set.
export const BASE_LAYERS = [
  {
    key: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  },
  {
    key: 'streets',
    label: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  {
    key: 'light',
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
    subdomains: 'abcd',
  },
  {
    key: 'dark',
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
    subdomains: 'abcd',
  },
  {
    key: 'terrain',
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  },
];

export const DEFAULT_BASE_KEY = 'satellite';

export function baseLayerDef(key) {
  return BASE_LAYERS.find((b) => b.key === key) || BASE_LAYERS[0];
}

export function createBaseLayer(key) {
  const def = baseLayerDef(key);
  const opts = { attribution: def.attribution, maxZoom: def.maxZoom };
  if (def.subdomains) opts.subdomains = def.subdomains;
  return L.tileLayer(def.url, opts);
}

// Fullscreen helpers that also nudge Leaflet to re-measure once the element
// changes size, otherwise the tiles blank out after the transition.
export function toggleFullscreen(el) {
  if (!el) return;
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
  } else if (el.requestFullscreen) {
    el.requestFullscreen();
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  }
}
