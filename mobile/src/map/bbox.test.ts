import { describe, expect, it } from 'vitest';
import { boundsForLine } from './bbox';
import type { MapLine } from '../api/mapTypes';

function line(route: MapLine['route']): MapLine {
  return { id: 1, route };
}

describe('boundsForLine', () => {
  it('returns a padded west/south/east/north box for a route', () => {
    const bounds = boundsForLine(
      line([
        [9.0, 38.0],
        [9.2, 38.4],
      ]),
    );
    expect(bounds).not.toBeNull();
    const [west, south, east, north] = bounds!;
    expect(west).toBeLessThan(38.0);
    expect(south).toBeLessThan(9.0);
    expect(east).toBeGreaterThan(38.4);
    expect(north).toBeGreaterThan(9.2);
  });

  it('returns null when there is no usable route', () => {
    expect(boundsForLine(line(null))).toBeNull();
    expect(boundsForLine(line([[9.0, 38.0]]))).toBeNull();
  });

  it('skips malformed points', () => {
    const bounds = boundsForLine(
      line([
        [9.0, 38.0],
        [Number.NaN, 38.1],
        [9.1, 38.2],
      ]),
    );
    expect(bounds).not.toBeNull();
  });
});
