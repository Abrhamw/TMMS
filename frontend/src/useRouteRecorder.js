import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

const MIN_MOVE_M = 10;
const FLUSH_EVERY = 25;
const FLUSH_MS = 15000;

function metersBetween(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export default function useRouteRecorder(taskId, onSaved) {
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [accuracy, setAccuracy] = useState(null);
  const [error, setError] = useState(null);
  const watchRef = useRef(null);
  const timerRef = useRef(null);
  const bufferRef = useRef([]);
  const lastRef = useRef(null);
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  const flush = useCallback(async () => {
    const points = bufferRef.current;
    if (!points.length) return;
    bufferRef.current = [];
    try {
      await api.post(`/tasks/${taskId}/trace`, { points });
    } catch (e) {
      bufferRef.current = points.concat(bufferRef.current);
      setError(e.message);
    }
  }, [taskId]);

  const stop = useCallback(async () => {
    if (watchRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setRecording(false);
    await flush();
    if (savedRef.current) savedRef.current();
  }, [flush]);

  const start = useCallback(() => {
    if (watchRef.current != null) return;
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Geolocation is unavailable. The app must be served over HTTPS.');
      return;
    }
    lastRef.current = null;
    setCount(0);
    setRecording(true);
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Math.round(pos.coords.accuracy || 0),
          recorded_at: new Date().toISOString(),
        };
        setAccuracy(p.accuracy_m);
        if (lastRef.current && metersBetween(lastRef.current, p) < MIN_MOVE_M) return;
        lastRef.current = p;
        bufferRef.current.push(p);
        setCount((c) => c + 1);
        if (bufferRef.current.length >= FLUSH_EVERY) flush();
      },
      (err) => {
        setError(err && err.code === 1 ? 'Location access was denied.' : 'Could not determine device location.');
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    timerRef.current = setInterval(flush, FLUSH_MS);
  }, [flush]);

  useEffect(() => () => {
    if (watchRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  return { recording, count, accuracy, error, start, stop, flush };
}
