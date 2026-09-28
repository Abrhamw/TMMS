import { useEffect, useRef } from 'react';
import L from 'leaflet';

const r6 = (n) => (typeof n === 'number' && Number.isFinite(n) ? +n.toFixed(6) : null);

// Interactive polygon boundary editor: click the map to add vertices, drag to
// move, click a vertex to remove. Used for region and substation boundaries.
export default function BoundaryPicker({
  polygon,
  onChange,
  center,
  zoom = 11,
  height = 300,
  label = 'Click the map to add boundary vertices (≥3 points)',
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const polyRef = useRef(null);
  const markersRef = useRef([]);
  const polygonRef = useRef(polygon);
  const onChangeRef = useRef(onChange);
  const fittedRef = useRef(false);
  polygonRef.current = polygon;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    map.setView(center || [9.0, 39.0], zoom);
    map.on('click', (e) => {
      const cur = (polygonRef.current || []).map((p) => [...p]);
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (polyRef.current) { polyRef.current.remove(); polyRef.current = null; }
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const pts = polygon || [];
    if (pts.length >= 2) {
      polyRef.current = L.polyline([...pts.map((p) => [p[0], p[1]]), pts[0]], {
        color: '#15803d', weight: 2, dashArray: '6 4',
      }).addTo(map);
    } else if (pts.length === 1) {
      polyRef.current = L.polyline([pts[0], pts[0]], { color: '#15803d', weight: 2 }).addTo(map);
    }
    pts.forEach((p, i) => {
      const m = L.marker([p[0], p[1]], { draggable: true, bubblingMouseEvents: false });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        const next = (polygonRef.current || []).map((x) => [...x]);
        next[i] = [r6(ll.lat), r6(ll.lng)];
        onChangeRef.current?.(next);
      });
      m.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        const next = (polygonRef.current || []).filter((_, j) => j !== i);
        onChangeRef.current?.(next);
      });
      m.bindTooltip(`vertex ${i + 1} — click to remove`, { direction: 'top' });
      m.addTo(map);
      markersRef.current.push(m);
    });
    const grew = pts.length > 0 && !fittedRef.current;
    if (pts.length === 0) fittedRef.current = false;
    if (grew) {
      fittedRef.current = true;
      map.fitBounds(L.latLngBounds(pts.map((p) => [p[0], p[1]])).pad(0.3), { maxZoom: 15 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygon]);

  return (
    <div className="map-picker" style={{ height }}>
      <div ref={elRef} className="map-picker-map" />
      <div className="map-picker-readout">
        {polygon && polygon.length >= 3 ? `${polygon.length} vertices — click a marker to remove` : label}
      </div>
    </div>
  );
}
