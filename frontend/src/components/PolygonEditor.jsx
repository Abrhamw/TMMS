import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { createBaseLayer, DEFAULT_BASE_KEY } from '../mapBase';

const r6 = (n) => (typeof n === 'number' && Number.isFinite(n) ? +n.toFixed(6) : null);
const MAX_VERTICES = 500;

// Click-to-draw polygon editor. Each map click appends a vertex; vertices can be
// dragged to adjust and removed with Undo. The polygon auto-closes.
export default function PolygonEditor({
  value = [],
  onChange,
  center,
  zoom = 11,
  markers = [],
  height = 320,
  maxWidth = 760,
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const shapeRef = useRef(null);
  const vertexLayerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  onChangeRef.current = onChange;
  valueRef.current = value;

  const points = Array.isArray(value) ? value : [];
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false, scrollWheelZoom: true });
    mapRef.current = map;
    createBaseLayer(DEFAULT_BASE_KEY).addTo(map);
    const init = center || (points.length ? { lat: points[0][0], lng: points[0][1] } : { lat: 9.0, lng: 39.0 });
    map.setView([init.lat, init.lng], zoom);
    map.on('click', (e) => {
      const cur = valueRef.current || [];
      if (cur.length >= MAX_VERTICES) return;
      onChangeRef.current?.([...cur, [r6(e.latlng.lat), r6(e.latlng.lng)]]);
    });
    setTimeout(() => map.invalidateSize(), 60);
    return () => {
      map.remove();
      mapRef.current = null;
      shapeRef.current = null;
      vertexLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup();
    markers.forEach((m) => {
      if (m.lat === null || m.lat === undefined || m.lng === null || m.lng === undefined) return;
      const g = L.circleMarker([m.lat, m.lng], {
        radius: m.radius || 5, color: '#fff', weight: 1, fillColor: m.color || '#64748b', fillOpacity: 0.9,
      });
      if (m.label) g.bindPopup(`<b>${m.label}</b>`);
      g.addTo(layer);
    });
    layer.addTo(map);
    return () => { layer.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers]);

  // Draw / redraw the boundary and its draggable vertices
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (shapeRef.current) { shapeRef.current.remove(); shapeRef.current = null; }
    if (vertexLayerRef.current) { vertexLayerRef.current.remove(); vertexLayerRef.current = null; }
    if (points.length === 0) return;
    if (points.length >= 3) {
      shapeRef.current = L.polygon(points, { color: '#2563eb', weight: 2, fillColor: '#2563eb', fillOpacity: 0.12 }).addTo(map);
    } else if (points.length === 2) {
      shapeRef.current = L.polyline(points, { color: '#2563eb', weight: 2, dashArray: '4 4' }).addTo(map);
    }
    const vLayer = L.layerGroup();
    points.forEach((p, i) => {
      const marker = L.marker([p[0], p[1]], {
        draggable: true,
        icon: L.divIcon({ className: 'poly-vertex', iconSize: [12, 12], iconAnchor: [6, 6] }),
      });
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        const next = (valueRef.current || []).slice();
        next[i] = [r6(ll.lat), r6(ll.lng)];
        onChangeRef.current?.(next);
      });
      marker.bindTooltip(String(i + 1), { direction: 'top', offset: [0, -8] });
      marker.addTo(vLayer);
    });
    vertexLayerRef.current = vLayer;
    vLayer.addTo(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Fit view to an externally supplied polygon (e.g. "use region boundary")
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !points.length) return;
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points.map((p) => [p[0], p[1]])).pad(0.25), { maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function fitView() {
    const map = mapRef.current;
    if (!map || !points.length) return;
    if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 14));
    else map.fitBounds(L.latLngBounds(points.map((p) => [p[0], p[1]])).pad(0.25), { maxZoom: 14 });
  }

  function undo() {
    onChange?.((value || []).slice(0, -1));
  }
  function clear() {
    onChange?.([]);
  }

  return (
    <div className="poly-editor">
      <div className="poly-editor-map" style={{ height: Math.max(260, Number(height) || 0), maxWidth, margin: '0 auto' }}>
        <div ref={elRef} style={{ width: '100%', height: '100%' }} />
      </div>
      <div className="poly-editor-bar">
        <span className="muted">{points.length} point{points.length === 1 ? '' : 's'} — click the map to add</span>
        <span className="nowrap">
          <button type="button" className="btn btn-sm" onClick={undo} disabled={!points.length}>Undo</button>{' '}
          <button type="button" className="btn btn-sm" onClick={clear} disabled={!points.length}>Clear</button>{' '}
          <button type="button" className="btn btn-sm" onClick={fitView} disabled={!points.length}>Fit view</button>
        </span>
      </div>
    </div>
  );
}
