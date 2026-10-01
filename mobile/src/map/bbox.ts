import type { MapLine } from '../api/mapTypes';

export type Bounds = [number, number, number, number];

export function boundsForLine(line: MapLine): Bounds | null {
  const route = line.route;
  if (!Array.isArray(route) || route.length < 2) return null;
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  let points = 0;
  for (const point of route) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [lat, lng] = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    points += 1;
  }
  if (points < 2) return null;
  const padLat = Math.max((north - south) * 0.1, 0.01);
  const padLng = Math.max((east - west) * 0.1, 0.01);
  return [west - padLng, south - padLat, east + padLng, north + padLat];
}
