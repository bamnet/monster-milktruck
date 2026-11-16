import {
  EARTH_RADIUS_M,
  clamp,
  degToRad,
  fixAngle,
  horizontalDistanceM,
  offsetToLatLng,
  radToDeg,
} from './math3d.ts';

const MAX_PITCH_DEG = 35;
const MAX_SLOPE = 0.7;
const PITCH_TAU_S = 0.22;
const MAX_PITCH_RATE_DEG_S = 75;
const PITCH_SNAP_DEG = 0.01;

const MIN_CAM_ALT_ABS_M = 0.01;
const MAX_TILT_ERR_DEG = 1.0;
const MAX_EYE_TARGET_ERR_M = 15;

const STEP_M = 0.25;
const MIN_BASELINE_M = 8;
const MAX_BASELINE_M = 20;
const BASELINE_SPEED_FACTOR = 0.06;
const MAX_HISTORY_M = 30;

const OUTLIER_MIN_JUMP_M = 12;
const OUTLIER_RELOCK_STREAK = 3;

export interface TerrainPitchInput {
  dt: number;
  truckPos: { lat: number; lng: number };
  headingDeg: number;
  speedMps: number;
  sceneReady: boolean;
  teleporting: boolean;
  cameraPosition: { lat: number; lng: number; altitude: number } | null;
  cameraHeadingDeg: number;
  liveTiltDeg?: number | null;
  targetRangeM: number;
  targetTiltDeg: number;
}

interface DistAltSample {
  pathDist: number;
  signedDist: number;
  alt: number;
}

/**
 * Recovers bare-earth ground elevation (meters MSL) from the 3D camera eye altitude
 * and target chase geometry (`rangeM`, `tiltDeg`).
 */
export function extractGroundAltitude(
  camPosAltM: number,
  rangeM: number,
  tiltDeg: number,
): number {
  return camPosAltM - rangeM * Math.cos(degToRad(tiltDeg));
}

/**
 * Projects the 3D camera eye horizontally forward along `headingDeg` by
 * `rangeM * sin(tiltDeg)` to recover the ground target lat/lng.
 */
export function eyeToTargetLatLng(
  camPos: { lat: number; lng: number },
  headingDeg: number,
  tiltDeg: number,
  rangeM: number,
): { lat: number; lng: number } {
  const horizRange = rangeM * Math.sin(degToRad(tiltDeg));
  const hRad = degToRad(headingDeg);
  return offsetToLatLng(
    camPos.lat,
    camPos.lng,
    horizRange * Math.sin(hRad),
    horizRange * Math.cos(hRad),
  );
}

/**
 * Passively derives smooth uphill/downhill vehicle pitch (degrees) from Maps 3D
 * `cameraPosition` samples without altering camera tracking or ground clamping.
 *
 * Sign convention (upright GLB, `MODEL_TILT_OFFSET = 0`):
 * - `pitchDeg < 0`: nose pitched UP (climbing uphill)
 * - `pitchDeg > 0`: nose pitched DOWN (descending downhill)
 */
export class TerrainPitchTracker {
  private locked = false;
  private lastPos: { lat: number; lng: number } | null = null;
  private lastGroundAlt = 0;
  private pathDistM = 0;
  private signedDistM = 0;
  private distSinceLastValidM = 0;
  private buf: DistAltSample[] = [];
  private outlierCount = 0;
  private outlierPrevAlt = 0;
  private targetPitchDeg = 0;
  private _pitchDeg = 0;

  get pitchDeg(): number {
    return this._pitchDeg;
  }

  reset(): void {
    this.locked = false;
    this.lastPos = null;
    this.lastGroundAlt = 0;
    this.pathDistM = 0;
    this.signedDistM = 0;
    this.distSinceLastValidM = 0;
    this.buf = [];
    this.outlierCount = 0;
    this.outlierPrevAlt = 0;
    this.targetPitchDeg = 0;
    this._pitchDeg = 0;
  }

  update(input: TerrainPitchInput): number {
    const {
      dt,
      truckPos,
      headingDeg,
      speedMps,
      sceneReady,
      teleporting,
      cameraPosition,
      cameraHeadingDeg,
      liveTiltDeg,
      targetRangeM,
      targetTiltDeg,
    } = input;

    if (!sceneReady || teleporting) {
      return this._pitchDeg;
    }

    let stepM = 0;
    if (this.locked && this.lastPos !== null) {
      stepM = this.advanceDistance(this.lastPos, truckPos, headingDeg);
      this.lastPos = { lat: truckPos.lat, lng: truckPos.lng };
    }

    const rawGroundAlt = this.readValidGroundAlt(
      cameraPosition,
      cameraHeadingDeg,
      liveTiltDeg,
      targetRangeM,
      targetTiltDeg,
      truckPos,
    );

    if (rawGroundAlt === null) {
      this.smoothPitch(dt);
      return this._pitchDeg;
    }

    if (!this.locked) {
      this.lockAt(truckPos, rawGroundAlt);
      this.smoothPitch(dt);
      return this._pitchDeg;
    }

    const jumpLimit = Math.max(OUTLIER_MIN_JUMP_M, 2.0 * this.distSinceLastValidM + 5);
    if (Math.abs(rawGroundAlt - this.lastGroundAlt) > jumpLimit) {
      if (
        this.outlierCount > 0 &&
        Math.abs(rawGroundAlt - this.outlierPrevAlt) <= jumpLimit
      ) {
        this.outlierCount++;
      } else {
        this.outlierCount = 1;
      }
      this.outlierPrevAlt = rawGroundAlt;

      if (this.outlierCount >= OUTLIER_RELOCK_STREAK) {
        this.lastGroundAlt = rawGroundAlt;
        this.distSinceLastValidM = 0;
        this.outlierCount = 0;
        this.buf = [{ pathDist: this.pathDistM, signedDist: this.signedDistM, alt: rawGroundAlt }];
        this.targetPitchDeg = 0;
      }

      this.smoothPitch(dt);
      return this._pitchDeg;
    }

    this.outlierCount = 0;
    this.lastGroundAlt = rawGroundAlt;
    this.distSinceLastValidM = 0;

    const lastSample = this.buf[this.buf.length - 1]!;
    if (this.buf.length === 1 && this.pathDistM - lastSample.pathDist < STEP_M) {
      // Refresh sole anchor in-place while stationary so post-teleport terrain
      // settling never leaves a stale initial altitude in the buffer.
      lastSample.alt = rawGroundAlt;
      this.smoothPitch(dt);
      return this._pitchDeg;
    }

    if (this.pathDistM - lastSample.pathDist >= STEP_M) {
      this.buf.push({
        pathDist: this.pathDistM,
        signedDist: this.signedDistM,
        alt: rawGroundAlt,
      });
      while (this.buf.length > 2 && this.pathDistM - this.buf[1]!.pathDist > MAX_HISTORY_M) {
        this.buf.shift();
      }
    }

    if (stepM > 1e-4 && this.buf.length >= 2) {
      const baselineM = clamp(
        MIN_BASELINE_M + BASELINE_SPEED_FACTOR * Math.abs(speedMps),
        MIN_BASELINE_M,
        MAX_BASELINE_M,
      );
      const slope = this.computeSlope(rawGroundAlt, baselineM);
      if (slope !== null) {
        const clampedSlope = clamp(slope, -MAX_SLOPE, MAX_SLOPE);
        const target = clamp(
          -radToDeg(Math.atan(clampedSlope)),
          -MAX_PITCH_DEG,
          MAX_PITCH_DEG,
        );
        this.targetPitchDeg = target === 0 ? 0 : target;
      }
    }

    this.smoothPitch(dt);
    return this._pitchDeg;
  }

  private lockAt(truckPos: { lat: number; lng: number }, rawGroundAlt: number): void {
    this.locked = true;
    this.lastPos = { lat: truckPos.lat, lng: truckPos.lng };
    this.lastGroundAlt = rawGroundAlt;
    this.pathDistM = 0;
    this.signedDistM = 0;
    this.distSinceLastValidM = 0;
    this.outlierCount = 0;
    this.buf = [{ pathDist: 0, signedDist: 0, alt: rawGroundAlt }];
    this.targetPitchDeg = 0;
  }

  private advanceDistance(
    prev: { lat: number; lng: number },
    next: { lat: number; lng: number },
    headingDeg: number,
  ): number {
    const stepM = horizontalDistanceM(prev, next);
    if (stepM <= 1e-6) return 0;

    const dNorth = degToRad(next.lat - prev.lat) * EARTH_RADIUS_M;
    const dEast =
      degToRad(fixAngle(next.lng - prev.lng)) *
      EARTH_RADIUS_M *
      Math.cos(degToRad((prev.lat + next.lat) * 0.5));
    const hRad = degToRad(headingDeg);
    const dot = dEast * Math.sin(hRad) + dNorth * Math.cos(hRad);
    const dir = dot >= 0 ? 1 : -1;

    this.pathDistM += stepM;
    this.signedDistM += dir * stepM;
    this.distSinceLastValidM += stepM;
    return stepM;
  }

  private readValidGroundAlt(
    camPos: { lat: number; lng: number; altitude: number } | null,
    cameraHeadingDeg: number,
    liveTiltDeg: number | null | undefined,
    targetRangeM: number,
    targetTiltDeg: number,
    truckPos: { lat: number; lng: number },
  ): number | null {
    if (
      camPos === null ||
      !Number.isFinite(camPos.lat) ||
      !Number.isFinite(camPos.lng) ||
      !Number.isFinite(camPos.altitude)
    ) {
      return null;
    }

    if (Math.abs(camPos.altitude) < MIN_CAM_ALT_ABS_M) {
      return null;
    }

    const hasLiveTilt =
      liveTiltDeg !== null && liveTiltDeg !== undefined && Number.isFinite(liveTiltDeg);
    if (hasLiveTilt && Math.abs(liveTiltDeg - targetTiltDeg) > MAX_TILT_ERR_DEG) {
      return null;
    }

    const tiltDeg = hasLiveTilt ? liveTiltDeg : targetTiltDeg;
    const eyeTarget = eyeToTargetLatLng(camPos, cameraHeadingDeg, tiltDeg, targetRangeM);
    if (horizontalDistanceM(eyeTarget, truckPos) >= MAX_EYE_TARGET_ERR_M) {
      return null;
    }

    return extractGroundAltitude(camPos.altitude, targetRangeM, tiltDeg);
  }

  private computeSlope(curAlt: number, baselineM: number): number | null {
    const curSigned = this.signedDistM;

    for (let i = this.buf.length - 2; i >= 0; i--) {
      const a = this.buf[i]!;
      const da = curSigned - a.signedDist;
      const absDa = Math.abs(da);
      if (absDa < baselineM) continue;

      const b = this.buf[i + 1]!;
      const db = curSigned - b.signedDist;
      const absDb = Math.abs(db);
      if (da * db >= 0 && absDb < baselineM && absDa > absDb) {
        const t = (baselineM - absDb) / (absDa - absDb);
        const refAlt = b.alt + t * (a.alt - b.alt);
        const ds = Math.sign(da) * baselineM;
        return (curAlt - refAlt) / ds;
      }

      return (curAlt - a.alt) / da;
    }

    // Fewer than `baselineM` meters traveled since lock: ease in using baselineM
    // as the denominator floor so tiny startup terrain noise cannot spike slope.
    let best: DistAltSample | null = null;
    let bestAbsDs = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const s = this.buf[i]!;
      const absDs = Math.abs(curSigned - s.signedDist);
      if (absDs > bestAbsDs) {
        bestAbsDs = absDs;
        best = s;
      }
    }

    if (best === null || bestAbsDs < 1e-4) return null;
    const rawDs = curSigned - best.signedDist;
    const denom = Math.sign(rawDs) * Math.max(bestAbsDs, baselineM);
    return (curAlt - best.alt) / denom;
  }

  private smoothPitch(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const alpha = 1 - Math.exp(-dt / PITCH_TAU_S);
    const desiredStep = (this.targetPitchDeg - this._pitchDeg) * alpha;
    const maxStep = MAX_PITCH_RATE_DEG_S * dt;
    const step = clamp(desiredStep, -maxStep, maxStep);
    this._pitchDeg = clamp(this._pitchDeg + step, -MAX_PITCH_DEG, MAX_PITCH_DEG);
    if (Math.abs(this._pitchDeg - this.targetPitchDeg) < PITCH_SNAP_DEG) {
      this._pitchDeg = this.targetPitchDeg;
    }
    if (this._pitchDeg === 0) {
      this._pitchDeg = 0;
    }
  }
}
