import { useEffect, useMemo, useState } from 'react';
import { MapPin, Route, Zap } from 'lucide-react';
import { api, asArray } from '../api';
import ViewMap from './ViewMap';
import { t } from '../i18n';
import {
  entityColor,
  maxVoltageKv,
  isEnergized,
  parseVoltageLevels,
  voltageChip,
  popupRows,
  boundaryRing,
  circleCorners,
} from '../mapFocus';

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function schematicKind(item) {
  if (!item) return null;
  if (item.type === 'line' || item.type === 'substation' || item.type === 'tower' || item.type === 'region') return item.type;
  if (item.type === 'asset') return 'asset';
  if (item.type === 'task' || item.type === 'schedule') return item.type;
  return null;
}

function fetchFor(item) {
  const kind = schematicKind(item);
  if (!kind || item.id == null) return Promise.resolve(null);
  if (kind === 'line') return api.get(`/lines/${item.id}`);
  if (kind === 'substation') return api.get(`/substations/${item.id}`);
  if (kind === 'tower') {
    return api.get(`/towers/${item.id}`).then(async (tw) => {
      if (tw?.line_id) {
        try { tw.line = await api.get(`/lines/${tw.line_id}`); } catch (_) { /* keep tower pin */ }
      }
      return tw;
    });
  }
  if (kind === 'region') {
    return Promise.all([
      api.get(`/regions/${item.id}`),
      api.get(`/substations?region_id=${item.id}`).catch(() => []),
    ]).then(([region, substations]) => ({ ...region, substations: Array.isArray(substations) ? substations : [] }));
  }
  if (kind === 'asset') return api.get(`/assets/${item.id}`);
  if (kind === 'task') return api.get(`/tasks/${item.id}`);
  if (kind === 'schedule') return api.get(`/schedules/${item.id}`).catch(() => null);
  return Promise.resolve(null);
}

function subMarker(s, sub) {
  if (!s || num(s.latitude) == null || num(s.longitude) == null) return null;
  const kv = maxVoltageKv(s.voltage_levels);
  return {
    lat: s.latitude,
    lng: s.longitude,
    label: s.name,
    sub,
    color: entityColor(kv, s.operational_status),
    popup: `<div class="tmms-pop"><b>${s.name}</b> ${voltageChip(kv, { energized: isEnergized(s.operational_status) })}` +
      `<div class="tmms-pop-sub">${s.substation_id || ''}</div>` +
      popupRows([
        ['Voltage', parseVoltageLevels(s.voltage_levels).join(', ') || null],
        ['Type', s.substation_type],
        ['Status', s.operational_status],
      ]) + '</div>',
  };
}

function subPerimeter(s, sub) {
  const ring = boundaryRing(s && s.boundary_json);
  if (!ring) return null;
  const kv = maxVoltageKv(s.voltage_levels);
  return {
    points: ring,
    color: entityColor(kv, s.operational_status),
    label: `${s.name} perimeter`,
    sub,
  };
}

function mapFromRecord(item, data) {
  if (!data) return null;
  const kind = schematicKind(item);
  if (kind === 'line') {
    const route = asArray(data.route_json);
    const kv = data.voltage_kv;
    const status = data.operational_status;
    return {
      title: data.name || item.title,
      caption: [data.line_id, kv != null ? `${kv} kV` : null, data.from_substation?.name, data.to_substation?.name].filter(Boolean).join(' · '),
      mode: 'line',
      markers: [
        subMarker(data.from_substation, 'From'),
        subMarker(data.to_substation, 'To'),
        ...(data.towers || []).filter((tw) => num(tw.latitude) != null).map((tw) => ({
          lat: tw.latitude,
          lng: tw.longitude,
          radius: 4,
          color: entityColor(kv, status),
          popup: `<div class="tmms-pop"><b>${tw.tower_id || tw.tower_number}</b>${popupRows([
            ['Type', tw.tower_type],
            ['km', tw.km_marker],
          ])}</div>`,
        })),
      ].filter(Boolean),
      polylines: route.length ? [{
        points: route,
        label: data.name,
        color: entityColor(kv, status),
        weight: 5,
        flash: true,
      }] : [],
      polygons: [subPerimeter(data.from_substation, 'From'), subPerimeter(data.to_substation, 'To')].filter(Boolean),
      focus: route.length ? route : null,
    };
  }
  if (kind === 'substation') {
    const kv = maxVoltageKv(data.voltage_levels);
    const ring = boundaryRing(data.boundary_json);
    const lines = data.connected_lines || [];
    return {
      title: data.name || item.title,
      caption: [data.substation_id, parseVoltageLevels(data.voltage_levels).join(' / '), data.region?.name].filter(Boolean).join(' · '),
      mode: 'substation',
      center: num(data.latitude) != null ? { lat: data.latitude, lng: data.longitude } : null,
      markers: [
        num(data.latitude) != null ? {
          lat: data.latitude,
          lng: data.longitude,
          label: data.name,
          flash: true,
          color: entityColor(kv, data.operational_status),
        } : null,
        ...(data.assets || []).filter((a) => num(a.latitude) != null).map((a) => ({
          lat: a.latitude,
          lng: a.longitude,
          radius: 4,
          color: entityColor(kv, a.operational_status),
          popup: `<div class="tmms-pop"><b>${a.name || a.asset_id}</b></div>`,
        })),
      ].filter(Boolean),
      polylines: lines.flatMap((l) => {
        const route = asArray(l.route_json);
        if (!route.length) return [];
        return [{ points: route, color: entityColor(l.voltage_kv, l.operational_status), weight: 3, label: l.name }];
      }),
      polygons: ring ? [{ points: ring, color: entityColor(kv, data.operational_status), label: `${data.name} yard` }] : [],
      focus: ring || (num(data.latitude) != null ? [[data.latitude, data.longitude]] : null),
    };
  }
  if (kind === 'tower') {
    const line = data.line || null;
    const route = asArray(line && line.route_json);
    return {
      title: data.tower_id || item.title,
      caption: [line?.name, data.tower_type, data.km_marker != null ? `km ${data.km_marker}` : null].filter(Boolean).join(' · '),
      mode: 'line',
      center: num(data.latitude) != null ? { lat: data.latitude, lng: data.longitude } : null,
      markers: [
        num(data.latitude) != null ? {
          lat: data.latitude,
          lng: data.longitude,
          label: data.tower_id,
          flash: true,
          color: entityColor(line?.voltage_kv, line?.operational_status),
        } : null,
        subMarker(line?.from_substation, 'From'),
        subMarker(line?.to_substation, 'To'),
      ].filter(Boolean),
      polylines: route.length ? [{ points: route, color: entityColor(line?.voltage_kv, line?.operational_status), weight: 4, label: line?.name }] : [],
      polygons: [],
      focus: num(data.latitude) != null ? [[data.latitude, data.longitude]] : route,
    };
  }
  if (kind === 'region') {
    const ring = boundaryRing(data.boundary_json);
    const subs = data.substations || [];
    return {
      title: data.name || item.title,
      caption: [data.code, data.type].filter(Boolean).join(' · '),
      mode: 'region',
      center: num(data.center_lat) != null ? { lat: data.center_lat, lng: data.center_lng } : null,
      markers: [
        num(data.center_lat) != null ? { lat: data.center_lat, lng: data.center_lng, label: data.name, color: '#14532d', flash: true } : null,
        ...subs.filter((s) => num(s.latitude) != null).map((s) => subMarker(s, s.substation_id)).filter(Boolean),
      ].filter(Boolean),
      polylines: [],
      polygons: ring ? [{ points: ring, label: `${data.name} boundary`, color: '#2563eb' }] : [],
      radius: data.boundary ? Number(data.boundary) * 111320 : null,
      radiusLatLng: num(data.center_lat) != null ? { lat: data.center_lat, lng: data.center_lng } : null,
      focus: ring || circleCorners(data.center_lat, data.center_lng, Number(data.boundary || 0) * 111320),
    };
  }
  if (kind === 'asset') {
    const sub = data.substation || null;
    const line = data.line || null;
    const tower = data.tower || null;
    const route = asArray(line && line.route_json);
    const pin = num(data.latitude) != null
      ? { lat: data.latitude, lng: data.longitude }
      : (tower && num(tower.latitude) != null ? { lat: tower.latitude, lng: tower.longitude } : null);
    return {
      title: data.name || data.asset_id || item.title,
      caption: [data.asset_id, data.asset_type, sub?.name || line?.name].filter(Boolean).join(' · '),
      mode: line ? 'line' : 'substation',
      center: pin,
      markers: [
        pin ? { ...pin, label: data.name || data.asset_id, flash: true, color: '#dc2626' } : null,
        subMarker(sub, 'Substation'),
        tower && num(tower.latitude) != null ? { lat: tower.latitude, lng: tower.longitude, label: tower.tower_id, color: '#334155' } : null,
      ].filter(Boolean),
      polylines: route.length ? [{ points: route, color: entityColor(line?.voltage_kv, line?.operational_status), weight: 4 }] : [],
      polygons: [subPerimeter(sub, 'Yard')].filter(Boolean),
      focus: pin ? [[pin.lat, pin.lng]] : route,
    };
  }
  if (kind === 'task' || kind === 'schedule') {
    const line = data.line || null;
    const sub = data.substation || null;
    const tower = data.tower || null;
    const asset = data.asset || null;
    const route = asArray(line && line.route_json);
    const pin = tower && num(tower.latitude) != null
      ? { lat: tower.latitude, lng: tower.longitude }
      : (asset && num(asset.latitude) != null ? { lat: asset.latitude, lng: asset.longitude }
        : (sub && num(sub.latitude) != null ? { lat: sub.latitude, lng: sub.longitude } : null));
    if (!pin && !route.length) return null;
    return {
      title: data.title || data.schedule_name || item.title,
      caption: [data.task_number || data.schedule_code, line?.name || sub?.name].filter(Boolean).join(' · '),
      mode: line ? 'line' : 'substation',
      center: pin,
      markers: [
        pin ? { ...pin, label: item.title, flash: true, color: '#dc2626' } : null,
        subMarker(sub, 'Substation'),
      ].filter(Boolean),
      polylines: route.length ? [{ points: route, color: entityColor(line?.voltage_kv, line?.operational_status), weight: 4 }] : [],
      polygons: [subPerimeter(sub, 'Yard')].filter(Boolean),
      focus: pin ? [[pin.lat, pin.lng]] : route,
    };
  }
  return null;
}

export default function SearchSchematic({ item, onOpen }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item || item.can_open === false) {
      setData(null);
      setErr(null);
      setLoading(false);
      return undefined;
    }
    let live = true;
    setLoading(true);
    setErr(null);
    fetchFor(item)
      .then((row) => { if (live) { setData(row); setLoading(false); } })
      .catch((e) => { if (live) { setErr(e.message); setData(null); setLoading(false); } });
    return () => { live = false; };
  }, [item?.type, item?.id]);

  const map = useMemo(() => mapFromRecord(item, data), [item, data]);

  if (!item) {
    return (
      <div className="search-schematic-empty">
        <div className="search-schematic-hero">
          <Route size={28} strokeWidth={1.6} />
          <b>{t('searchSchematicTitle')}</b>
          <span>{t('searchSchematicHint')}</span>
        </div>
        <div className="search-chip-row">
          <span className="search-chip"><Zap size={12} /> {t('searchChipLine')}</span>
          <span className="search-chip"><MapPin size={12} /> {t('searchChipSs')}</span>
        </div>
      </div>
    );
  }

  if (item.can_open === false) {
    return (
      <div className="search-schematic-empty">
        <b>{item.title}</b>
        <span>{t('searchViewOnly')}</span>
      </div>
    );
  }

  return (
    <div className="search-schematic">
      <div className="search-schematic-head">
        <div>
          <div className="search-schematic-kicker">{item.tag || item.type}</div>
          <h3>{map?.title || item.title}</h3>
          <div className="muted">{map?.caption || item.subtitle || item.description}</div>
        </div>
        {onOpen && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen(item)}>
            {t('searchViewRecord')}
          </button>
        )}
      </div>
      {loading && <div className="gs-note">{t('search')}…</div>}
      {err && <div className="gs-note gs-error">{err}</div>}
      {!loading && map && (
        <div className="search-schematic-map">
          <ViewMap
            height={360}
            maxWidth={1200}
            center={map.center}
            markers={map.markers || []}
            polylines={map.polylines || []}
            polygons={map.polygons || []}
            radius={map.radius || null}
            radiusLatLng={map.radiusLatLng || null}
            focus={map.focus}
            focusKey={`${item.type}-${item.id}`}
          />
        </div>
      )}
      {!loading && !err && !map && (
        <div className="search-schematic-empty compact">
          <span>{t('searchSchematicNone')}</span>
        </div>
      )}
    </div>
  );
}
