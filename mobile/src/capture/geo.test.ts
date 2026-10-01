import { describe, expect, it } from 'vitest';
import { distanceMeters, formatDistance, totalDistanceMeters } from './geo';

describe('geo helpers', () => {
  it('measures a short distance between nearby points', () => {
    const meters = distanceMeters({ lat: 9.0, lng: 38.0 }, { lat: 9.001, lng: 38.0 });
    expect(meters).toBeGreaterThan(100);
    expect(meters).toBeLessThan(120);
  });

  it('sums a multi-point path', () => {
    const total = totalDistanceMeters([
      { lat: 9.0, lng: 38.0 },
      { lat: 9.001, lng: 38.0 },
      { lat: 9.002, lng: 38.0 },
    ]);
    expect(total).toBeGreaterThan(200);
    expect(total).toBeLessThan(240);
  });

  it('formats metres and kilometres', () => {
    expect(formatDistance(450)).toBe('450 m');
    expect(formatDistance(1500)).toBe('1.50 km');
  });
});
