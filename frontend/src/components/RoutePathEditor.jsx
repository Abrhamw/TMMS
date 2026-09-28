import { useEffect, useRef } from 'react';
import L from 'leaflet';

const r6 = (n) => (typeof n === 'number' && Number.isFinite(n) ? +n.toFixed(6) : null);

// Interactive open-polyline editor for a transmission line route: click the map
// to append a waypoint, drag a vertex to move it, click a vertex to remove it.
// Tower positions are shown as context markers so the reviewer can line the
// route up with the imported towers before committing.
export default function RoutePathEditor({
  route = [],
  towers = [],
  onChange,
  center,
  zoom = 10,
  height = 320,
  label = 'Click the map to add route waypoints (≥2 points)',
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const pathRef = useRef(null);
  const vertexRef = useRef([]);
  const towerLayerRef = useRef(null);
  const routeRef = useRef(route);
  const onChangeRef = useRef(onChange);
  const fittedRef = useRef(false);
  routeRef.current = route;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    const init = center || (route.length ? { lat: route[0][0], lng: route[0][1] } : { lat: 9.0, lng: 39.0 });
    map.setView([init.lat, init.lng], zoom);
    map.on('click', (e) => {
      const cur = (routeRef.current || []).map((p) => [...p]);
      cur.push([r6(e.latlng.lat), r6(e.latlng.lng)]);
      onChangeRef.current?.(cur);
    });
    setTimeout(() => map.invalidateSize(), 60);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tower context
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (towerLayerRef.current) towerLayerRef.current.remove();
    const layer = L.layerGroup();
    (towers || []).forEach((t, i) => {
      if (t.latitude == null || t.longitude == null) return;
      L.circleMarker([t.latitude, t.longitude], { radius: 4, color: '#fff', weight: 1, fillColor: '#dc2626', fillOpacity: 0.9 })
        .bindTooltip(t.tower_id || t.tower_number || `Tower ${i + 1}`, { direction: 'top' })
        .addTo(layer);
    });
    towerLayerRef.current = layer;
    layer.addTo(map);
    return () => { layer.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [towers]);

  // Route + draggable vertices
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (pathRef.current) { pathRef.current.remove(); pathRef.current = null; }
    vertexRef.current.forEach((m) => m.remove());
    vertexRef.current = [];
    const pts = route || [];
    if (pts.length >= 2) {
      pathRef.current = L.polyline(pts, { color: '#2563eb', weight: 3 }).addTo(map);
    }
    pts.forEach((p, i) => {
      const m = L.marker([p[0], p[1]], { draggable: true, bubblingMouseEvents: false });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        const next = (routeRef.current || []).map((x) => [...x]);
        next[i] = [r6(ll.lat), r6(ll.lng)];
        onChangeRef.current?.(next);
      });
      m.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        const next = (routeRef.current || []).filter((_, j) => j !== i);
        onChangeRef.current?.(next);
      });
      m.bindTooltip(`waypoint ${i + 1} — click to remove`, { direction: 'top' });
      m.addTo(map);
      vertexRef.current.push(m);
    });
    if (pts.length > 0 && !fittedRef.current) {
      fittedRef.current = true;
      map.fitBounds(L.latLngBounds(pts.map((p) => [p[0], p[1]])).pad(0.3), { maxZoom: 15 });
    } else if (!pts.length) {
      fittedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  return (
    <div className="map-picker" style={{ height }}>
      <div ref={elRef} className="map-picker-map" />
      <div className="map-picker-readout">
        {route && route.length ? `${route.length} waypoint(s) — click a marker to remove` : label}
      </div>
    </div>
  );
}
