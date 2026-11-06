import { describe, expect, test } from 'bun:test';
import { PRESETS, resolveAltitudeMode } from './config.ts';

describe('config', () => {
  test('PRESETS has non-empty unique labels and valid geographic coordinates', () => {
    expect(PRESETS.length).toBeGreaterThan(0);

    const labels = new Set<string>();
    for (const preset of PRESETS) {
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(labels.has(preset.label)).toBe(false);
      labels.add(preset.label);

      expect(Number.isFinite(preset.lat)).toBe(true);
      expect(preset.lat).toBeGreaterThanOrEqual(-90);
      expect(preset.lat).toBeLessThanOrEqual(90);

      expect(Number.isFinite(preset.lng)).toBe(true);
      expect(preset.lng).toBeGreaterThanOrEqual(-180);
      expect(preset.lng).toBeLessThanOrEqual(180);

      expect(Number.isFinite(preset.heading)).toBe(true);
      expect(preset.heading).toBeGreaterThanOrEqual(0);
      expect(preset.heading).toBeLessThan(360);
    }
  });

  test('resolveAltitudeMode defaults to RELATIVE_TO_GROUND and switches to ABSOLUTE with fixedAltitude', () => {
    expect(resolveAltitudeMode('')).toBe('RELATIVE_TO_GROUND');
    expect(resolveAltitudeMode('?foo=bar')).toBe('RELATIVE_TO_GROUND');
    expect(resolveAltitudeMode('?fixedAltitude')).toBe('ABSOLUTE');
    expect(resolveAltitudeMode('?fixedAltitude=1')).toBe('ABSOLUTE');
    expect(resolveAltitudeMode('?debug=1&fixedAltitude=true')).toBe('ABSOLUTE');
  });
});
