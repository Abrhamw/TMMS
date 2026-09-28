import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { flyToPoints, mapSizeReady, relatedSegment, pulseIcon, flashIcon, isEnergized, voltageChip, voltageLabel, popupRows } from '../mapFocus';
import MapSearchBox from './MapSearchBox';
import MapLegend from './MapLegend';
import { createBaseLayer, DEFAULT_BASE_KEY } from '../mapBase';
import { t } from '../i18n';

const EMPTY = [];
const TARGET_COLOR = '#dc2626';

function lineInfoPopup(info) {
  if (!info) return null;
  return `<div class="tmms-pop"><b>${info.name || info.line_id || 'Line'}</b> ${voltageChip(info.voltage_kv, { energized: isEnergized(info.operational_status) })}` +
    `<div class="tmms-pop-sub">${info.line_id || ''}</div>` +
    popupRows([
      ['Voltage', info.voltage_kv != null ? `${info.voltage_kv} kV` : null],
      ['From → To', (info.from_name || info.from_substation?.name || info.to_name || info.to_substation?.name)
        ? `${info.from_name || info.from_substation?.name || '?'} → ${info.to_name || info.to_substation?.name || '?'}` : null],
      ['Length', info.length_km != null ? `${info.length_km} km` : null],
      ['Conductor', info.conductor_type],
      ['Circuits', info.circuit_count],
      ['Status', info.operational_status],
    ]) + '</div>';
}

const COLORS = {
  existing: '#14532d',
  new: '#16a34a',
  edited: '#d97706',
  deleted: '#9ca3af',
  selected: '#2563eb',
  bulk: '#7c3aed',
  waypoint: '#0ea5e9',
  trace: '#ea580c',
  covered: '#16a34a',
  inspected: '#0d9488',
  remaining: '#94a3b8',
};

function dot(color, size = 14, border = '#fff') {
  return L.divIcon({
    className: 'lw-marker',
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${border};box-shadow:0 0 3px rgba(0,0,0,.55)"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function LineWorkspaceMap({
  route = [],
  towers = [],
  selectedId = null,
  targetTowerId = null,
  flashRoute = false,
  bulkSelected = null,
  routeMode = false,
  bulkMode = false,
  lineId = null,
  onSelect,
  onMove,
  onAddPoint,
  onRouteChange,
  onBoxSelect,
  onBulkToggle,
  lineInfo = null,
  height = 520,
  tracePoints = EMPTY,
  coveredPaths = EMPTY,
  inspectedIds = null,
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const boxRef = useRef(null);
  const dragStart = useRef(null);
  const fittedLine = useRef(null);
  const flownTarget = useRef(null);
  const pendingRef = useRef(null);
  const flushRef = useRef(() => {});
  const cbs = useRef({});
  const data = useRef({});
  const [legendOpen, setLegendOpen] = useState(false);
  cbs.current = { onSelect, onMove, onAddPoint, onRouteChange, onBoxSelect, onBulkToggle };
  data.current = { route, towers, routeMode, bulkMode, selectedId, targetTowerId, inspectedIds, lineInfo };

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false, scrollWheelZoom: true });
    mapRef.current = map;
    fittedLine.current = null;
    flownTarget.current = null;
    createBaseLayer(DEFAULT_BASE_KEY).addTo(map);
    map.setView([9.0, 39.0], 6);
    const flush = () => {
      const job = pendingRef.current;
      if (!job || !mapSizeReady(map)) return;
      pendingRef.current = null;
      job();
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
      layerRef.current = null;
    };
  }, []);

  // Fit once per line, as soon as that line's route/towers arrive.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lineId == null || fittedLine.current === lineId) return;
    const pts = route.map((p) => [p[0], p[1]])
      .concat(towers.filter((t) => t.lat != null && t.lng != null).map((t) => [t.lat, t.lng]));
    if (!pts.length) return;
    pendingRef.current = () => flyToPoints(map, pts, { maxZoom: 13, padding: [48, 48], singleZoom: 11 });
    fittedLine.current = lineId;
    flushRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId, route, towers]);

  // Rebuild route + tower layers whenever the working set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) layerRef.current.remove();
    const layer = L.layerGroup();
    layerRef.current = layer;

    coveredPaths.forEach((path) => {
      if (Array.isArray(path) && path.length > 1) {
        L.polyline(path, { color: COLORS.covered, weight: 6, opacity: 0.35 }).addTo(layer);
      }
    });
    if (route.length > 1) {
      const routeLine = L.polyline(route, { color: '#2563eb', weight: 3, opacity: 0.85 });
      const info = lineInfoPopup(data.current.lineInfo);
      if (info) routeLine.bindPopup(info);
      routeLine.addTo(layer);
    }
    const activeId = !routeMode && selectedId != null ? selectedId : (!routeMode ? targetTowerId : null);
    if (!routeMode && targetTowerId == null && selectedId == null && flashRoute && route.length > 1) {
      L.polyline(route, { color: TARGET_COLOR, weight: 6, opacity: 0.9, className: 'tmms-target-line' }).addTo(layer);
    }
    if (activeId != null && route.length > 1) {
      const sel = towers.find((t) => t.id === activeId);
      if (sel && sel.lat != null && sel.lng != null) {
        const seg = relatedSegment(route, sel.lat, sel.lng);
        if (seg.length > 1) {
          const lineColor = selectedId != null ? COLORS.selected : TARGET_COLOR;
          L.polyline(seg, { color: lineColor, weight: 6, opacity: 0.9, dashArray: '10 6', className: 'tmms-related-line' }).addTo(layer);
        }
      }
    }
    if (tracePoints.length > 1) {
      L.polyline(tracePoints, { color: COLORS.trace, weight: 3, opacity: 0.9 }).addTo(layer);
    }

    if (routeMode) {
      route.forEach((p, i) => {
        const m = L.marker([p[0], p[1]], { draggable: true, icon: dot(COLORS.waypoint, 12) }).addTo(layer);
        m.on('dragend', () => {
          cbs.current.onRouteChange && cbs.current.onRouteChange(
            route.map((q, j) => (j === i ? [m.getLatLng().lat, m.getLatLng().lng] : q))
          );
        });
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          cbs.current.onRouteChange && cbs.current.onRouteChange(route.filter((_, j) => j !== i));
        });
        m.bindTooltip(`Waypoint ${i + 1} — drag to move, click to remove`, { direction: 'top' });
      });
    } else {
      towers.forEach((t) => {
        if (t.lat == null || t.lng == null) return;
        const isSel = t.id === selectedId;
        const isTarget = t.id === targetTowerId;
        const isBulk = bulkSelected && bulkSelected.has(t.id);
        const inspection = inspectedIds instanceof Set;
        const isInspected = inspection && inspectedIds.has(t.id);
        const color = inspection
          ? (isInspected ? COLORS.inspected : COLORS.remaining)
          : (isSel ? COLORS.selected : isTarget ? TARGET_COLOR : isBulk ? COLORS.bulk : (COLORS[t.state] || COLORS.existing));
        const icon = isSel
          ? pulseIcon(color, 22)
          : isTarget
            ? flashIcon(TARGET_COLOR, 22)
            : dot(color, isSel || isBulk ? 17 : 14);
        const m = L.marker([t.lat, t.lng], {
          draggable: t.state !== 'deleted',
          icon,
          opacity: t.state === 'deleted' ? 0.45 : 1,
          zIndexOffset: isSel || isTarget ? 500 : 0,
        }).addTo(layer);
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (cbs.current.bulkMode) cbs.current.onBulkToggle && cbs.current.onBulkToggle(t.id);
          else cbs.current.onSelect && cbs.current.onSelect(t.id);
        });
        m.on('dragend', () => cbs.current.onMove && cbs.current.onMove(t.id, m.getLatLng().lat, m.getLatLng().lng));
        const info = data.current.lineInfo;
        const kvLabel = info && info.voltage_kv != null ? ` · ${voltageLabel(info.voltage_kv)}` : '';
        m.bindTooltip(
          `${t.tower_id}${kvLabel}${isInspected ? ' · inspected' : ''}${t.state && t.state !== 'existing' ? ` · ${t.state}` : ''}`,
          { direction: 'top' }
        );
      });
    }

    layer.addTo(map);
  }, [route, towers, selectedId, targetTowerId, flashRoute, bulkSelected, routeMode, bulkMode, tracePoints, coveredPaths, inspectedIds, lineInfo]);

  // Animate a perfect-fit zoom to the selected or target tower with its line.
  useEffect(() => {
    const map = mapRef.current;
    const activeId = selectedId != null ? selectedId : targetTowerId;
    if (!map || routeMode) return;
    if (activeId == null) { flownTarget.current = null; return; }
    if (flownTarget.current === activeId) return;
    const sel = (data.current.towers || []).find((t) => t.id === activeId);
    if (!sel || sel.lat == null || sel.lng == null) return;
    const seg = relatedSegment(data.current.route || [], sel.lat, sel.lng);
    flownTarget.current = activeId;
    pendingRef.current = () => flyToPoints(map, [[sel.lat, sel.lng], ...seg], { maxZoom: 16, padding: [60, 60], singleZoom: 16 });
    flushRef.current();
  }, [selectedId, targetTowerId, routeMode, towers, route]);

  // Click on the map: append a route waypoint (route mode) or stage a new tower.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e) => {
      if (data.current.bulkMode || data.current.routeMode) {
        if (data.current.routeMode) {
          const lat = +e.latlng.lat.toFixed(6);
          const lng = +e.latlng.lng.toFixed(6);
          cbs.current.onRouteChange && cbs.current.onRouteChange([...data.current.route, [lat, lng]]);
        }
        return;
      }
      cbs.current.onAddPoint && cbs.current.onAddPoint(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6));
    };
    map.on('click', handler);
    return () => map.off('click', handler);
  }, []);

  // Box-select: disable panning and drag a rectangle while bulk mode is on.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!bulkMode) {
      if (boxRef.current) { boxRef.current.remove(); boxRef.current = null; }
      dragStart.current = null;
      return;
    }
    map.dragging.disable();
    const boundsFrom = (a, b) => L.latLngBounds(a, b);
    const onDown = (e) => {
      const target = e.originalEvent && e.originalEvent.target;
      if (target && typeof target.closest === 'function' && target.closest('.lw-marker')) return;
      dragStart.current = e.latlng;
    };
    const onMoveEv = (e) => {
      if (!dragStart.current) return;
      if (boxRef.current) boxRef.current.remove();
      boxRef.current = L.rectangle(boundsFrom(dragStart.current, e.latlng), { color: '#7c3aed', weight: 1, fillOpacity: 0.08 }).addTo(map);
    };
    const onUp = (e) => {
      if (!dragStart.current) return;
      const b = boundsFrom(dragStart.current, e.latlng);
      const ids = data.current.towers
        .filter((t) => t.lat != null && t.lng != null && t.state !== 'deleted' && b.contains([t.lat, t.lng]))
        .map((t) => t.id);
      if (boxRef.current) { boxRef.current.remove(); boxRef.current = null; }
      dragStart.current = null;
      cbs.current.onBoxSelect && cbs.current.onBoxSelect(ids);
    };
    map.on('mousedown', onDown);
    map.on('mousemove', onMoveEv);
    map.on('mouseup', onUp);
    return () => {
      map.off('mousedown', onDown);
      map.off('mousemove', onMoveEv);
      map.off('mouseup', onUp);
      map.dragging.enable();
      if (boxRef.current) { boxRef.current.remove(); boxRef.current = null; }
    };
  }, [bulkMode]);

  const searchItems = useMemo(() => towers
    .filter((tw) => tw.lat != null && tw.lng != null)
    .map((tw) => ({
      key: `t-${tw.id}`,
      id: tw.id,
      type: t('layerTowers'),
      label: tw.tower_id,
      meta: tw.km_marker != null ? `${tw.km_marker} km` : '',
      color: COLORS[tw.state] || COLORS.existing,
      at: { lat: tw.lat, lng: tw.lng },
    })), [towers]);

  const legendGroups = useMemo(() => {
    const groups = [];
    if (routeMode) {
      groups.push({
        title: t('lwLegendRoutes'),
        entries: [
          { label: t('lwRoute'), color: '#2563eb', shape: 'line' },
          { label: t('lwWaypoint'), color: COLORS.waypoint, shape: 'dot' },
        ],
        notes: [t('addWaypointHint')],
      });
      return groups;
    }
    groups.push({
      title: t('lwLegendStates'),
      entries: [
        { label: t('lwStateExisting'), color: COLORS.existing, shape: 'dot' },
        { label: t('lwStateNew'), color: COLORS.new, shape: 'dot' },
        { label: t('lwStateEdited'), color: COLORS.edited, shape: 'dot' },
        { label: t('lwStateDeleted'), color: COLORS.deleted, shape: 'dot' },
      ],
    });
    groups.push({
      title: t('lwLegendFocus'),
      entries: [
        { label: t('lwSelected'), color: COLORS.selected, shape: 'pin' },
        { label: t('lwTarget'), color: TARGET_COLOR, shape: 'pin' },
        ...(bulkMode ? [{ label: t('lwBulkSel'), color: COLORS.bulk, shape: 'dot' }] : []),
      ],
      notes: bulkMode ? [t('lwBoxNote')] : [],
    });
    const progress = inspectedIds instanceof Set;
    if (progress || coveredPaths.length || tracePoints.length) {
      groups.push({
        title: progress ? t('lwLegendProgress') : t('lwLegendRoutes'),
        entries: [
          { label: t('lwRoute'), color: '#2563eb', shape: 'line' },
          ...(progress ? [
            { label: t('lwInspected'), color: COLORS.inspected, shape: 'dot' },
            { label: t('lwRemaining'), color: COLORS.remaining, shape: 'dot' },
          ] : []),
          ...(coveredPaths.length ? [{ label: t('lwCovered'), color: COLORS.covered, shape: 'line' }] : []),
          ...(tracePoints.length ? [{ label: t('lwTrace'), color: COLORS.trace, shape: 'line' }] : []),
        ],
      });
    }
    return groups;
  }, [routeMode, bulkMode, inspectedIds, coveredPaths, tracePoints]);

  function focusTower(it) {
    const map = mapRef.current;
    if (!map || !it.at) return;
    map.flyTo([it.at.lat, it.at.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
    if (cbs.current.onSelect) cbs.current.onSelect(it.id);
  }

  return (
    <div className="lw-map-wrap" style={{ height, width: '100%' }}>
      <div ref={elRef} className="line-workspace-map" style={{ height: '100%', width: '100%' }} />
      {searchItems.length > 0 && (
        <div className="map-mini-search">
          <MapSearchBox items={searchItems} onSelect={focusTower} placeholder={t('mapSearch')} />
        </div>
      )}
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
    </div>
  );
}
