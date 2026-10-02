import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { api } from '../api';
import { SearchSelect, Page, Loading, ErrorNote } from '../components';
import { getDevicePosition } from '../components/MapPicker';
import {
  flyToPoints, boundsOf, circleCorners, relatedSegment, flashIcon, isEnergized,
  parseVoltageLevels, voltageBand, STATUS_COLOR, VOLTAGE_BANDS, voltageChip, popupRows, esc,
} from '../mapFocus';
import { BASE_LAYERS, DEFAULT_BASE_KEY, createBaseLayer, toggleFullscreen } from '../mapBase';
import MapSearchBox from '../components/MapSearchBox';
import MapLegend from '../components/MapLegend';
import { t } from '../i18n';


const LAYERS = [
  { key: 'regions', labelKey: 'layerRegions', color: '#2563eb', count: (d) => d.regions?.length ?? 0 },
  { key: 'substations', labelKey: 'layerSubstations', color: '#22c55e', count: (d) => d.substations?.length ?? 0 },
  { key: 'lines', labelKey: 'layerLines', color: '#f59e0b', count: (d) => d.lines?.length ?? 0 },
  { key: 'towers', labelKey: 'layerTowers', color: '#94a3b8', count: (d) => d.towers?.length ?? 0 },
  { key: 'assets', labelKey: 'layerAssets', color: '#a855f7', count: (d) => d.assets?.length ?? 0 },
  { key: 'geofences', labelKey: 'layerGeofences', color: '#7c3aed', count: (d) => d.geofences?.length ?? 0 },
  { key: 'alerts', labelKey: 'layerAlerts', color: '#dc2626', count: (d) => d.validation_alerts?.length ?? 0 },
  { key: 'tasks', labelKey: 'layerTasks', color: '#0ea5e9', count: (d) => d.open_tasks?.length ?? 0 },
];

const STATUS_LEGEND = ['OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE', 'UNDER_CONSTRUCTION', 'DECOMMISSIONED'];
const REGION_COLOR = '#2563eb';
const DEFAULT_CENTER = [9.0, 39.0];
const DEFAULT_ZOOM = 6;
const PROGRESS_COLORS = { none: '#94a3b8', partial: '#d97706', complete: '#16a34a' };

function inspectionColor(l) {
  const p = l && l.inspection ? Number(l.inspection.tower_progress) || 0 : 0;
  if (p >= 1) return PROGRESS_COLORS.complete;
  if (p > 0) return PROGRESS_COLORS.partial;
  return PROGRESS_COLORS.none;
}

function bandLabel(kv) {
  const b = voltageBand(kv);
  return b ? b.label : null;
}

function regionPopup(r) {
  const hasBoundary = Array.isArray(r.boundary_json) && r.boundary_json.length >= 3;
  return `<div class="tmms-pop"><b>${esc(r.name)}</b><div class="tmms-pop-sub">${esc(r.code)}</div>` +
    popupRows([
      ['Status', r.status],
      ['Boundary', hasBoundary ? `${r.boundary_json.length} points` : `Radius ${r.boundary} km`],
    ]) +
    '<div class="tmms-pop-sub">Click infrastructure on the map for details.</div></div>';
}

function linePopup(l) {
  const fromName = l.from_name || l.from?.name || '?';
  const toName = l.to_name || l.to?.name || '?';
  return `<div class="tmms-pop"><b>${esc(l.name)}</b> ${voltageChip(l.voltage_kv, { energized: isEnergized(l.status) })}` +
    `<div class="tmms-pop-sub">${esc(l.line_id)}</div>` +
    popupRows([
      ['From → To', `${fromName} → ${toName}`],
      ['Length', l.length_km != null ? `${l.length_km} km` : null],
      ['Conductor', l.conductor_type],
      ['Circuits', l.circuit_count],
      ['Region', l.region_name],
      ['Status', l.status],
      ['Inspection', l.inspection ? `${l.inspection.inspected_towers}/${l.inspection.total_towers} towers (${Math.round((l.inspection.tower_progress || 0) * 100)}%)` : null],
    ]) +
    (l.gps_validated ? '' : '<div class="tmms-pop-warn">GPS: unvalidated</div>') +
    `<a href="/lines/${l.id}" class="tmms-pop-link">Open →</a></div>`;
}

function substationPopup(s) {
  return `<div class="tmms-pop"><b>${esc(s.name)}</b> ${voltageChip(s.voltage_kv, { energized: isEnergized(s.status) })}` +
    `<div class="tmms-pop-sub">${esc(s.substation_id)}${s.substation_type ? ` · ${esc(s.substation_type)}` : ''}</div>` +
    popupRows([
      ['Voltage', parseVoltageLevels(s.voltage_levels).join(', ') || null],
      ['Region', s.region_name],
      ['Owner', s.owner],
      ['Status', s.status],
    ]) +
    (s.gps_validated ? '' : '<div class="tmms-pop-warn">GPS: unvalidated</div>') +
    `<a href="/substations/${s.id}" class="tmms-pop-link">Open →</a></div>`;
}

function towerPopup(x) {
  return `<div class="tmms-pop"><b>${esc(x.tower_id)}</b> ${voltageChip(x.voltage_kv, { energized: isEnergized(x.status) })}` +
    `<div class="tmms-pop-sub">${esc(x.line_name || '')}</div>` +
    popupRows([
      ['Line', x.line_name],
      ['Type', x.tower_type],
      ['Material', x.tower_material],
      ['km marker', x.km_marker],
      ['Height', x.height_m != null ? `${x.height_m} m` : null],
      ['Status', x.status],
    ]) +
    (x.gps_validated ? '' : '<div class="tmms-pop-warn">GPS: unvalidated</div>') +
    '</div>';
}

function assetPopup(a) {
  return `<div class="tmms-pop"><b>${esc(a.name)}</b> ${voltageChip(a.voltage_kv, { energized: isEnergized(a.status) })}` +
    `<div class="tmms-pop-sub">${esc(a.asset_id)}${a.sub_type ? ` · ${esc(a.sub_type)}` : ''}</div>` +
    popupRows([
      ['Type', a.asset_type],
      ['Substation', a.substation_name],
      ['Line', a.line_name],
      ['Tower', a.tower_name],
      ['Condition', a.condition != null ? `${a.condition}/10` : null],
      ['Criticality', a.criticality],
      ['Status', a.status],
      ['Lifecycle', a.lifecycle_status],
    ]) +
    (a.gps_validated ? '' : '<div class="tmms-pop-warn">GPS: unvalidated</div>') +
    `<a href="/assets/${a.id}" class="tmms-pop-link">Open →</a></div>`;
}

function alertPopup(v) {
  return `<div class="tmms-pop"><b>GPS ${esc(v.result)}</b><div class="tmms-pop-sub">${esc(v.target_type)}</div>` +
    popupRows([
      ['Expected', `${v.expected_lat.toFixed(4)}, ${v.expected_lng.toFixed(4)}`],
      ['Measured', `${v.measured_lat.toFixed(4)}, ${v.measured_lng.toFixed(4)}`],
      ['Distance', `${v.distance_m} m (tol ${v.tolerance_m} m)`],
    ]) +
    (v.violation ? `<div class="tmms-pop-warn">Violation: ${esc(v.violation)}</div>` : '') +
    '</div>';
}

function geofencePopup(f) {
  const boundary = Array.isArray(f.boundary) && f.boundary.length >= 3
    ? `Polygon (${f.boundary.length} pts)`
    : f.target_type === 'LINE' && !f.target_id ? `Route corridor ${f.radius_m} m` : `Circle ${f.radius_m} m`;
  return `<div class="tmms-pop"><b>${esc(f.name)}</b><div class="tmms-pop-sub">${t('layerGeofences')} · ${esc(f.target_type)}</div>` +
    popupRows([
      ['Boundary', boundary],
      ['Applies to', f.target_id ? `${f.target_type} #${f.target_id}` : `${f.target_type} (all)`],
      ['Tolerance', f.tolerance_m != null ? `${f.tolerance_m} m` : null],
      ['Active', f.is_active ? 'Yes' : 'No'],
    ]) + '</div>';
}

function taskPopup(x) {
  return `<div class="tmms-pop"><b>${esc(x.task_number)}</b><div class="tmms-pop-sub">${esc(x.title)}</div>` +
    popupRows([
      ['Priority', x.priority],
      ['Status', x.status],
      ['Due', new Date(x.due_date).toLocaleDateString()],
    ]) +
    `<a href="/tasks/${x.id}" class="tmms-pop-link">Open →</a></div>`;
}

function Panel({ title, className, collapsed, onToggle, headExtra, children }) {
  return (
    <div className={`map-panel ${className || ''}${collapsed ? ' is-collapsed' : ''}`}>
      <div className="map-panel-head">
        <b>{title}</b>
        {headExtra}
        <button
          type="button"
          className="map-panel-toggle"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '+' : '−'}
        </button>
      </div>
      {!collapsed && <div className="map-panel-body">{children}</div>}
    </div>
  );
}

export default function MapPage() {
  const mapEl = useRef(null);
  const shellRef = useRef(null);
  const mapRef = useRef(null);
  const baseLayerRef = useRef(null);
  const layerRefs = useRef({});
  const focusRef = useRef(null);
  const coordsEl = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Tower and asset layers can hold tens of thousands of points on a large
  // register; start them hidden so the map opens light and only materialise
  // them when the user turns the layer on.
  const [hidden, setHidden] = useState({ towers: true, assets: true });
  const [lastClick, setLastClick] = useState(null);
  const [copied, setCopied] = useState(false);
  const [locating, setLocating] = useState(false);
  const [baseKey, setBaseKey] = useState(DEFAULT_BASE_KEY);
  const [isFull, setIsFull] = useState(false);
  const [collapsed, setCollapsed] = useState({ layers: false, legend: false });
  const [helpOpen, setHelpOpen] = useState(false);
  const [bands, setBands] = useState(() => new Set(VOLTAGE_BANDS.map((b) => b.label)));
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [regionFilter, setRegionFilter] = useState('ALL');
  const [progressMode, setProgressMode] = useState(false);

  useEffect(() => {
    api.get('/map/data').then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, { zoomControl: false, scrollWheelZoom: true, attributionControl: true });
    mapRef.current = map;
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    map.on('mousemove', (e) => {
      if (coordsEl.current) {
        coordsEl.current.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
      }
    });
    map.on('click', (e) => {
      setLastClick({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) });
    });
    map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    return () => {
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
      layerRefs.current = {};
    };
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
      if (map) setTimeout(() => map.invalidateSize(), 120);
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
    if (!data || !mapRef.current) return;
    const map = mapRef.current;
    const Lyr = {};
    const bandOk = (kv) => {
      const b = bandLabel(kv);
      return b == null ? true : bands.has(b);
    };
    const statusOk = (st) => statusFilter === 'ALL' || (statusFilter === 'ENERGIZED' ? isEnergized(st) : !isEnergized(st));
    const regionOk = (rid) => regionFilter === 'ALL' || (rid != null && String(rid) === String(regionFilter));
    const lineRegion = new Map((data.lines || []).map((l) => [l.id, l.region_id]));
    const subRegion = new Map((data.substations || []).map((s) => [s.id, s.region_id]));
    const HEAVY = new Set(['towers', 'assets']);
    const make = (key, fn) => {
      if (HEAVY.has(key) && hidden[key]) return null;
      const g = L.layerGroup();
      fn(g);
      g.addTo(map);
      return g;
    };

    if (focusRef.current) map.removeLayer(focusRef.current);
    const focusLayer = L.layerGroup().addTo(map);
    focusRef.current = focusLayer;
    const clearFocus = () => { focusLayer.clearLayers(); };
    const fly = (pts, opts) => flyToPoints(map, pts, opts);
    const flash = (latlng, color, size = 22) => {
      L.marker(latlng, { icon: flashIcon(color, size), zIndexOffset: 900 }).addTo(focusLayer);
    };

    Lyr.regions = make('regions', (g) => {
      data.regions.forEach((r) => {
        if (!regionOk(r.id)) return;
        const hasBoundary = Array.isArray(r.boundary_json) && r.boundary_json.length >= 3;
        const ring = hasBoundary ? r.boundary_json : circleCorners(r.center[0], r.center[1], (Number(r.boundary) || 0) * 111320);
        const layer = hasBoundary
          ? L.polygon(r.boundary_json, { color: REGION_COLOR, weight: 1.5, fillColor: REGION_COLOR, fillOpacity: 0.06 })
          : L.circle([r.center[0], r.center[1]], {
            radius: r.boundary * 111320, color: REGION_COLOR, weight: 1.5, fillColor: REGION_COLOR, fillOpacity: 0.05,
          });
        layer.bindPopup(regionPopup(r));
        layer.on('click', () => {
          clearFocus();
          if (hasBoundary) {
            L.polygon(ring, { color: REGION_COLOR, weight: 3, fillOpacity: 0.05, dashArray: '10 6', className: 'tmms-related-line' }).addTo(focusLayer);
          }
          if (r.center && Number.isFinite(r.center[0])) flash([r.center[0], r.center[1]], REGION_COLOR);
          fly(ring, { maxZoom: 10, singleZoom: 10 });
        });
        layer.addTo(g);
      });
    });

    Lyr.lines = make('lines', (g) => {
      data.lines.forEach((l) => {
        if (!Array.isArray(l.route) || l.route.length < 2) return;
        if (!bandOk(l.voltage_kv) || !statusOk(l.status) || !regionOk(l.region_id)) return;
        const pts = l.route.map((p) => [p[0], p[1]]);
        const color = progressMode ? inspectionColor(l) : (l.color || '#f59e0b');
        const weight = l.voltage_kv >= 500 ? 4.5 : l.voltage_kv >= 230 ? 3.5 : 2.5;
        const poly = L.polyline(pts, { color, weight, opacity: 0.9 }).bindPopup(linePopup(l));
        poly.on('mouseover', () => poly.setStyle({ weight: weight + 3, opacity: 1 }));
        poly.on('mouseout', () => poly.setStyle({ weight, opacity: 0.9 }));
        poly.on('click', () => {
          clearFocus();
          L.polyline(pts, { color, weight: 6, opacity: 0.75, dashArray: '10 8', className: 'tmms-target-line' }).addTo(focusLayer);
          fly(pts, { maxZoom: 13, singleZoom: 12 });
        });
        poly.addTo(g);
      });
    });

    Lyr.substations = make('substations', (g) => {
      let openTimer = null;
      let openHandler = null;
      data.substations.forEach((s) => {
        if (!bandOk(s.voltage_kv) || !statusOk(s.status) || !regionOk(s.region_id)) return;
        const hasBoundary = Array.isArray(s.boundary_json) && s.boundary_json.length >= 3;
        const outline = s.voltage_color || '#0ea5e9';
        const ring = hasBoundary ? s.boundary_json : circleCorners(s.position[0], s.position[1], s.fence_radius_m || 220);
        // Keep the popup clear of the overlaying search/legend panels.
        const popupOpts = {
          autoPan: true,
          autoPanPaddingTopLeft: L.point(320, 72),
          autoPanPaddingBottomRight: L.point(28, 64),
        };
        const marker = L.circleMarker([s.position[0], s.position[1]], {
          radius: 8, color: '#fff', weight: 2, fillColor: s.color, fillOpacity: 1,
        }).bindPopup(substationPopup(s), popupOpts);
        // Open the popup only once the zoom/fit settles (and let autoPan bring it
        // fully on screen); opening mid-animation left it off the visible area.
        const select = () => {
          marker.closePopup();
          if (openHandler) map.off('moveend', openHandler);
          clearTimeout(openTimer);
          clearFocus();
          if (hasBoundary) {
            L.polygon(ring, { color: outline, weight: 3, fillOpacity: 0.05, dashArray: '10 6', className: 'tmms-related-line', interactive: false }).addTo(focusLayer);
          } else {
            L.circle(s.position, { radius: s.fence_radius_m || 220, color: outline, weight: 3, fill: false, dashArray: '10 6', className: 'tmms-related-line', interactive: false }).addTo(focusLayer);
          }
          flash(s.position, s.color);
          let opened = false;
          const open = () => {
            if (opened) return;
            opened = true;
            map.off('moveend', open);
            marker.openPopup();
          };
          openHandler = open;
          map.on('moveend', open);
          openTimer = setTimeout(open, 950);
          fly(ring, { maxZoom: 16, singleZoom: 16 });
        };
        // The yard itself is clickable so the info pops wherever the site is
        // clicked, not only on the small centre dot.
        let yard = null;
        if (hasBoundary) {
          yard = L.polygon(s.boundary_json, { color: outline, weight: 1, dashArray: '4 4', fillColor: outline, fillOpacity: 0.04 }).addTo(g);
        } else if (s.fence_radius_m) {
          yard = L.circle(s.position, { radius: s.fence_radius_m, color: outline, weight: 1, dashArray: '4 4', fill: false }).addTo(g);
        }
        if (yard) {
          yard.bindPopup(substationPopup(s), popupOpts);
          yard.on('mouseover', () => yard.setStyle({ weight: 2.5, fillOpacity: 0.12 }));
          yard.on('mouseout', () => yard.setStyle({ weight: 1, fillOpacity: 0.04 }));
          yard.on('click', select);
        }
        marker.on('mouseover', () => marker.setStyle({ radius: 11, weight: 3 }));
        marker.on('mouseout', () => marker.setStyle({ radius: 8, weight: 2 }));
        marker.on('click', select);
        marker.addTo(g);
      });
    });

    Lyr.towers = make('towers', (g) => {
      data.towers.forEach((x) => {
        const rid = x.region_id != null ? x.region_id : lineRegion.get(x.line_id);
        if (!bandOk(x.voltage_kv) || !statusOk(x.status) || !regionOk(rid)) return;
        const dot = L.circleMarker([x.position[0], x.position[1]], {
          radius: 2.5, color: x.color, fillColor: x.color, fillOpacity: 1,
        }).bindPopup(towerPopup(x));
        dot.on('mouseover', () => dot.setStyle({ radius: 5 }));
        dot.on('mouseout', () => dot.setStyle({ radius: 2.5 }));
        dot.on('click', () => {
          clearFocus();
          const line = data.lines.find((l) => l.id === x.line_id);
          const route = line && Array.isArray(line.route) ? line.route : [];
          const seg = relatedSegment(route, x.position[0], x.position[1]);
          if (route.length > 1) {
            L.polyline(route.map((p) => [p[0], p[1]]), { color: x.color, weight: 2, opacity: 0.7, dashArray: '4 6' }).addTo(focusLayer);
          }
          if (seg.length > 1) {
            L.polyline(seg, { color: '#0ea5e9', weight: 6, opacity: 0.95, dashArray: '10 6', className: 'tmms-related-line' }).addTo(focusLayer);
          }
          flash([x.position[0], x.position[1]], x.color);
          fly([[x.position[0], x.position[1]], ...seg], { maxZoom: 16, padding: [60, 60], singleZoom: 16 });
        });
        dot.addTo(g);
      });
    });

    Lyr.assets = make('assets', (g) => {
      data.assets.forEach((a) => {
        const rid = a.region_id != null ? a.region_id : (a.line_id ? lineRegion.get(a.line_id) : a.substation_id ? subRegion.get(a.substation_id) : null);
        if (!bandOk(a.voltage_kv) || !statusOk(a.status) || !regionOk(rid)) return;
        const marker = L.circleMarker([a.position[0], a.position[1]], {
          radius: 5, color: '#fff', weight: 1.5, fillColor: a.color, fillOpacity: 0.95,
        }).bindPopup(assetPopup(a));
        marker.on('mouseover', () => marker.setStyle({ radius: 8 }));
        marker.on('mouseout', () => marker.setStyle({ radius: 5 }));
        marker.on('click', () => {
          clearFocus();
          flash(a.position, a.color);
          fly([a.position], { maxZoom: 16, singleZoom: 16 });
        });
        marker.addTo(g);
      });
    });

    Lyr.geofences = make('geofences', (g) => {
      data.geofences.forEach((f) => {
        if (Array.isArray(f.boundary) && f.boundary.length >= 3) {
          const shape = L.polygon(f.boundary, {
            color: '#7c3aed', weight: 1.5, dashArray: '6 6', fillColor: '#7c3aed', fillOpacity: 0.06,
          }).bindPopup(geofencePopup(f));
          shape.on('click', () => { clearFocus(); fly(f.boundary, { maxZoom: 15, singleZoom: 15 }); });
          shape.addTo(g);
          return;
        }
        const ring = L.circle([f.center[0], f.center[1]], {
          radius: f.radius_m, color: '#7c3aed', weight: 1, dashArray: '6 6', fill: false,
        }).bindPopup(geofencePopup(f));
        ring.on('click', () => {
          clearFocus();
          fly(circleCorners(f.center[0], f.center[1], f.radius_m), { maxZoom: 15, singleZoom: 15 });
        });
        ring.addTo(g);
      });
    });

    Lyr.alerts = make('alerts', (g) => {
      data.validation_alerts.forEach((v) => {
        const color = v.result === 'FAIL' ? '#dc2626' : '#f59e0b';
        const marker = L.marker([v.measured_lat, v.measured_lng], {
          icon: L.divIcon({ className: '', html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff"></div>` }),
        }).bindPopup(alertPopup(v));
        marker.on('click', () => {
          clearFocus();
          flash([v.measured_lat, v.measured_lng], color);
          fly([[v.measured_lat, v.measured_lng]], { maxZoom: 17, singleZoom: 17 });
        });
        marker.addTo(g);
      });
    });

    Lyr.tasks = make('tasks', (g) => {
      const priorityColor = { CRITICAL: '#dc2626', HIGH: '#f97316', MEDIUM: '#f59e0b', LOW: '#3b82f6' };
      data.open_tasks.forEach((x) => {
        if (!x.position) return;
        const color = priorityColor[x.priority] || '#64748b';
        const marker = L.marker([x.position[0], x.position[1]], {
          icon: L.divIcon({ className: '', html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${x.id}</div>` }),
        }).bindPopup(taskPopup(x));
        marker.on('click', () => {
          clearFocus();
          flash([x.position[0], x.position[1]], color, 24);
          fly([x.position], { maxZoom: 16, singleZoom: 16 });
        });
        marker.addTo(g);
      });
    });

    layerRefs.current = Lyr;
    applyVisibility();
    return () => {
      Object.values(Lyr).forEach((l) => { if (l && map.hasLayer(l)) map.removeLayer(l); });
      if (map.hasLayer(focusLayer)) map.removeLayer(focusLayer);
      if (focusRef.current === focusLayer) focusRef.current = null;
      layerRefs.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, bands, statusFilter, regionFilter, !hidden.towers, !hidden.assets, progressMode]);

  function applyVisibility() {
    const Lyr = layerRefs.current;
    const map = mapRef.current;
    Object.keys(Lyr).forEach((k) => {
      const layer = Lyr[k];
      if (layer && map) {
        if (hidden[k]) {
          map.removeLayer(layer);
        } else if (!map.hasLayer(layer)) {
          map.addLayer(layer);
        }
      }
    });
  }

  useEffect(() => { if (data) applyVisibility(); }, [hidden, data]);

  // When the user picks a region, move the map to that region's ground so a
  // filter change is visible immediately instead of leaving the viewport
  // elsewhere (which reads as "nothing selected").
  const regionZoomRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    if (regionFilter === 'ALL') { regionZoomRef.current = false; return; }
    const region = (data.regions || []).find((r) => String(r.id) === String(regionFilter));
    if (!region) return;
    const hasBoundary = Array.isArray(region.boundary_json) && region.boundary_json.length >= 3;
    const pts = hasBoundary
      ? region.boundary_json
      : circleCorners(region.center[0], region.center[1], (Number(region.boundary) || 0) * 111320);
    if (pts.length > 1) flyToPoints(map, pts, { maxZoom: 11, padding: [48, 48], singleZoom: 11 });
    else if (Array.isArray(region.center)) map.flyTo(region.center, 10, { duration: 0.7 });
    regionZoomRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionFilter, data]);

  // How many mapped features each region actually carries, so a region that is
  // still empty (no imported infrastructure) is obvious before selecting it.
  const regionFeatureCount = useMemo(() => {
    if (!data) return {};
    const counts = {};
    const bump = (rid) => { if (rid == null) return; const k = String(rid); counts[k] = (counts[k] || 0) + 1; };
    (data.substations || []).forEach((s) => bump(s.region_id));
    (data.lines || []).forEach((l) => bump(l.region_id));
    (data.towers || []).forEach((t) => bump(t.region_id));
    (data.assets || []).forEach((a) => bump(a.region_id));
    (data.open_tasks || []).forEach((t) => bump(t.region_id));
    (data.geofences || []).forEach((g) => bump(g.region_id));
    return counts;
  }, [data]);

  const searchIndex = useMemo(() => {
    if (!data) return [];
    const items = [];
    const push = (o) => { if (o && o.latlng) items.push(o); };
    (data.regions || []).forEach((r) => {
      if (!r.center || !Number.isFinite(r.center[0])) return;
      const hasBoundary = Array.isArray(r.boundary_json) && r.boundary_json.length >= 3;
      const points = hasBoundary ? r.boundary_json.map((p) => [p[0], p[1]]) : circleCorners(r.center[0], r.center[1], (Number(r.boundary) || 0) * 111320);
      push({
        key: `region-${r.id}`, type: t('layerRegions'), label: r.name,
        meta: [r.code, r.status].filter(Boolean).join(' · '),
        color: REGION_COLOR, points, latlng: [r.center[0], r.center[1]], singleZoom: 10, maxZoom: 10,
        popup: regionPopup(r),
      });
    });
    (data.lines || []).forEach((l) => {
      if (!Array.isArray(l.route) || l.route.length < 2) return;
      const b = boundsOf(l.route);
      push({
        key: `line-${l.id}`, type: t('layerLines'), label: l.name,
        meta: [l.line_id, l.voltage_kv != null ? `${l.voltage_kv} kV` : null, l.status, l.region_name].filter(Boolean).join(' · '),
        color: l.color || '#f59e0b', points: l.route.map((p) => [p[0], p[1]]),
        latlng: b ? [b.getCenter().lat, b.getCenter().lng] : null, singleZoom: 12, maxZoom: 13,
        popup: linePopup(l),
      });
    });
    (data.substations || []).forEach((s) => {
      if (!s.position) return;
      push({
        key: `substation-${s.id}`, type: t('layerSubstations'), label: s.name,
        meta: [s.substation_id, s.voltage_kv != null ? `${s.voltage_kv} kV` : null, s.status, s.region_name].filter(Boolean).join(' · '),
        color: s.color, latlng: [s.position[0], s.position[1]], singleZoom: 16, popup: substationPopup(s),
      });
    });
    (data.towers || []).forEach((x) => {
      if (!x.position) return;
      push({
        key: `tower-${x.id}`, type: t('layerTowers'), label: x.tower_id,
        meta: [x.line_name, x.voltage_kv != null ? `${x.voltage_kv} kV` : null, x.status].filter(Boolean).join(' · '),
        color: x.color, latlng: [x.position[0], x.position[1]], singleZoom: 16, popup: () => towerPopup(x),
      });
    });
    (data.assets || []).forEach((a) => {
      if (!a.position) return;
      push({
        key: `asset-${a.id}`, type: t('layerAssets'), label: a.name,
        meta: [a.asset_id, a.asset_type, a.status].filter(Boolean).join(' · '),
        color: a.color, latlng: [a.position[0], a.position[1]], singleZoom: 16, popup: () => assetPopup(a),
      });
    });
    (data.open_tasks || []).forEach((x) => {
      if (!x.position) return;
      push({
        key: `task-${x.id}`, type: t('layerTasks'), label: `${x.task_number} · ${x.title}`,
        meta: [x.priority, x.status].filter(Boolean).join(' · '),
        color: '#0ea5e9', latlng: [x.position[0], x.position[1]], singleZoom: 16, popup: taskPopup(x),
      });
    });
    (data.geofences || []).forEach((f) => {
      if (!f.center || !Number.isFinite(f.center[0])) return;
      push({
        key: `geofence-${f.id}`, type: t('layerGeofences'), label: f.name,
        meta: [f.target_type, `${f.radius_m} m`].filter(Boolean).join(' · '),
        color: '#7c3aed', points: circleCorners(f.center[0], f.center[1], f.radius_m),
        latlng: [f.center[0], f.center[1]], singleZoom: 15, maxZoom: 15, popup: geofencePopup(f),
      });
    });
    (data.validation_alerts || []).forEach((v) => {
      if (v.measured_lat == null || v.measured_lng == null) return;
      push({
        key: `alert-${v.id}`, type: t('layerAlerts'), label: `GPS ${v.result} · ${v.target_type}`,
        meta: [v.distance_m != null ? `${v.distance_m} m` : null, v.violation].filter(Boolean).join(' · '),
        color: v.result === 'FAIL' ? '#dc2626' : '#f59e0b',
        latlng: [v.measured_lat, v.measured_lng], singleZoom: 17, popup: alertPopup(v),
      });
    });
    return items;
  }, [data]);

  function revealItem(item) {
    const map = mapRef.current;
    if (!map || !item) return;
    const focusLayer = focusRef.current;
    if (focusLayer) focusLayer.clearLayers();
    const color = item.color || '#dc2626';
    if (item.points && item.points.length > 1) {
      if (focusLayer) {
        L.polyline(item.points, { color, weight: 6, opacity: 0.75, dashArray: '10 8', className: 'tmms-target-line' }).addTo(focusLayer);
      }
      flyToPoints(map, item.points, { maxZoom: item.maxZoom || 14, padding: [60, 60], singleZoom: item.singleZoom || 14 });
    } else if (item.latlng) {
      map.flyTo(item.latlng, item.singleZoom || 16, { duration: 0.7 });
    }
    if (item.latlng && focusLayer) {
      const popup = typeof item.popup === 'function' ? item.popup() : item.popup;
      L.marker(item.latlng, { icon: flashIcon(color, 22), zIndexOffset: 900 }).bindPopup(popup).addTo(focusLayer);
    }
  }

  function toggle(k) {
    setHidden((h) => ({ ...h, [k]: !h[k] }));
  }

  function togglePanel(k) {
    setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  }

  function toggleBand(label) {
    setBands((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }

  function clearFilters() {
    setBands(new Set(VOLTAGE_BANDS.map((b) => b.label)));
    setStatusFilter('ALL');
    setRegionFilter('ALL');
  }

  const filtersActive = bands.size !== VOLTAGE_BANDS.length || statusFilter !== 'ALL' || regionFilter !== 'ALL';

  function fitBounds() {
    const map = mapRef.current;
    if (!map || !data) return;
    const pts = [];
    data.substations.forEach((s) => pts.push([s.position[0], s.position[1]]));
    data.lines.forEach((l) => (l.route || []).forEach((p) => pts.push([p[0], p[1]])));
    if (pts.length) flyToPoints(map, pts, { maxZoom: 13, padding: [48, 48], singleZoom: 11 });
    else map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  }

  async function locateMe() {
    const map = mapRef.current;
    if (!map) return;
    setLocating(true);
    try {
      const p = await getDevicePosition();
      map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 15));
      L.circleMarker([p.lat, p.lng], { radius: 10, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.2 }).addTo(map);
    } catch (e) {
      setError(e.message);
    } finally {
      setLocating(false);
    }
  }

  async function refresh() {
    setError(null);
    setData(null);
    try {
      setData(await api.get('/map/data'));
    } catch (e) {
      setError(e.message);
    }
  }

  function copyCoords() {
    if (!lastClick) return;
    try {
      navigator.clipboard.writeText(`${lastClick.lat}, ${lastClick.lng}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) { /* ignore */ }
  }

  return (
    <Page title={t('map')} crumbs="TMMS / Map"
      actions={<>
        {lastClick && (
          <button className="btn btn-sm" onClick={copyCoords}>
            {copied ? t('copied') : `${t('copyCoordinates')}: ${lastClick.lat}, ${lastClick.lng}`}
          </button>
        )}
        <button className="btn" onClick={locateMe} disabled={locating}>{locating ? t('loading') : t('locateMe')}</button>
        <button className="btn" onClick={fitBounds}>{t('fitBounds')}</button>
        <button className="btn" onClick={refresh}>{t('refreshMap')}</button>
      </>}>
      {error && <ErrorNote error={error} />}
      <div className="map-page-tools muted">{t('mapGuideClick')}</div>
      <div className="map-shell" ref={shellRef}>
        <div className="map-container" ref={mapEl} />
        {!data && <div className="map-loading"><Loading /></div>}

        <div className="map-panel map-panel--search">
          <MapSearchBox items={searchIndex} onSelect={revealItem} placeholder={t('mapSearch')} />
          <div className="map-basemap">
            <label>{t('mapBaseMap')}</label>
            <SearchSelect value={baseKey} onChange={(e) => setBaseKey(e.target.value)} aria-label={t('mapBaseMap')}>
              {BASE_LAYERS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
            </SearchSelect>
            <button type="button" className="map-btn" onClick={() => toggleFullscreen(shellRef.current)} title={isFull ? t('mapExitFullscreen') : t('mapFullscreen')}>
              {isFull ? t('mapExitFullscreen') : t('mapFullscreen')}
            </button>
            <button type="button" className="map-btn" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen} title={t('mapGuide')}>
              {t('mapGuide')}
            </button>
          </div>
          {helpOpen && (
            <div className="map-help">
              <b className="map-legend-title">{t('mapGuideTitle')}</b>
              {[
                'mapGuideSearch', 'mapGuideClick', 'mapGuideLayers', 'mapGuideFilters',
                'mapGuideBasemap', 'mapGuideFullscreen', 'mapGuideLocate', 'mapGuideFit', 'mapGuideCoords',
              ].map((k) => <div className="map-help-row" key={k}>{t(k)}</div>)}
            </div>
          )}
        </div>

        <Panel
          title={t('layers')}
          className="map-panel--layers"
          collapsed={collapsed.layers}
          onToggle={() => togglePanel('layers')}
        >
          {LAYERS.map((l) => (
            <label key={l.key} className="map-toggle">
              <input type="checkbox" checked={!hidden[l.key]} onChange={() => toggle(l.key)} />
              <span className="pill-dot" style={{ background: l.color }} />
              <span className="map-toggle-label">{t(l.labelKey)}</span>
              <b className="mono">{data ? l.count(data) : 0}</b>
            </label>
          ))}

          <label className="map-toggle">
            <input type="checkbox" checked={progressMode} onChange={() => setProgressMode((v) => !v)} />
            <span className="pill-dot" style={{ background: PROGRESS_COLORS.complete }} />
            <span className="map-toggle-label">Inspection progress</span>
          </label>

          <div className="map-panel-sep" />
          <div className="map-panel-sub">
            <span>{t('mapFilters')}</span>
            {filtersActive && <button type="button" className="map-link" onClick={clearFilters}>{t('mapClearFilters')}</button>}
          </div>
          <div className="map-chips">
            {VOLTAGE_BANDS.map((b) => {
              const on = bands.has(b.label);
              return (
                <button
                  type="button"
                  key={b.label}
                  className={`map-chip${on ? ' is-on' : ''}`}
                  onClick={() => toggleBand(b.label)}
                  aria-pressed={on}
                >
                  <span className="pill-dot" style={{ background: b.color }} />{b.label}
                </button>
              );
            })}
          </div>
          <SearchSelect className="map-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('mapFilters')}>
            <option value="ALL">{t('mapAllStatuses')}</option>
            <option value="ENERGIZED">{t('mapEnergized')}</option>
            <option value="NOT_ENERGIZED">{t('mapNotEnergized')}</option>
          </SearchSelect>
          <SearchSelect className="map-select" value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} aria-label={t('mapFilters')}>
            <option value="ALL">{t('mapAllRegions')}</option>
            {(data?.regions || []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}{regionFeatureCount[String(r.id)] ? ` (${regionFeatureCount[String(r.id)]})` : ' (0)'}
              </option>
            ))}
          </SearchSelect>
          {regionFilter !== 'ALL' && !regionFeatureCount[String(regionFilter)] && (
            <div className="muted" style={{ fontSize: 12, padding: '2px 2px 0' }}>
              {t('mapRegionEmpty')}
            </div>
          )}
        </Panel>

        <Panel
          title={t('mapLegend')}
          className="map-panel--legend"
          collapsed={collapsed.legend}
          onToggle={() => togglePanel('legend')}
        >
          <MapLegend groups={[
            {
              title: t('mapLegendLayers'),
              entries: [
                { label: t('layerRegions'), color: REGION_COLOR, shape: 'polygon' },
                { label: t('mapLegendSubstation'), color: '#22c55e', shape: 'yard' },
                { label: t('layerLines'), color: '#f59e0b', shape: 'line' },
                { label: t('layerTowers'), color: '#94a3b8', shape: 'dot' },
                { label: t('layerAssets'), color: '#a855f7', shape: 'dot' },
                { label: t('layerGeofences'), color: '#7c3aed', shape: 'circle', dash: true },
                { label: t('layerAlerts'), color: '#dc2626', shape: 'dot' },
                { label: t('layerTasks'), color: '#0ea5e9', shape: 'pin' },
              ],
              notes: [t('mapLegendLineWidth'), t('mapLegendGpsNote')],
            },
            ...(progressMode ? [{
              title: 'Inspection progress',
              entries: [
                { label: 'Not started', color: PROGRESS_COLORS.none, shape: 'line' },
                { label: 'In progress', color: PROGRESS_COLORS.partial, shape: 'line' },
                { label: 'Complete', color: PROGRESS_COLORS.complete, shape: 'line' },
              ],
            }] : []),
            { title: t('mapVoltageLegend'), entries: VOLTAGE_BANDS.map((b) => ({ label: b.label, color: b.color, shape: 'dot' })) },
            { title: t('mapStatusLegend'), entries: STATUS_LEGEND.map((k) => ({ label: k, color: STATUS_COLOR[k], shape: 'dot' })), notes: [t('mapLegendStatusNote')] },
          ]} />
        </Panel>

        <div className="map-page-coords" ref={coordsEl} />
      </div>
    </Page>
  );
}
