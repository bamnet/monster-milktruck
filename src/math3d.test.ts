import { describe, expect, test } from 'bun:test';
import { clamp, degToRad, fixAngle, offsetToLatLng } from './math3d.ts';

describe('math3d', () => {
  test('clamp restricts values to [lo, hi]', () => {
    expect(clamp(-50, -30, 30)).toBe(-30);
    expect(clamp(50, -30, 30)).toBe(30);
    expect(clamp(12, -30, 30)).toBe(12);
    expect(clamp(-30, -30, 30)).toBe(-30);
    expect(clamp(30, -30, 30)).toBe(30);
    expect(clamp(5, 5, 5)).toBe(5);
  });

  test('fixAngle normalizes angles into [-180, 180) across seam and multi-turn wraps', () => {
    expect(fixAngle(0)).toBe(0);
    expect(fixAngle(180)).toBe(-180);
    expect(fixAngle(-180)).toBe(-180);
    expect(fixAngle(270)).toBe(-90);
    expect(fixAngle(-270)).toBe(90);
    expect(fixAngle(540)).toBe(-180);
    expect(fixAngle(-540)).toBe(-180);
    expect(fixAngle(720)).toBe(0);
    expect(fixAngle(179.99)).toBeCloseTo(179.99, 6);
    expect(fixAngle(-180.01)).toBeCloseTo(179.99, 6);
  });

  test('degToRad converts positive, negative, and full-circle degrees to radians', () => {
    expect(degToRad(0)).toBe(0);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 10);
    expect(degToRad(-90)).toBeCloseTo(-Math.PI / 2, 10);
    expect(degToRad(180)).toBeCloseTo(Math.PI, 10);
    expect(degToRad(360)).toBeCloseTo(Math.PI * 2, 10);
  });

  test('offsetToLatLng offsets coordinates in meters along east and north axes', () => {
    const start = { lat: 37.423501, lng: -122.086744 };
    const northMoved = offsetToLatLng(start.lat, start.lng, 0, 100);
    expect(northMoved.lat).toBeGreaterThan(start.lat);
    expect(northMoved.lng).toBeCloseTo(start.lng, 10);

    const eastMoved = offsetToLatLng(start.lat, start.lng, 100, 0);
    expect(eastMoved.lat).toBeCloseTo(start.lat, 10);
    expect(eastMoved.lng).toBeGreaterThan(start.lng);

    // At 60°N (cos 60° = 0.5), 1000 m east spans twice the longitude degrees as at the equator
    const eqEast = offsetToLatLng(0, 0, 1000, 0);
    const highLatEast = offsetToLatLng(60, 0, 1000, 0);
    expect(highLatEast.lng / eqEast.lng).toBeCloseTo(2.0, 5);
  });

  test('offsetToLatLng wraps cleanly across the antimeridian and clamps near the poles', () => {
    const eastAcrossSeam = offsetToLatLng(0, 179.999, 500, 0);
    expect(eastAcrossSeam.lng).toBeGreaterThanOrEqual(-180);
    expect(eastAcrossSeam.lng).toBeLessThan(-179.99);

    const westAcrossSeam = offsetToLatLng(0, -179.999, -500, 0);
    expect(westAcrossSeam.lng).toBeLessThan(180);
    expect(westAcrossSeam.lng).toBeGreaterThan(179.99);

    const nearNorthPole = offsetToLatLng(89.9999, 45, 1000, 1000);
    expect(nearNorthPole.lat).toBe(90);
    expect(Number.isFinite(nearNorthPole.lng)).toBe(true);
    expect(nearNorthPole.lng).toBeGreaterThanOrEqual(-180);
    expect(nearNorthPole.lng).toBeLessThan(180);

    const nearSouthPole = offsetToLatLng(-89.9999, -120, -1000, -1000);
    expect(nearSouthPole.lat).toBe(-90);
    expect(Number.isFinite(nearSouthPole.lng)).toBe(true);
  });
});
