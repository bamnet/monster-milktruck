import { describe, expect, test } from 'bun:test';
import { clamp, degToRad, fixAngle, offsetToLatLng } from './math3d.ts';

describe('math3d', () => {
  test('clamp restricts values to [lo, hi]', () => {
    expect(clamp(-50, -30, 30)).toBe(-30);
    expect(clamp(50, -30, 30)).toBe(30);
    expect(clamp(12, -30, 30)).toBe(12);
  });

  test('fixAngle normalizes angles into [-180, 180)', () => {
    expect(fixAngle(0)).toBe(0);
    expect(fixAngle(180)).toBe(-180);
    expect(fixAngle(-180)).toBe(-180);
    expect(fixAngle(270)).toBe(-90);
    expect(fixAngle(-270)).toBe(90);
    expect(fixAngle(540)).toBe(-180);
  });

  test('degToRad converts degrees to radians', () => {
    expect(degToRad(0)).toBe(0);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 10);
    expect(degToRad(180)).toBeCloseTo(Math.PI, 10);
  });

  test('offsetToLatLng offsets coordinates in meters along east and north axes', () => {
    const start = { lat: 37.423501, lng: -122.086744 };
    const northMoved = offsetToLatLng(start.lat, start.lng, 0, 100);
    expect(northMoved.lat).toBeGreaterThan(start.lat);
    expect(northMoved.lng).toBeCloseTo(start.lng, 10);

    const eastMoved = offsetToLatLng(start.lat, start.lng, 100, 0);
    expect(eastMoved.lat).toBeCloseTo(start.lat, 10);
    expect(eastMoved.lng).toBeGreaterThan(start.lng);
  });
});
