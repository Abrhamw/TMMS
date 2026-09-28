import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { asLatLngs, flyToPoints, mapSizeReady, pulseIcon, flashIcon } from '../mapFocus';
import { BASE_LAYERS, DEFAULT_BASE_KEY, createBaseLayer, toggleFullscreen } from '../mapBase';
import MapSearchBox from './MapSearchBox';
import MapLegend from './MapLegend';
import { t } from '../i18n';

function centroid(points) {
  const pts = asLatLngs(points);
  if (!pts.length) return null;
  let lat = 0;
  let lng = 0;
  pts.forEach((p) => { lat += p[0]; lng += p[1]; });
  return { lat: lat / pts.length, lng: lng / pts.length };
}

function sigOf(points) {
  return asLatLngs(points).map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('|');
}

function markerPopup(m) {
  if (m.popup) return m.popup;
  if (!m.label) return null;
  return `<b>${m.label}</b>${m.sub ? `<br/><span style="font-size:11px">${m.sub}</span>` : ''}`;
}

// Read-only Leaflet map for detail views. Renders markers, polylines, polygons
// and an optional tolerance radius. Animates a perfect-fit zoom to the entity
// under focus (line route, substation yard, region boundary or a tower).
export default function ViewMap({
  center,
  zoom = 8,
  markers = [],
  polylines = [],
  polygons = [],
  circles = [],
  radius = null,
  radiusLatLng = null,
  fit = true,
  height = 320,
  maxWidth = 760,
  fitPadding = [40, 40],
  focus = null,
  focusKey = null,
  focusMaxZoom = 16,
  controls = true,
  legend = null,
  defaultBase = DEFAULT_BASE_KEY,
}) {
  const elRef = useRef(null);
  const wrapRef = useRef(null);
  const mapRef = useRef(null);
  const baseLayerRef = useRef(null);
  const flownRef = useRef(null);
  const pendingRef = useRef(null);
  const flushRef = useRef(() => {});
  const layersRef = useRef(new Map());
  const [baseKey, setBaseKey] = useState(defaultBase);
  const [isFull, setIsFull] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, {
      zoomControl: true,
      attributionControl: false,
      scrollWheelZoom: true,
      dragging: true,
    });
    mapRef.current = map;
    flownRef.current = null;
    const init = center || { lat: 9.0, lng: 39.0 };
    map.setView([init.lat, init.lng], zoom);
    const flush = () => {
      const job = pendingRef.current;
      if (!job || !mapSizeReady(map)) return;
      pendingRef.current = null;
      flyToPoints(map, job.target, job.opts);
    };
    flushRef.current = flush;
    const onResize = () => { map.invalidateSize(); flush(); };
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(elRef.current);
    }
    const t1 = setTimeout(onResize, 80);
    const t2 = setTimeout(onResize, 400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (ro) ro.disconnect();
      flushRef.current = () => {};
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (baseLayerRef.current) map.removeLayer(baseLayerRef.current);
    const layer = createBaseLayer(baseKey);
    layer.addTo(map);
    layer.bringToBack();
    baseLayerRef.current = layer;
  }, [baseKey]);

  useEffect(() => {
    const onResize = () => {
      const map = mapRef.current;
      if (map) setTimeout(() => { map.invalidateSize(); flushRef.current(); }, 120);
    };
    const onFullscreen = () => {
      setIsFull(!!document.fullscreenElement);
      onResize();
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup();
    layersRef.current = new Map();
    const register = (id, l) => { if (id) layersRef.current.set(id, l); };

    (polygons || []).forEach((p, i) => {
      if (!p.points || p.points.length < 3) return;
      const w = p.weight || 1.5;
      const fill = p.fillOpacity ?? 0.08;
      const poly = L.polygon(p.points, {
        color: p.color || '#2563eb',
        weight: w,
        fillColor: p.color || '#2563eb',
        fillOpacity: fill,
      });
      poly.on('mouseover', () => poly.setStyle({ weight: w + 2, fillOpacity: Math.min(0.3, fill + 0.08) }));
      poly.on('mouseout', () => poly.setStyle({ weight: w, fillOpacity: fill }));
      poly.bindPopup(p.popup || `<b>${p.label || 'Boundary'}</b>`).addTo(layer);
      register(`poly-${i}`, poly);
    });

    (polylines || []).forEach((p, i) => {
      if (!p.points || p.points.length < 2) return;
      const w = p.weight || 3;
      const cls = [p.flash ? 'tmms-target-line' : null, p.animate ? 'tmms-related-line' : null].filter(Boolean).join(' ');
      const line = L.polyline(p.points, {
        color: p.color || '#b45309',
        weight: w,
        dashArray: p.dashArray || null,
        className: cls || null,
      });
      line.on('mouseover', () => line.setStyle({ weight: w + 2 }));
      line.on('mouseout', () => line.setStyle({ weight: w }));
      line.bindPopup(p.popup || `<b>${p.label || 'Route'}</b>`).addTo(layer);
      register(`line-${i}`, line);
    });

    (circles || []).forEach((c, i) => {
      if (c.lat == null || c.lng == null || !(Number(c.radius) > 0)) return;
      const w = c.weight || 1.5;
      const fill = c.fillOpacity ?? 0.06;
      const circle = L.circle([c.lat, c.lng], {
        radius: c.radius,
        color: c.color || '#2563eb',
        weight: w,
        dashArray: c.dashArray || null,
        fillColor: c.color || '#2563eb',
        fillOpacity: fill,
      });
      circle.on('mouseover', () => circle.setStyle({ weight: w + 2, fillOpacity: Math.min(0.3, fill + 0.08) }));
      circle.on('mouseout', () => circle.setStyle({ weight: w, fillOpacity: fill }));
      if (c.popup) circle.bindPopup(c.popup);
      circle.addTo(layer);
      register(`circle-${i}`, circle);
    });

    (markers || []).forEach((m, i) => {
      if (m.lat === null || m.lat === undefined || m.lng === null || m.lng === undefined) return;
      if (m.flash) {
        const g = L.marker([m.lat, m.lng], { icon: flashIcon(m.color, m.radius ? m.radius * 2.6 : 20), zIndexOffset: 600 });
        const label = markerPopup(m);
        if (label) g.bindPopup(label);
        g.addTo(layer);
        register(`marker-${i}`, g);
        return;
      }
      if (m.pulse) {
        const g = L.marker([m.lat, m.lng], { icon: pulseIcon(m.color, m.radius ? m.radius * 2.6 : 16), zIndexOffset: 500 });
        const label = markerPopup(m);
        if (label) g.bindPopup(label);
        g.addTo(layer);
        register(`marker-${i}`, g);
        return;
      }
      const r = m.radius || 6;
      const g = L.circleMarker([m.lat, m.lng], {
        radius: r,
        color: '#fff',
        weight: 1.5,
        fillColor: m.color || '#14532d',
        fillOpacity: 0.95,
      });
      g.on('mouseover', () => g.setStyle({ radius: r + 2, weight: 2.5 }));
      g.on('mouseout', () => g.setStyle({ radius: r, weight: 1.5 }));
      const label = markerPopup(m);
      if (label) g.bindPopup(label);
      g.addTo(layer);
      register(`marker-${i}`, g);
    });

    if (radius && radius > 0 && radiusLatLng) {
      L.circle([radiusLatLng.lat, radiusLatLng.lng], {
        radius,
        color: '#2563eb',
        weight: 1.5,
        dashArray: '5 5',
        fillColor: '#2563eb',
        fillOpacity: 0.06,
      }).addTo(layer);
    }

    layer.addTo(map);
    if (fit) {
      const focusPts = asLatLngs(focus);
      const pts = [];
      (polygons || []).forEach((p) => (p.points || []).forEach((pt) => pts.push(pt)));
      (polylines || []).forEach((p) => (p.points || []).forEach((pt) => pts.push(pt)));
      (markers || []).forEach((m) => { if (m.lat != null && m.lng != null) pts.push([m.lat, m.lng]); });
      (circles || []).forEach((c) => { if (c.lat != null && c.lng != null) pts.push([c.lat, c.lng]); });
      if (radius && radiusLatLng) pts.push([radiusLatLng.lat, radiusLatLng.lng]);
      const target = focusPts.length ? focusPts : pts;
      const sig = `${focusKey || ''}::${sigOf(target)}`;
      if (sig !== flownRef.current && target.length) {
        flownRef.current = sig;
        pendingRef.current = {
          target,
          opts: {
            maxZoom: focusPts.length ? focusMaxZoom : 13,
            padding: fitPadding,
            duration: 0.7,
            singleZoom: focusPts.length ? focusMaxZoom : 13,
          },
        };
        flushRef.current();
      }
    }
    return () => layer.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, polylines, polygons, circles, radius, radiusLatLng, fit, focus, focusKey]);

  const searchItems = useMemo(() => {
    const items = [];
    (polygons || []).forEach((p, i) => {
      if (p.points && p.points.length >= 3) items.push({ key: `poly-${i}`, id: `poly-${i}`, type: t('mapItemBoundary'), label: p.label, meta: p.sub || '', color: p.color, at: centroid(p.points) });
    });
    (polylines || []).forEach((p, i) => {
      if (p.points && p.points.length >= 2) items.push({ key: `line-${i}`, id: `line-${i}`, type: t('mapItemRoute'), label: p.label, meta: p.sub || '', color: p.color, at: centroid(p.points) });
    });
    (circles || []).forEach((c, i) => {
      if (c.lat != null && c.lng != null) items.push({ key: `circle-${i}`, id: `circle-${i}`, type: t('mapItemRadius'), label: c.label, meta: c.sub || '', color: c.color, at: { lat: c.lat, lng: c.lng } });
    });
    (markers || []).forEach((m, i) => {
      if (m.lat != null && m.lng != null) items.push({ key: `marker-${i}`, id: `marker-${i}`, type: t('mapItemPoint'), label: m.label, meta: m.sub || '', color: m.color, at: { lat: m.lat, lng: m.lng } });
    });
    return items.filter((it) => it.label && it.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, polylines, polygons, circles]);

  const legendGroups = useMemo(() => {
    if (legend) return legend;
    const seen = new Set();
    const entries = [];
    const add = (shape, color, label) => {
      if (!label) return;
      const k = `${shape}:${color}:${label}`;
      if (seen.has(k)) return;
      seen.add(k);
      entries.push({ shape, color, label });
    };
    (polygons || []).forEach((p) => add('polygon', p.color || '#2563eb', p.legendLabel || p.label));
    (polylines || []).forEach((p) => add('line', p.color || '#b45309', p.legendLabel || p.label));
    (circles || []).forEach((c) => add('circle', c.color || '#2563eb', c.legendLabel || c.label));
    (markers || []).forEach((m) => add(m.pulse || m.flash ? 'pin' : 'dot', m.color || '#14532d', m.legendLabel || m.label));
    if (!entries.length) return null;
    return [{ title: t('mapLegendLayers'), entries: entries.slice(0, 14) }];
  }, [legend, markers, polylines, polygons, circles]);

  function focusItem(it) {
    const map = mapRef.current;
    if (!map || !it.at) return;
    map.flyTo([it.at.lat, it.at.lng], Math.max(map.getZoom(), 13), { duration: 0.6 });
    const layer = layersRef.current.get(it.id);
    if (layer && layer.openPopup) {
      const open = () => { try { layer.openPopup(); } catch { /* layer detached */ } };
      map.once('moveend', open);
      setTimeout(open, 900);
    }
  }

  return (
    <div className="map-picker" ref={wrapRef} style={{ height: Math.max(180, Number(height) || 0), width: '100%', maxWidth, margin: '0 auto' }}>
      <div ref={elRef} className="map-picker-map" />
      {controls && searchItems.length > 0 && (
        <div className="map-mini-search">
          <MapSearchBox items={searchItems} onSelect={focusItem} placeholder={t('mapSearch')} />
        </div>
      )}
      {controls && legendGroups && (
        <div className="map-mini-legend">
          <button type="button" className="map-mini-legend-toggle" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>
            {t('mapLegend')}
          </button>
          {legendOpen && (
            <div className="map-mini-legend-body">
              <MapLegend groups={legendGroups} />
            </div>
          )}
        </div>
      )}
      {controls && (
        <div className="map-mini-controls">
          <select
            value={baseKey}
            onChange={(e) => setBaseKey(e.target.value)}
            aria-label={t('mapBaseMap')}
            title={t('mapBaseMap')}
          >
            {BASE_LAYERS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
          <button type="button" onClick={() => toggleFullscreen(wrapRef.current)} title={isFull ? t('mapExitFullscreen') : t('mapFullscreen')}>
            {isFull ? t('mapExitFullscreen') : t('mapFullscreen')}
          </button>
        </div>
      )}
    </div>
  );
}
