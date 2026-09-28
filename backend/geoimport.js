const AdmZip = require('adm-zip');
const { haversine } = require('./geo');

function coordsToKm(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    m += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return Math.round((m / 1000) * 100) / 100;
}

function parsePair(str) {
  const p = String(str).split(',').map(Number);
  return p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null;
}

function kmlToLatLng(text) {
  const blocks = [...String(text).matchAll(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi)];
  if (!blocks.length) throw new Error('KML contains no <coordinates> block');
  const pairs = blocks[0][1].trim().split(/\s+/).map(parsePair).filter(Boolean);
  if (pairs.length < 2) throw new Error('KML coordinates need at least 2 points');
  return pairs.map(([lng, lat]) => [lat, lng]);
}

function geojsonToLatLng(text) {
  const g = JSON.parse(text);
  const feat = g.type === 'FeatureCollection' ? (g.features && g.features[0]) : (g.type === 'Feature' ? g : (g.type ? g : null));
  if (!feat) throw new Error('GeoJSON contains no feature');
  const geom = feat.geometry || feat;
  if (!geom || geom.type !== 'LineString') throw new Error('GeoJSON must contain a LineString');
  const pairs = (geom.coordinates || []).map(parsePair).filter(Boolean);
  if (pairs.length < 2) throw new Error('GeoJSON LineString needs at least 2 points');
  return pairs.map(([lng, lat]) => [lat, lng]);
}

function wktToLatLng(text) {
  const m = String(text).match(/LINESTRING\s*\(\s*([\s\S]*?)\)/i);
  if (!m) throw new Error('WKT must be LINESTRING(lng lat, ...)');
  const pairs = m[1].split(',').map((tok) => {
    const n = tok.trim().split(/\s+/).map(Number);
    return n.length >= 2 && Number.isFinite(n[0]) && Number.isFinite(n[1]) ? [n[0], n[1]] : null;
  }).filter(Boolean);
  if (pairs.length < 2) throw new Error('WKT needs at least 2 points');
  return pairs.map(([lng, lat]) => [lat, lng]);
}

function csvToLatLng(text) {
  const rows = String(text).split(/\r?\n/).map((line) => line.split(',').map(Number))
    .filter((r) => r.length >= 2 && r.slice(0, 2).every(Number.isFinite)).map((r) => r.slice(0, 2));
  if (rows.length < 2) throw new Error('CSV needs at least two coordinate rows');
  const latFirst = rows.every(([a]) => Math.abs(a) <= 90) && rows.some(([, b]) => Math.abs(b) > 90);
  return rows.map(([a, b]) => (latFirst ? [a, b] : [b, a]));
}

function extractKmzText(base64) {
  let zip;
  try { zip = new AdmZip(Buffer.from(base64, 'base64')); } catch (e) { throw new Error('Invalid KMZ (base64 zip)'); }
  const entry = zip.getEntries().find((en) => /\.kml$/i.test(en.entryName));
  if (!entry) throw new Error('No .kml entry inside KMZ');
  return entry.getData().toString('utf8');
}

function extractPlacemarks(kmlText) {
  const out = [];
  const marks = String(kmlText).matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi);
  for (const m of marks) {
    const body = m[1];
    const nm = body.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
    const cs = [...body.matchAll(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi)];
    if (!cs.length) continue;
    const pair = parsePair(cs[0][1].trim().split(/\s+/)[0]);
    if (!pair) continue;
    out.push({
      name: (nm ? nm[1].trim() : '') || 'Unnamed',
      kind: /<Point[\s/>]/i.test(body) ? 'Point' : 'LineString',
      lat: pair[1],
      lng: pair[0],
    });
  }
  return out;
}

function parseRouteGeometry(format, content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content is required');
  let coords;
  if (format === 'geojson') coords = geojsonToLatLng(content);
  else if (format === 'kml') coords = kmlToLatLng(content);
  else if (format === 'kmz') coords = kmlToLatLng(extractKmzText(content));
  else if (format === 'wkt') coords = wktToLatLng(content);
  else if (format === 'csv') coords = csvToLatLng(content);
  else throw new Error(`Unknown format: ${format}`);
  for (const [lat, lng] of coords) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('Coordinate out of range');
  }
  return coords;
}

module.exports = { parseRouteGeometry, coordsToKm, extractKmzText, extractPlacemarks };
