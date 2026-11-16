import { degToRad, EARTH_RADIUS_M, fixAngle } from './math3d.ts';

export const DEFAULT_ANGLE_DEADBAND_DEG = 0.15;
export const DEFAULT_ALT_DEADBAND_M = 0.02;
export const DEFAULT_MIN_DT_S = 1e-3;

export interface SmoothnessSample {
  /** Monotonic timestamp in milliseconds. */
  tMs: number;
  /** Elapsed frame time in seconds since the previous sample. */
  dtS: number;
  modelLat: number;
  modelLng: number;
  modelAlt: number;
  headingDeg: number;
  tiltDeg: number;
  rollDeg: number;
  /** Optional camera look-at / target latitude for horizontal tracking offset. */
  camLat?: number;
  /** Optional camera look-at / target longitude for horizontal tracking offset. */
  camLng?: number;
  /** Optional camera eye or target altitude in meters. */
  camAlt?: number;
  /** Optional resolved bare-earth ground altitude in meters. */
  groundAlt?: number;
}

export interface SmoothnessOptions {
  /** Minimum angular excursion (deg) to count a direction reversal. Default: 0.15. */
  angleDeadbandDeg?: number;
  /** Altitude step deadband (m) below which micro-jitter is excluded from vertical jerk. Default: 0.02. */
  altDeadbandM?: number;
  /** Minimum dt (s) required for derivative (rate/accel/jerk) calculations. Default: 0.001. */
  minDtS?: number;
}

export interface SmoothnessMetrics {
  sampleCount: number;
  maxTiltStepDeg: number;
  maxRollStepDeg: number;
  maxTiltRateDegS: number;
  maxRollRateDegS: number;
  p95TiltJerkDegS3: number;
  maxTiltJerkDegS3: number;
  p95RollJerkDegS3: number;
  maxRollJerkDegS3: number;
  tiltSignFlips: number;
  rollSignFlips: number;
  maxHeadingStepDeg: number;
  maxAltStepM: number;
  maxVerticalJerkMs3: number;
  maxCamModelHorizOffsetM: number;
}

interface ChannelSummary {
  maxStep: number;
  maxRate: number;
  p95Jerk: number;
  maxJerk: number;
  signFlips: number;
}

function horizDistanceM(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dN = degToRad(bLat - aLat) * EARTH_RADIUS_M;
  const dE =
    degToRad(fixAngle(bLng - aLng)) *
    EARTH_RADIUS_M *
    Math.cos(degToRad((aLat + bLat) * 0.5));
  return Math.hypot(dE, dN);
}

function nearestRankPercentile(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.max(0, Math.min(n - 1, Math.ceil(n * p) - 1));
  return sorted[idx] ?? 0;
}

function analyzeChannel(
  samples: readonly SmoothnessSample[],
  pick: (s: SmoothnessSample) => number,
  opts: {
    wrapAngle: boolean;
    deadband: number;
    minDtS: number;
    suppressJerkUnderDeadband: boolean;
  },
): ChannelSummary {
  const n = samples.length;
  if (n < 2) {
    return { maxStep: 0, maxRate: 0, p95Jerk: 0, maxJerk: 0, signFlips: 0 };
  }

  let maxStep = 0;
  let maxRate = 0;
  let maxJerk = 0;
  const absJerks: number[] = [];

  // Hysteresis sign-flip tracker on unwrapped channel value.
  let signFlips = 0;
  let dir: -1 | 0 | 1 = 0;
  let unwrapped = 0;
  let extreme = 0;
  let initMin = 0;
  let initMax = 0;

  // Newton divided-difference chain for exact rate / accel / jerk under variable dt.
  let prevRate: number | undefined;
  let prevAccel: number | undefined;
  let prevDt1: number | undefined;
  let prevDt2: number | undefined;
  let prevAbsDx1 = 0;
  let prevAbsDx2 = 0;

  let prevVal = pick(samples[0]!);
  const resetDerivatives = () => {
    prevRate = undefined;
    prevAccel = undefined;
    prevDt1 = undefined;
    prevDt2 = undefined;
    prevAbsDx1 = 0;
    prevAbsDx2 = 0;
  };

  for (let i = 1; i < n; i++) {
    const curSample = samples[i]!;
    const curVal = pick(curSample);
    if (!Number.isFinite(prevVal) || !Number.isFinite(curVal)) {
      prevVal = curVal;
      resetDerivatives();
      continue;
    }

    const dx = opts.wrapAngle ? fixAngle(curVal - prevVal) : curVal - prevVal;
    const absDx = Math.abs(dx);
    if (absDx > maxStep) maxStep = absDx;

    // Update unwrapped trajectory and hysteresis reversal counter.
    unwrapped += dx;
    if (dir === 0) {
      if (unwrapped < initMin) initMin = unwrapped;
      if (unwrapped > initMax) initMax = unwrapped;
      if (unwrapped - initMin > opts.deadband) {
        dir = 1;
        extreme = unwrapped;
      } else if (initMax - unwrapped > opts.deadband) {
        dir = -1;
        extreme = unwrapped;
      }
    } else if (dir === 1) {
      if (unwrapped > extreme) {
        extreme = unwrapped;
      } else if (extreme - unwrapped > opts.deadband) {
        signFlips++;
        dir = -1;
        extreme = unwrapped;
      }
    } else {
      if (unwrapped < extreme) {
        extreme = unwrapped;
      } else if (unwrapped - extreme > opts.deadband) {
        signFlips++;
        dir = 1;
        extreme = unwrapped;
      }
    }

    const dt = curSample.dtS;
    if (!Number.isFinite(dt) || dt < opts.minDtS) {
      prevVal = curVal;
      resetDerivatives();
      continue;
    }

    const rate = dx / dt;
    const absRate = Math.abs(rate);
    if (absRate > maxRate) maxRate = absRate;

    if (prevRate !== undefined && prevDt1 !== undefined) {
      const accel = (rate - prevRate) / (0.5 * (prevDt1 + dt));
      if (prevAccel !== undefined && prevDt2 !== undefined) {
        const stencilMaxStep = Math.max(prevAbsDx2, prevAbsDx1, absDx);
        if (!opts.suppressJerkUnderDeadband || stencilMaxStep > opts.deadband) {
          const jerk = (accel - prevAccel) / ((prevDt2 + prevDt1 + dt) / 3);
          const absJerk = Math.abs(jerk);
          absJerks.push(absJerk);
          if (absJerk > maxJerk) maxJerk = absJerk;
        }
      }
      prevAccel = accel;
    }

    prevDt2 = prevDt1;
    prevDt1 = dt;
    prevAbsDx2 = prevAbsDx1;
    prevAbsDx1 = absDx;
    prevRate = rate;
    prevVal = curVal;
  }

  absJerks.sort((a, b) => a - b);
  return {
    maxStep,
    maxRate,
    p95Jerk: nearestRankPercentile(absJerks, 0.95),
    maxJerk,
    signFlips,
  };
}

/**
 * Computes tilt, roll, heading, vertical, and camera-tracking smoothness metrics
 * from a sequence of vehicle telemetry samples.
 */
export function computeSmoothnessMetrics(
  samples: readonly SmoothnessSample[],
  opts: SmoothnessOptions = {},
): SmoothnessMetrics {
  const angleDeadbandDeg = Math.max(0, opts.angleDeadbandDeg ?? DEFAULT_ANGLE_DEADBAND_DEG);
  const altDeadbandM = Math.max(0, opts.altDeadbandM ?? DEFAULT_ALT_DEADBAND_M);
  const minDtS = Math.max(1e-9, opts.minDtS ?? DEFAULT_MIN_DT_S);

  const sampleCount = samples.length;
  if (sampleCount === 0) {
    return {
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
    };
  }

  const tilt = analyzeChannel(samples, (s) => s.tiltDeg, {
    wrapAngle: true,
    deadband: angleDeadbandDeg,
    minDtS,
    suppressJerkUnderDeadband: false,
  });
  const roll = analyzeChannel(samples, (s) => s.rollDeg, {
    wrapAngle: true,
    deadband: angleDeadbandDeg,
    minDtS,
    suppressJerkUnderDeadband: false,
  });
  const alt = analyzeChannel(samples, (s) => s.modelAlt, {
    wrapAngle: false,
    deadband: altDeadbandM,
    minDtS,
    suppressJerkUnderDeadband: true,
  });

  let maxHeadingStepDeg = 0;
  let maxCamModelHorizOffsetM = 0;

  for (let i = 0; i < sampleCount; i++) {
    const cur = samples[i]!;
    if (
      cur.camLat !== undefined &&
      cur.camLng !== undefined &&
      Number.isFinite(cur.camLat) &&
      Number.isFinite(cur.camLng) &&
      Number.isFinite(cur.modelLat) &&
      Number.isFinite(cur.modelLng)
    ) {
      const off = horizDistanceM(cur.modelLat, cur.modelLng, cur.camLat, cur.camLng);
      if (off > maxCamModelHorizOffsetM) maxCamModelHorizOffsetM = off;
    }

    if (i > 0) {
      const prev = samples[i - 1]!;
      if (Number.isFinite(prev.headingDeg) && Number.isFinite(cur.headingDeg)) {
        const dHdg = Math.abs(fixAngle(cur.headingDeg - prev.headingDeg));
        if (dHdg > maxHeadingStepDeg) maxHeadingStepDeg = dHdg;
      }
    }
  }

  return {
    sampleCount,
    maxTiltStepDeg: tilt.maxStep,
    maxRollStepDeg: roll.maxStep,
    maxTiltRateDegS: tilt.maxRate,
    maxRollRateDegS: roll.maxRate,
    p95TiltJerkDegS3: tilt.p95Jerk,
    maxTiltJerkDegS3: tilt.maxJerk,
    p95RollJerkDegS3: roll.p95Jerk,
    maxRollJerkDegS3: roll.maxJerk,
    tiltSignFlips: tilt.signFlips,
    rollSignFlips: roll.signFlips,
    maxHeadingStepDeg,
    maxAltStepM: alt.maxStep,
    maxVerticalJerkMs3: alt.maxJerk,
    maxCamModelHorizOffsetM,
  };
}
