import { describe, expect, test } from 'bun:test';
import { offsetToLatLng } from './math3d.ts';
import {
  computeSmoothnessMetrics,
  DEFAULT_ALT_DEADBAND_M,
  DEFAULT_ANGLE_DEADBAND_DEG,
  type SmoothnessSample,
} from './smoothness.ts';

function baseSample(overrides: Partial<SmoothnessSample> = {}): SmoothnessSample {
  return {
    tMs: 0,
    dtS: 1 / 60,
    modelLat: 37.7749,
    modelLng: -122.4194,
    modelAlt: 10,
    headingDeg: 0,
    tiltDeg: 0,
    rollDeg: 0,
    ...overrides,
  };
}

describe('computeSmoothnessMetrics', () => {
  test('returns all zeroes for an empty sample array', () => {
    const metrics = computeSmoothnessMetrics([]);
    expect(metrics).toEqual({
      sampleCount: 0,
      maxTiltStepDeg: 0,
      maxRollStepDeg: 0,
      maxTiltRateDegS: 0,
      maxRollRateDegS: 0,
      p95TiltJerkDegS3: 0,
      maxTiltJerkDegS3: 0,
      p95RollJerkDegS3: 0,
      maxRollJerkDegS3: 0,
      tiltSignFlips: 0,
      rollSignFlips: 0,
      maxHeadingStepDeg: 0,
      maxAltStepM: 0,
      maxVerticalJerkMs3: 0,
      maxCamModelHorizOffsetM: 0,
    });
  });

  test('handles a single sample and still measures camera-model horizontal offset', () => {
    const shifted = offsetToLatLng(37.7749, -122.4194, 3, 4);
    const metrics = computeSmoothnessMetrics([
      baseSample({
        camLat: shifted.lat,
        camLng: shifted.lng,
        camAlt: 27,
        groundAlt: 10,
      }),
    ]);

    expect(metrics.sampleCount).toBe(1);
    expect(metrics.maxTiltStepDeg).toBe(0);
    expect(metrics.maxRollStepDeg).toBe(0);
    expect(metrics.maxTiltRateDegS).toBe(0);
    expect(metrics.maxRollRateDegS).toBe(0);
    expect(metrics.maxTiltJerkDegS3).toBe(0);
    expect(metrics.maxRollJerkDegS3).toBe(0);
    expect(metrics.tiltSignFlips).toBe(0);
    expect(metrics.rollSignFlips).toBe(0);
    expect(metrics.maxHeadingStepDeg).toBe(0);
    expect(metrics.maxAltStepM).toBe(0);
    expect(metrics.maxVerticalJerkMs3).toBe(0);
    expect(metrics.maxCamModelHorizOffsetM).toBeCloseTo(5.0, 2);
  });

  test('reports exact rates and zero jerk or sign flips on constant-rate ramps', () => {
    const dtS = 1 / 60;
    const samples: SmoothnessSample[] = [];
    for (let i = 0; i < 60; i++) {
      const t = i * dtS;
      samples.push(
        baseSample({
          tMs: t * 1000,
          dtS,
          tiltDeg: 12 * t, // 12 deg/s -> 0.2 deg/step
          rollDeg: -18 * t, // -18 deg/s -> 0.3 deg/step
          headingDeg: 30 * t, // 30 deg/s -> 0.5 deg/step
          modelAlt: 100 + 6 * t, // 6 m/s -> 0.1 m/step
        }),
      );
    }

    const metrics = computeSmoothnessMetrics(samples);
    expect(metrics.sampleCount).toBe(60);
    expect(metrics.maxTiltStepDeg).toBeCloseTo(0.2, 6);
    expect(metrics.maxRollStepDeg).toBeCloseTo(0.3, 6);
    expect(metrics.maxTiltRateDegS).toBeCloseTo(12, 5);
    expect(metrics.maxRollRateDegS).toBeCloseTo(18, 5);
    expect(metrics.maxTiltJerkDegS3).toBeCloseTo(0, 6);
    expect(metrics.p95TiltJerkDegS3).toBeCloseTo(0, 6);
    expect(metrics.maxRollJerkDegS3).toBeCloseTo(0, 6);
    expect(metrics.p95RollJerkDegS3).toBeCloseTo(0, 6);
    expect(metrics.tiltSignFlips).toBe(0);
    expect(metrics.rollSignFlips).toBe(0);
    expect(metrics.maxHeadingStepDeg).toBeCloseTo(0.5, 6);
    expect(metrics.maxAltStepM).toBeCloseTo(0.1, 6);
    expect(metrics.maxVerticalJerkMs3).toBeCloseTo(0, 6);
  });

  test('computes exact analytical jerk for quadratic and cubic trajectories under variable dt', () => {
    const dts = [1 / 60, 1 / 30, 1 / 120, 1 / 20, 1 / 60, 1 / 45, 1 / 90, 1 / 30];
    const tiltJerk = 90; // deg/s^3
    const rollAccel = 20; // deg/s^2 -> 0 jerk
    const vertJerk = 48; // m/s^3

    const samples: SmoothnessSample[] = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      const dtS = i === 0 ? 1 / 60 : dts[i % dts.length]!;
      if (i > 0) t += dtS;
      samples.push(
        baseSample({
          tMs: t * 1000,
          dtS,
          tiltDeg: (tiltJerk / 6) * t * t * t,
          rollDeg: 0.5 * rollAccel * t * t,
          modelAlt: (vertJerk / 6) * t * t * t,
        }),
      );
    }

    const metrics = computeSmoothnessMetrics(samples, { altDeadbandM: 0 });
    expect(metrics.maxTiltJerkDegS3).toBeCloseTo(tiltJerk, 5);
    expect(metrics.p95TiltJerkDegS3).toBeCloseTo(tiltJerk, 5);
    expect(metrics.maxRollJerkDegS3).toBeCloseTo(0, 6);
    expect(metrics.maxVerticalJerkMs3).toBeCloseTo(vertJerk, 5);
  });

  test('separates p95 jerk from max jerk when a single frame spikes', () => {
    const dtS = 1 / 60;
    const samples: SmoothnessSample[] = [];
    for (let i = 0; i < 100; i++) {
      const spike = i === 50 ? 5.0 : 0;
      samples.push(
        baseSample({
          tMs: i * dtS * 1000,
          dtS,
          tiltDeg: spike,
          rollDeg: -spike * 0.5,
        }),
      );
    }

    const metrics = computeSmoothnessMetrics(samples);
    expect(metrics.maxTiltStepDeg).toBeCloseTo(5.0, 6);
    expect(metrics.maxTiltJerkDegS3).toBeGreaterThan(100_000);
    expect(metrics.p95TiltJerkDegS3).toBe(0);
    expect(metrics.maxRollJerkDegS3).toBeGreaterThan(50_000);
    expect(metrics.p95RollJerkDegS3).toBe(0);
  });

  test('wraps heading, tilt, and roll across +-180 and 0/360 degree seams using shortest angle', () => {
    const dtS = 1 / 60;
    const headings = [176, 178, 180, -178, -176, -174];
    const tilts = [178, 179, -180, -179, -178, -177];
    const rolls = [358, 359, 0, 1, 2, 3];

    const samples = headings.map((headingDeg, i) =>
      baseSample({
        tMs: i * dtS * 1000,
        dtS,
        headingDeg,
        tiltDeg: tilts[i]!,
        rollDeg: rolls[i]!,
      }),
    );

    const metrics = computeSmoothnessMetrics(samples);
    expect(metrics.maxHeadingStepDeg).toBeCloseTo(2.0, 6);
    expect(metrics.maxTiltStepDeg).toBeCloseTo(1.0, 6);
    expect(metrics.maxRollStepDeg).toBeCloseTo(1.0, 6);
    expect(metrics.maxTiltRateDegS).toBeCloseTo(60.0, 5);
    expect(metrics.maxRollRateDegS).toBeCloseTo(60.0, 5);
    expect(metrics.maxTiltJerkDegS3).toBeCloseTo(0, 6);
    expect(metrics.maxRollJerkDegS3).toBeCloseTo(0, 6);
    expect(metrics.tiltSignFlips).toBe(0);
    expect(metrics.rollSignFlips).toBe(0);
  });

  test('applies angleDeadbandDeg to filter sub-deadband chatter while catching real oscillations', () => {
    const dtS = 1 / 60;

    // Peak-to-peak 0.14 deg <= default 0.15 deg deadband -> 0 flips.
    const quietJitter = [0, 0.07, -0.07, 0.07, -0.07, 0.07].map((v, i) =>
      baseSample({ tMs: i * dtS * 1000, dtS, tiltDeg: v, rollDeg: -v }),
    );
    const quietMetrics = computeSmoothnessMetrics(quietJitter);
    expect(DEFAULT_ANGLE_DEADBAND_DEG).toBe(0.15);
    expect(quietMetrics.tiltSignFlips).toBe(0);
    expect(quietMetrics.rollSignFlips).toBe(0);

    // Lowering angleDeadbandDeg to 0.05 catches the exact same chatter (+, -, +, -, + => 4 flips).
    const sensitiveMetrics = computeSmoothnessMetrics(quietJitter, {
      angleDeadbandDeg: 0.05,
    });
    expect(sensitiveMetrics.tiltSignFlips).toBe(4);
    expect(sensitiveMetrics.rollSignFlips).toBe(4);

    // Alternating 1 deg chatter: +1, -1, +1, -1 => 3 reversals.
    const chatter = [0, 1, 0, 1, 0].map((v, i) =>
      baseSample({ tMs: i * dtS * 1000, dtS, tiltDeg: v, rollDeg: v * 2 }),
    );
    const chatterMetrics = computeSmoothnessMetrics(chatter);
    expect(chatterMetrics.tiltSignFlips).toBe(3);
    expect(chatterMetrics.rollSignFlips).toBe(3);

    // Gradual multi-frame oscillation (0.05 deg steps, 0.30 deg peak-to-peak) caught even at 60 Hz.
    const slowWobble = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05, 0, 0.05, 0.1, 0.15, 0.2].map(
      (v, i) => baseSample({ tMs: i * dtS * 1000, dtS, tiltDeg: v }),
    );
    expect(computeSmoothnessMetrics(slowWobble).tiltSignFlips).toBe(2);
  });

  test('applies altDeadbandM to suppress quantization noise in vertical jerk while preserving real bumps', () => {
    const dtS = 1 / 60;
    expect(DEFAULT_ALT_DEADBAND_M).toBe(0.02);

    // +-0.01 m quantization jitter: maxAltStepM stays accurate (0.01), jerk is suppressed.
    const quantized = [10, 10.01, 10, 10.01, 10, 10.01].map((modelAlt, i) =>
      baseSample({ tMs: i * dtS * 1000, dtS, modelAlt }),
    );
    const defaultMetrics = computeSmoothnessMetrics(quantized);
    expect(defaultMetrics.maxAltStepM).toBeCloseTo(0.01, 6);
    expect(defaultMetrics.maxVerticalJerkMs3).toBe(0);

    // Disabling deadband reveals the quantization jerk.
    const strictMetrics = computeSmoothnessMetrics(quantized, { altDeadbandM: 0.005 });
    expect(strictMetrics.maxVerticalJerkMs3).toBeGreaterThan(1000);

    // Real 0.10 m bump exceeds 0.02 m deadband and registers vertical jerk.
    const bumped = [10, 10, 10.1, 10, 10].map((modelAlt, i) =>
      baseSample({ tMs: i * dtS * 1000, dtS, modelAlt }),
    );
    const bumpMetrics = computeSmoothnessMetrics(bumped);
    expect(bumpMetrics.maxAltStepM).toBeCloseTo(0.1, 6);
    expect(bumpMetrics.maxVerticalJerkMs3).toBeGreaterThan(10_000);
  });

  test('guards against zero, negative, tiny, and non-finite dtS without NaN or Infinity', () => {
    const samples: SmoothnessSample[] = [
      baseSample({ tMs: 0, dtS: 1 / 60, tiltDeg: 0, rollDeg: 0, modelAlt: 0 }),
      baseSample({ tMs: 16, dtS: 1 / 60, tiltDeg: 1, rollDeg: 0.5, modelAlt: 0.2 }),
      baseSample({ tMs: 16, dtS: 0, tiltDeg: 1.5, rollDeg: 0.7, modelAlt: 0.3 }),
      baseSample({ tMs: 16, dtS: 1e-6, tiltDeg: 2.0, rollDeg: 0.9, modelAlt: 0.4 }),
      baseSample({ tMs: 15, dtS: -0.01, tiltDeg: 2.2, rollDeg: 1.0, modelAlt: 0.5 }),
      baseSample({ tMs: 32, dtS: Number.NaN, tiltDeg: 2.4, rollDeg: 1.1, modelAlt: 0.6 }),
      baseSample({ tMs: 48, dtS: 1 / 60, tiltDeg: 3.4, rollDeg: 1.6, modelAlt: 0.8 }),
      baseSample({ tMs: 65, dtS: 1 / 60, tiltDeg: 4.4, rollDeg: 2.1, modelAlt: 1.0 }),
    ];

    const metrics = computeSmoothnessMetrics(samples);
    for (const value of Object.values(metrics)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(metrics.maxTiltStepDeg).toBeCloseTo(1.0, 6);
    expect(metrics.maxTiltRateDegS).toBeCloseTo(60.0, 5);
    expect(metrics.maxTiltJerkDegS3).toBe(0);

    // Custom minDtS rejects 0.005s steps from rate/jerk calculations while preserving finite output.
    const fastSamples = [0, 1, 2, 3].map((v, i) =>
      baseSample({ tMs: i * 5, dtS: 0.005, tiltDeg: v }),
    );
    expect(computeSmoothnessMetrics(fastSamples, { minDtS: 0.01 }).maxTiltRateDegS).toBe(0);
    expect(computeSmoothnessMetrics(fastSamples, { minDtS: 0.001 }).maxTiltRateDegS).toBeCloseTo(200, 5);
  });

  test('measures maxCamModelHorizOffsetM including across the antimeridian', () => {
    const start = { lat: 0, lng: 179.9999 };
    const camAtAntimeridian = offsetToLatLng(start.lat, start.lng, 25, 0);
    const camClose = offsetToLatLng(start.lat, start.lng, 2, 0);

    const metrics = computeSmoothnessMetrics([
      baseSample({
        tMs: 0,
        modelLat: start.lat,
        modelLng: start.lng,
        camLat: camClose.lat,
        camLng: camClose.lng,
      }),
      baseSample({
        tMs: 16.7,
        modelLat: start.lat,
        modelLng: start.lng,
        camLat: camAtAntimeridian.lat,
        camLng: camAtAntimeridian.lng,
      }),
      baseSample({
        tMs: 33.3,
        modelLat: start.lat,
        modelLng: start.lng,
        // Missing camLat/camLng safely ignored.
      }),
    ]);

    expect(metrics.maxCamModelHorizOffsetM).toBeCloseTo(25.0, 1);
  });
});
