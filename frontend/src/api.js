import { getSessionToken, clearSession } from './session';
import { beginSync, endSync } from './sync';

const BASE = '/api';

let currentLocale = 'en-US';

export function setApiLocale(locale) {
  currentLocale = locale || 'en-US';
}

function getToken() {
  return getSessionToken();
}

// GET responses are cached with stale-while-revalidate. This keeps page changes
// fast:
// - React.StrictMode mounts every page twice in dev, so without dedup each
//   list endpoint (some are 5-12 MB) is fetched twice on every navigation.
// - Re-visiting a page inside the fresh window renders from cache instantly.
// - Between the fresh and stale windows a cached response is served immediately
//   while a background request refreshes it for the next visit.
// Any write clears the whole cache, so mutations are never masked.
const GET_TTL_MS = 5000; // serve without revalidating
const GET_STALE_MS = 300000; // serve immediately, revalidate in the background
const getCache = new Map();

function invalidateGetCache() {
  getCache.clear();
}

function handle401() {
  const token = getSessionToken();
  clearSession(token);
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
}

function fetchGet(path, options, headers) {
  return fetch(`${BASE}${path}`, { headers, ...options }).then(async (res) => {
    if (res.status === 401) {
      handle401();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data.error) msg = data.error;
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    return res.json();
  });
}

function getCached(path, options, headers) {
  const hit = getCache.get(path);
  const now = Date.now();

  if (hit) {
    // A request is already in flight for this key: no duplicate fetch.
    if (hit.promise) return hit.promise;
    if (hit.data !== undefined) {
      if (now - hit.ts < GET_TTL_MS) return Promise.resolve(hit.data);
      if (now - hit.ts < GET_STALE_MS) {
        // Serve stale immediately, refresh in the background, and keep the
        // stale value if the refresh fails.
        const stale = hit.data;
        const staleTs = hit.ts;
        const revalidate = fetchGet(path, options, headers)
          .then((data) => {
            getCache.set(path, { data, ts: Date.now(), promise: null });
            return data;
          })
          .catch((error) => {
            const cur = getCache.get(path);
            if (cur && cur.promise === revalidate) getCache.set(path, { data: stale, ts: staleTs, promise: null });
            throw error;
          });
        getCache.set(path, { data: stale, ts: staleTs, promise: revalidate });
        return Promise.resolve(stale);
      }
    }
  }

  const promise = fetchGet(path, options, headers)
    .then((data) => {
      getCache.set(path, { data, ts: Date.now(), promise: null });
      return data;
    })
    .catch((error) => {
      // Never cache a failed read, so a retry actually re-fetches.
      const cur = getCache.get(path);
      if (cur && cur.promise === promise) getCache.delete(path);
      throw error;
    });
  getCache.set(path, { data: undefined, ts: now, promise });
  return promise;
}

async function request(path, options = {}, { skipInvalidate = false } = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // A rejected sign-in is a 401 too, but it must not be treated as an expired
  // session: that would clear the sign-in of this tab and of every other tab.
  const isLogin = path === '/auth/login';

  if (method !== 'GET') {
    // Mutations always hit the network; a successful write invalidates cached
    // reads so the next GET reflects it. They also drive the sync indicator.
    beginSync();
    try {
      const res = await fetch(`${BASE}${path}`, { headers, ...options });
      if (res.status === 401 && !isLogin) {
        handle401();
        throw new Error('Session expired. Please sign in again.');
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data.error) msg = data.error;
        } catch (_) {
          /* ignore */
        }
        throw new Error(msg);
      }
      if (!skipInvalidate) invalidateGetCache();
      const data = await res.json();
      endSync(true);
      return data;
    } catch (error) {
      endSync(false, error.message);
      throw error;
    }
  }

  return getCached(path, options, headers);
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  // Dry-run POST for live form feedback: never invalidates the read cache.
  preview: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, { skipInvalidate: true }),
  put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: (path) => request(path, { method: 'DELETE' }),
  invalidate: () => invalidateGetCache(),
  // Warm the read cache for a path without a caller awaiting it.
  prefetch: (path) => {
    request(path).catch(() => {});
    return undefined;
  },
  // Authenticated file download (templates). Triggers a browser save.
  download: async (path, filename) => {
    const token = getToken();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}${path}`, { headers });
    if (res.status === 401) {
      handle401();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data.error) msg = data.error;
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  // Fetch a binary attachment as a Blob (for inline PDF/image preview).
  blob: async (path) => {
    const token = getToken();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}${path}`, { headers });
    if (res.status === 401) {
      handle401();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
};

// Normalize a JSON array field (e.g. route_json, boundary_json) into an array.
// Tolerates a serialized string and historical double-encoded values so a bad
// row renders as empty instead of crashing a `.map` call.
export function asArray(value) {
  let v = value;
  let guard = 0;
  while (typeof v === 'string' && guard < 5) {
    try {
      v = JSON.parse(v);
    } catch (_) {
      break;
    }
    guard++;
  }
  return Array.isArray(v) ? v : [];
}

// ---- Locale-aware formatting -------------------------------------------------
function fmt(date, opts) {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return d.toLocaleString(currentLocale, opts);
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}

export function fmtDate(iso) {
  return fmt(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function fmtDateTime(iso) {
  return fmt(iso, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtNum(n, opts = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  try {
    return Number(n).toLocaleString(currentLocale, opts);
  } catch (_) {
    return String(n);
  }
}

export function fmtMoney(value, code = 'USD') {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  try {
    return v.toLocaleString(currentLocale, { style: 'currency', currency: code, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  } catch (_) {
    return `${code} ${v.toLocaleString(currentLocale)}`;
  }
}

// Convert meters to feet when imperial, else meters.
export function fmtDistance(m, unitSystem = 'metric') {
  if (m === null || m === undefined) return '—';
  if (unitSystem === 'imperial') return `${fmtNum(Math.round(Number(m) * 3.28084))} ft`;
  return `${fmtNum(Math.round(Number(m)))} m`;
}

// Convert km to miles when imperial, else km.
export function fmtLengthKm(km, unitSystem = 'metric') {
  if (km === null || km === undefined) return '—';
  if (unitSystem === 'imperial') return `${fmtNum(Number(km) * 0.621371)} mi`;
  return `${fmtNum(km)} km`;
}

export const STATUS_COLORS = {
  OPERATIONAL: '#22c55e',
  ENERGIZED: '#22c55e',
  AVAILABLE: '#22c55e',
  VALID: '#22c55e',
  ACTIVE: '#22c55e',
  PASS: '#22c55e',
  COMPLETED: '#22c55e',
  READY: '#22c55e',
  MAINTENANCE: '#f59e0b',
  UNDER_MAINTENANCE: '#f59e0b',
  SCHEDULED: '#f59e0b',
  ASSIGNED: '#3b82f6',
  ON_SITE: '#3b82f6',
  IN_PROGRESS: '#3b82f6',
  ON_TASK: '#0ea5e9',
  OFF_DUTY: '#6b7280',
  UNAVAILABLE: '#ef4444',
  PENDING_VERIFICATION: '#a855f7',
  ON_HOLD: '#f97316',
  DRAFT: '#94a3b8',
  OUT_OF_SERVICE: '#ef4444',
  DE_ENERGIZED: '#ef4444',
  FAIL: '#ef4444',
  EXPIRED: '#ef4444',
  FAILED: '#ef4444',
  CANCELLED: '#6b7280',
  INACTIVE: '#6b7280',
  DECOMMISSIONED: '#6b7280',
  RETIRED: '#6b7280',
  DEGRADED: '#f97316',
  UNDER_CONSTRUCTION: '#3b82f6',
  CRITICAL: '#dc2626',
  HIGH: '#ea580c',
  MEDIUM: '#d97706',
  LOW: '#16a34a',
  EXPIRING: '#d97706',
};

export function condColor(rating) {
  if (rating <= 3) return '#ef4444';
  if (rating <= 5) return '#f97316';
  if (rating <= 7) return '#f59e0b';
  return '#22c55e';
}
