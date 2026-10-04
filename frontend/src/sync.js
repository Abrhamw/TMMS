import { useEffect, useState } from 'react';

// A tiny app-wide sync/connectivity store. The API layer reports every write
// through beginSync/endSync so any surface can show whether work is saved. The
// worker field experience uses this to keep an honest online/offline indicator.
let state = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  lastSaved: null,
  error: null,
};

const listeners = new Set();

function emit() {
  for (const listener of listeners) listener(state);
}

export function subscribeSync(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSyncState() {
  return state;
}

export function beginSync() {
  state = { ...state, pending: state.pending + 1, error: null };
  emit();
}

export function endSync(ok = true, message = null) {
  state = {
    ...state,
    pending: Math.max(0, state.pending - 1),
    lastSaved: ok ? Date.now() : state.lastSaved,
    error: ok ? null : (message || 'Save failed'),
  };
  emit();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { state = { ...state, online: true }; emit(); });
  window.addEventListener('offline', () => { state = { ...state, online: false }; emit(); });
}

export function useSyncState() {
  const [snapshot, setSnapshot] = useState(getSyncState());
  useEffect(() => subscribeSync(setSnapshot), []);
  return snapshot;
}
