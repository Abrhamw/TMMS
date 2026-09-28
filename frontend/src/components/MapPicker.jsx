import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { createBaseLayer, DEFAULT_BASE_KEY } from '../mapBase';
import { t } from '../i18n';

// Resolves the device's current position with high accuracy.
// Resolves {lat, lng, accuracy, ts}; rejects with a user-friendly message.
export function getDevicePosition() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Geolocation is unavailable. The app must be served over HTTPS.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 0),
          ts: new Date().toISOString(),
        }),
      (err) => {
        const msg =
          err && err.code === 1
            ? 'Location access was denied. Enable location permissions for this site.'
            : err && err.code === 2
              ? 'The device could not determine its location. Try again outdoors.'
              : 'Timed out waiting for the device location.';
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

const r6 = (n) => (typeof n === 'number' && Number.isFinite(n) ? +n.toFixed(6) : null);

export default function MapPicker({
  value,
  onChange,
  center,
  zoom = 10,
  markers = [],
  radius = null,
  radiusLabel,
  locate = true,
  height = 320,
  maxWidth = 760,
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  const [busy, setBusy] = useState(false);
  const [gpsErr, setGpsErr] = useState(null);

  const hasValue = !!value && typeof value.lat === 'number' && typeof value.lng === 'number';

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false, scrollWheelZoom: true });
    mapRef.current = map;
    createBaseLayer(DEFAULT_BASE_KEY).addTo(map);
    const init =
      center || (hasValue ? { lat: value.lat, lng: value.lng } : { lat: 9.0, lng: 39.0 });
    map.setView([init.lat, init.lng], center ? zoom : zoom);
    map.on('click', (e) => {
      onChangeRef.current?.({ lat: r6(e.latlng.lat), lng: r6(e.latlng.lng) });
    });
    setTimeout(() => map.invalidateSize(), 60);
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context markers (region boundaries, sibling substations, routes, etc.)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup();
    markers.forEach((m) => {
      if (m.lat === null || m.lat === undefined || m.lng === null || m.lng === undefined) return;
      const g = L.circleMarker([m.lat, m.lng], {
        radius: m.radius || 5,
        color: '#fff',
        weight: 1,
        fillColor: m.color || '#64748b',
        fillOpacity: 0.9,
      });
      if (m.label) g.bindPopup(`<b>${m.label}</b>`);
      g.addTo(layer);
    });
    layer.addTo(map);
    return () => {
      layer.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers]);

  // Selected point marker + tolerance radius circle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!hasValue) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      if (circleRef.current) {
        circleRef.current.remove();
        circleRef.current = null;
      }
      return;
    }
    const latlng = L.latLng(value.lat, value.lng);
    if (!markerRef.current) {
      markerRef.current = L.marker(latlng, { draggable: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const ll = markerRef.current.getLatLng();
        onChangeRef.current?.({ lat: r6(ll.lat), lng: r6(ll.lng) });
      });
    } else {
      markerRef.current.setLatLng(latlng);
    }
    if (radius && radius > 0) {
      const opts = {
        color: '#2563eb',
        weight: 1.5,
        dashArray: '5 5',
        fillColor: '#2563eb',
        fillOpacity: 0.06,
      };
      if (!circleRef.current) circleRef.current = L.circle(latlng, { radius, ...opts }).addTo(map);
      else circleRef.current.setLatLng(latlng).setRadius(radius);
    } else if (circleRef.current) {
      circleRef.current.remove();
      circleRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, radius]);

  // Fit bounds to context markers when nothing is selected yet
  useEffect(() => {
    const map = mapRef.current;
    if (!map || hasValue) return;
    const pts = markers.filter((m) => m.lat && m.lng).map((m) => [m.lat, m.lng]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.4), { maxZoom: 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers]);

  async function locateMe() {
    setBusy(true);
    setGpsErr(null);
    try {
      const p = await getDevicePosition();
      onChangeRef.current?.({ lat: r6(p.lat), lng: r6(p.lng) });
      const map = mapRef.current;
      if (map) map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 15));
    } catch (e) {
      setGpsErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="map-picker" style={{ height: Math.max(300, Number(height) || 0), width: '100%', maxWidth, margin: '0 auto' }}>
      <div ref={elRef} className="map-picker-map" />
      {locate && (
        <button
          className="btn btn-sm map-picker-locate"
          onClick={locateMe}
          disabled={busy}
          title={t('locateMe')}
        >
          <span aria-hidden style={{ marginRight: 5 }}>◎</span>
          {busy ? t('loading') : t('locateMe')}
        </button>
      )}
      <div className="map-picker-readout">
        {hasValue ? `${value.lat.toFixed(6)}, ${value.lng.toFixed(6)}` : t('clickMapToSetPoint')}
      </div>
      {gpsErr && <div className="map-picker-err">{gpsErr}</div>}
      {hasValue && radius > 0 && radiusLabel && (
        <div className="map-picker-radius">{radiusLabel}</div>
      )}
    </div>
  );
}
