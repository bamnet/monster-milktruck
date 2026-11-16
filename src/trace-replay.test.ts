import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InputState } from './input.ts';
import {
  degToRad,
  EARTH_RADIUS_M,
  fixAngle,
  horizontalDistanceM,
  offsetToLatLng,
} from './math3d.ts';
import { computeSmoothnessMetrics, type SmoothnessSample } from './smoothness.ts';
import { extractGroundAltitude, eyeToTargetLatLng } from './terrain-pitch.ts';
import type { GoldenTerrainProfile, TerrainTrace } from './trace-types.ts';
import { Truck, type TruckStart } from './truck.ts';

function loadTrace(filename: string): TerrainTrace {
  const path = join(process.cwd(), 'testdata', 'traces', filename);
  return JSON.parse(readFileSync(path, 'utf8')) as TerrainTrace;
}

function createReplayRig(start: { lat: number; lng: number; heading: number }) {
  const target = new EventTarget();
  const flyCalls: google.maps.maps3d.FlyToAnimationOptions[] = [];
  const positionWrites: google.maps.LatLngAltitudeLiteral[] = [];
  const orientationWrites: google.maps.Orientation3DLiteral[] = [];

  const mapState: { center: google.maps.LatLngAltitudeLiteral; range: number } = {
    center: { lat: start.lat, lng: start.lng, altitude: 0 },
    range: 55,
  };

  const map = {
    get center() {
      return mapState.center;
    },
    set center(v: google.maps.LatLngAltitudeLiteral) {
      mapState.center = v;
    },
    get range() {
      return mapState.range;
    },
    set range(v: number) {
      mapState.range = v;
    },
    flyCameraTo(opts: google.maps.maps3d.FlyToAnimationOptions) {
      flyCalls.push(opts);
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as google.maps.maps3d.Map3DElement;

  let curPos: google.maps.LatLngAltitudeLiteral = { lat: start.lat, lng: start.lng, altitude: 0 };
  let curOri: google.maps.Orientation3DLiteral = { heading: start.heading, tilt: -90, roll: 0 };

  const model = {
    get position() {
      return curPos;
    },
    set position(v: google.maps.LatLngAltitudeLiteral) {
      curPos = v;
      positionWrites.push(v);
    },
    get orientation() {
      return curOri;
    },
    set orientation(v: google.maps.Orientation3DLiteral) {
      curOri = v;
      orientationWrites.push(v);
    },
  } as unknown as google.maps.maps3d.Model3DElement;

  const input: InputState = { left: false, right: false, gas: false, reverse: false };
  const popup = { textContent: '', hidden: true } as unknown as HTMLElement;
  const truck = new Truck(map, model, input, popup, 'RELATIVE_TO_GROUND', start);
  target.dispatchEvent(Object.assign(new Event('gmp-steadychange'), { isSteady: true }));

  return {
    truck,
    input,
    mapState,
    flyCalls,
    positionWrites,
    orientationWrites,
    dispatchCenterChange() {
      target.dispatchEvent(new Event('gmp-centerchange'));
    },
  };
}

// Replays recorded Map3DElement (gmp-map-3d) and Model3DElement (gmp-model-3d) traces
// against Truck.step(). See public Maps 3D JS API documentation:
// https://developers.google.com/maps/documentation/javascript/3d/overview
// https://developers.google.com/maps/documentation/javascript/reference/3d-map
describe('recorded terrain trace replay', () => {
  test('Whistler and San Francisco traces contain valid frames and resolved 3D ground elevations', () => {
    for (const file of ['whistler.json', 'san-francisco.json']) {
      const trace = loadTrace(file);
      expect(trace.frames.length).toBeGreaterThanOrEqual(10);

      let sawNonZeroAltitude = false;
      for (const f of trace.frames) {
        expect(f.dt).toBeGreaterThan(0);
        expect(f.dt).toBeLessThanOrEqual(0.25);
        expect(Number.isFinite(f.mapCenter.lat)).toBe(true);
        expect(Number.isFinite(f.mapCenter.lng)).toBe(true);
        expect(Number.isFinite(f.mapCenter.altitude)).toBe(true);
        if (Math.abs(f.mapCenter.altitude) > 1) sawNonZeroAltitude = true;
      }
      expect(sawNonZeroAltitude).toBe(true);
    }
  });

  test('replaying Whistler and San Francisco traces keeps camera angular rate bounded and writes deduplicated', () => {
    for (const file of ['whistler.json', 'san-francisco.json']) {
      const trace = loadTrace(file);
      const rig = createReplayRig(trace.start);
      let prevCamHeading = trace.start.heading;
      let maxCamRateDegPerSec = 0;

      for (const f of trace.frames) {
        rig.input.left = f.input.left;
        rig.input.right = f.input.right;
        rig.input.gas = f.input.gas;
        rig.input.reverse = f.input.reverse;
        rig.mapState.center = f.mapCenter;
        rig.mapState.range = f.mapRange;
        rig.dispatchCenterChange();

        rig.truck.step(f.dt);
        const latestFly = rig.flyCalls[rig.flyCalls.length - 1];
        const curCamHeading = latestFly?.endCamera.heading ?? prevCamHeading;
        if (f.dt >= 0.005) {
          const rate = Math.abs(fixAngle(curCamHeading - prevCamHeading)) / f.dt;
          if (rate > maxCamRateDegPerSec) maxCamRateDegPerSec = rate;
        }
        prevCamHeading = curCamHeading;
      }

      expect(maxCamRateDegPerSec).toBeLessThan(180);

      for (let i = 1; i < rig.positionWrites.length; i++) {
        expect(rig.positionWrites[i]).not.toEqual(rig.positionWrites[i - 1]);
      }
      for (let i = 1; i < rig.orientationWrites.length; i++) {
        expect(rig.orientationWrites[i]).not.toEqual(rig.orientationWrites[i - 1]);
      }
      for (let i = 1; i < rig.flyCalls.length; i++) {
        expect(rig.flyCalls[i]?.endCamera).not.toEqual(rig.flyCalls[i - 1]?.endCamera);
      }
    }
  });

  test('settles to zero API writes after Whistler trace even while noisy map.center samples continue', () => {
    const trace = loadTrace('whistler.json');
    const rig = createReplayRig(trace.start);

    for (const f of trace.frames) {
      rig.input.left = f.input.left;
      rig.input.right = f.input.right;
      rig.input.gas = f.input.gas;
      rig.input.reverse = f.input.reverse;
      rig.mapState.center = f.mapCenter;
      rig.mapState.range = f.mapRange;
      rig.dispatchCenterChange();
      rig.truck.step(f.dt);
    }

    // Release controls and let truck coast completely to rest (~30s under CONSTANT_DRAG = 2.0)
    rig.input.left = false;
    rig.input.right = false;
    rig.input.gas = false;
    rig.input.reverse = false;
    for (let i = 0; i < 2_400; i++) {
      rig.truck.step(1 / 60);
    }

    const settledFlyCount = rig.flyCalls.length;
    const settledPosCount = rig.positionWrites.length;
    const settledOriCount = rig.orientationWrites.length;

    // Replay fluctuating Whistler map.center / range samples while parked: must stay at 0 writes
    for (let i = 0; i < 120; i++) {
      const sample = trace.frames[i % trace.frames.length]!;
      rig.mapState.center = sample.mapCenter;
      rig.mapState.range = sample.mapRange;
      rig.dispatchCenterChange();
      rig.truck.step(1 / 60);
    }

    expect(rig.flyCalls).toHaveLength(settledFlyCount);
    expect(rig.positionWrites).toHaveLength(settledPosCount);
    expect(rig.orientationWrites).toHaveLength(settledOriCount);
  });
});

// ---------------------------------------------------------------------------
// Golden terrain profile tilt & smoothness replay tests
// ---------------------------------------------------------------------------

const GOLDEN_FILES = ['whistler.json', 'sf-hills.json', 'everest.json'] as const;
const EXPECTED_CAM_TILT_DEG = 72;
const EXPECTED_CAM_RANGE_M = 55;

function loadGoldenTerrain(filename: string): GoldenTerrainProfile {
  const path = join(process.cwd(), 'testdata', 'terrain', filename);
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenTerrainProfile;
}

/**
 * Simulates Google Maps 3D `LatLngAltitude` whose coordinates are non-enumerable
 * prototype getters (Object.keys() === []).
 */
class PrototypeLatLngAltitude {
  readonly #lat: number;
  readonly #lng: number;
  readonly #altitude: number;

  constructor(lat: number, lng: number, altitude: number) {
    this.#lat = lat;
    this.#lng = lng;
    this.#altitude = altitude;
  }

  get lat(): number {
    return this.#lat;
  }

  get lng(): number {
    return this.#lng;
  }

  get altitude(): number {
    return this.#altitude;
  }
}

function makePrototypeCameraEye(
  target: { lat: number; lng: number },
  groundAltM: number,
  headingDeg: number,
  tiltDeg = EXPECTED_CAM_TILT_DEG,
  rangeM = EXPECTED_CAM_RANGE_M,
): PrototypeLatLngAltitude {
  const horizRange = rangeM * Math.sin(degToRad(tiltDeg));
  const hRad = degToRad(headingDeg);
  const eye = offsetToLatLng(
    target.lat,
    target.lng,
    -horizRange * Math.sin(hRad),
    -horizRange * Math.cos(hRad),
  );
  return new PrototypeLatLngAltitude(
    eye.lat,
    eye.lng,
    groundAltM + rangeM * Math.cos(degToRad(tiltDeg)),
  );
}

function alongProfileMeters(
  profile: GoldenTerrainProfile,
  pos: { lat: number; lng: number },
): number {
  const dNorth = degToRad(pos.lat - profile.start.lat) * EARTH_RADIUS_M;
  const dEast =
    degToRad(fixAngle(pos.lng - profile.start.lng)) *
    EARTH_RADIUS_M *
    Math.cos(degToRad((profile.start.lat + pos.lat) * 0.5));
  const hRad = degToRad(profile.start.heading);
  return dEast * Math.sin(hRad) + dNorth * Math.cos(hRad);
}

function sampleGoldenAltitude(
  profile: GoldenTerrainProfile,
  pos: { lat: number; lng: number },
): number {
  const along = alongProfileMeters(profile, pos);
  if (along <= 0) return profile.points[0]!.altitudeM;
  if (along >= profile.totalLengthM) {
    return profile.points[profile.points.length - 1]!.altitudeM;
  }
  const exactIdx = along / profile.spacingM;
  const idx = Math.min(Math.floor(exactIdx), profile.points.length - 2);
  const frac = exactIdx - idx;
  const a = profile.points[idx]!.altitudeM;
  const b = profile.points[idx + 1]!.altitudeM;
  return a + (b - a) * frac;
}

interface GoldenReplayOptions {
  profile: GoldenTerrainProfile;
  targetSpeedMps: number;
  dtScheduleS: (stepIndex: number) => number;
  maxProfileDistM?: number;
  runwayLeadInM?: number;
  weave?: boolean;
  injectGroundOffsetM?: (profileStep: number, cleanAltM: number) => number;
  injectZeroCameraAtSteps?: ReadonlySet<number>;
}

interface GoldenReplayResult {
  samples: SmoothnessSample[];
  metrics: ReturnType<typeof computeSmoothnessMetrics>;
  flyCalls: google.maps.maps3d.FlyToAnimationOptions[];
  profileFlyCalls: google.maps.maps3d.FlyToAnimationOptions[];
  positionWrites: google.maps.LatLngAltitudeLiteral[];
  orientationWrites: google.maps.Orientation3DLiteral[];
  movingSteps: number;
  minTiltDeg: number;
  maxTiltDeg: number;
  minRollDeg: number;
  maxRollDeg: number;
  eyeZeroSpikes: number;
  maxSpeedMps: number;
  meanCruiseSpeedMps: number;
  rig: {
    truck: Truck;
    input: InputState;
    setCameraPosition: (cp: PrototypeLatLngAltitude | null) => void;
    setMapCenter: (c: google.maps.LatLngAltitudeLiteral) => void;
    dispatchCenterChange: () => void;
    flyCount: () => number;
    posWriteCount: () => number;
    oriWriteCount: () => number;
    currentPos: () => google.maps.LatLngAltitudeLiteral;
    currentOri: () => google.maps.Orientation3DLiteral;
  };
}

function runGoldenReplay(opts: GoldenReplayOptions): GoldenReplayResult {
  const {
    profile,
    targetSpeedMps,
    dtScheduleS,
    maxProfileDistM = 1450,
    runwayLeadInM = 0,
    weave = false,
    injectGroundOffsetM,
    injectZeroCameraAtSteps,
  } = opts;

  const hRad = degToRad(profile.start.heading);
  const startLatLng =
    runwayLeadInM > 0
      ? offsetToLatLng(
          profile.start.lat,
          profile.start.lng,
          -runwayLeadInM * Math.sin(hRad),
          -runwayLeadInM * Math.cos(hRad),
        )
      : { lat: profile.start.lat, lng: profile.start.lng };
  const start: TruckStart = {
    lat: startLatLng.lat,
    lng: startLatLng.lng,
    heading: profile.start.heading,
  };

  const target = new EventTarget();
  const flyCalls: google.maps.maps3d.FlyToAnimationOptions[] = [];
  const positionWrites: google.maps.LatLngAltitudeLiteral[] = [];
  const orientationWrites: google.maps.Orientation3DLiteral[] = [];

  const camState: {
    center: google.maps.LatLngAltitudeLiteral;
    range: number;
    heading: number;
    tilt: number;
    cameraPosition: PrototypeLatLngAltitude | null;
  } = {
    center: { lat: start.lat, lng: start.lng, altitude: 0 },
    range: EXPECTED_CAM_RANGE_M,
    heading: start.heading,
    tilt: EXPECTED_CAM_TILT_DEG,
    cameraPosition: null,
  };
  let inProfileSection = runwayLeadInM <= 0;
  let profileStep = 0;

  const updateCameraFromFly = (flyOpts: google.maps.maps3d.FlyToAnimationOptions) => {
    const c = flyOpts.endCamera.center as google.maps.LatLngAltitudeLiteral | undefined;
    if (!c) return;
    camState.center = { lat: c.lat, lng: c.lng, altitude: c.altitude ?? 0 };
    camState.heading = flyOpts.endCamera.heading ?? camState.heading;
    camState.tilt = flyOpts.endCamera.tilt ?? EXPECTED_CAM_TILT_DEG;
    camState.range = flyOpts.endCamera.range ?? EXPECTED_CAM_RANGE_M;

    if (inProfileSection && injectZeroCameraAtSteps?.has(profileStep)) {
      camState.cameraPosition = new PrototypeLatLngAltitude(c.lat, c.lng, 0);
      return;
    }

    const cleanGround = sampleGoldenAltitude(profile, c);
    const groundAlt =
      inProfileSection && injectGroundOffsetM
        ? cleanGround + injectGroundOffsetM(profileStep, cleanGround)
        : cleanGround;
    camState.cameraPosition = makePrototypeCameraEye(
      c,
      groundAlt,
      camState.heading,
      camState.tilt,
      camState.range,
    );
  };

  const map = {
    get center() {
      return camState.center;
    },
    set center(v: google.maps.LatLngAltitudeLiteral) {
      camState.center = v;
    },
    get range() {
      return camState.range;
    },
    set range(v: number) {
      camState.range = v;
    },
    get heading() {
      return camState.heading;
    },
    set heading(v: number) {
      camState.heading = v;
    },
    get tilt() {
      return camState.tilt;
    },
    set tilt(v: number) {
      camState.tilt = v;
    },
    get cameraPosition() {
      return camState.cameraPosition;
    },
    flyCameraTo(flyOpts: google.maps.maps3d.FlyToAnimationOptions) {
      flyCalls.push(flyOpts);
      updateCameraFromFly(flyOpts);
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as google.maps.maps3d.Map3DElement;

  let curPos: google.maps.LatLngAltitudeLiteral = { lat: start.lat, lng: start.lng, altitude: 0 };
  let curOri: google.maps.Orientation3DLiteral = { heading: start.heading, tilt: 0, roll: 0 };

  const model = {
    get position() {
      return curPos;
    },
    set position(v: google.maps.LatLngAltitudeLiteral) {
      curPos = v;
      positionWrites.push(v);
    },
    get orientation() {
      return curOri;
    },
    set orientation(v: google.maps.Orientation3DLiteral) {
      curOri = v;
      orientationWrites.push(v);
    },
  } as unknown as google.maps.maps3d.Model3DElement;

  const input: InputState = { left: false, right: false, gas: false, reverse: false };
  const popup = { textContent: '', hidden: true } as unknown as HTMLElement;
  const truck = new Truck(map, model, input, popup, 'RELATIVE_TO_GROUND', start);
  target.dispatchEvent(Object.assign(new Event('gmp-steadychange'), { isSteady: true }));

  // Verify realistic prototype-getter semantics on map.cameraPosition
  expect(camState.cameraPosition).not.toBeNull();
  expect(Object.keys(camState.cameraPosition!)).toEqual([]);

  const samples: SmoothnessSample[] = [];
  const profileFlyCalls: google.maps.maps3d.FlyToAnimationOptions[] = [];
  let movingSteps = 0;
  let eyeZeroSpikes = 0;
  let minTiltDeg = Infinity;
  let maxTiltDeg = -Infinity;
  let minRollDeg = Infinity;
  let maxRollDeg = -Infinity;
  let maxSpeedMps = 0;
  let speedSum = 0;
  let speedCount = 0;

  let tS = 0;
  let stepIdx = 0;
  let prevPos = { lat: curPos.lat, lng: curPos.lng };
  let estSpeedMps = 0;
  const maxSteps = 20_000;

  while (stepIdx < maxSteps) {
    const dt = dtScheduleS(stepIdx);
    const along = alongProfileMeters(profile, curPos);
    if (along >= maxProfileDistM) break;

    if (!inProfileSection && along >= 0) {
      inProfileSection = true;
    }

    input.gas = estSpeedMps < targetSpeedMps;
    if (weave && inProfileSection) {
      // Smooth periodic zero-net-heading slalom maneuver (0.35s R, 0.70s L, 0.35s R, 1.0s settle)
      const phase = tS % 3.0;
      input.right = (phase >= 0.3 && phase < 0.65) || (phase >= 1.65 && phase < 2.0);
      input.left = phase >= 0.8 && phase < 1.5;
    } else {
      input.left = false;
      input.right = false;
    }

    const flyBefore = flyCalls.length;
    truck.step(dt);
    tS += dt;

    const stepDist = horizontalDistanceM(prevPos, curPos);
    estSpeedMps = dt > 0 ? stepDist / dt : 0;
    prevPos = { lat: curPos.lat, lng: curPos.lng };

    if (inProfileSection) {
      // Count moving steps once coordinate displacement exceeds 1e-7 deg rounding (~0.011 m)
      if (stepDist > 0.02) {
        movingSteps++;
        for (let k = flyBefore; k < flyCalls.length; k++) {
          profileFlyCalls.push(flyCalls[k]!);
        }
      }

      if (estSpeedMps > maxSpeedMps) maxSpeedMps = estSpeedMps;
      if (along >= 100) {
        speedSum += estSpeedMps;
        speedCount++;
      }

      const tilt = fixAngle(curOri.tilt ?? 0);
      const roll = fixAngle(curOri.roll ?? 0);
      if (tilt < minTiltDeg) minTiltDeg = tilt;
      if (tilt > maxTiltDeg) maxTiltDeg = tilt;
      if (roll < minRollDeg) minRollDeg = roll;
      if (roll > maxRollDeg) maxRollDeg = roll;

      const cp = camState.cameraPosition;
      let camLat: number | undefined;
      let camLng: number | undefined;
      let camAlt: number | undefined;
      let groundAlt: number | undefined;

      if (cp) {
        camAlt = cp.altitude;
        if (Math.abs(cp.altitude) < 0.01) {
          eyeZeroSpikes++;
        } else {
          const projected = eyeToTargetLatLng(
            cp,
            camState.heading,
            camState.tilt,
            camState.range,
          );
          camLat = projected.lat;
          camLng = projected.lng;
          groundAlt = extractGroundAltitude(cp.altitude, camState.range, camState.tilt);
        }
      }

      const cleanGround = sampleGoldenAltitude(profile, curPos);
      samples.push({
        tMs: tS * 1000,
        dtS: dt,
        modelLat: curPos.lat,
        modelLng: curPos.lng,
        modelAlt: (groundAlt ?? cleanGround) + (curPos.altitude ?? 0),
        headingDeg: curOri.heading ?? 0,
        tiltDeg: tilt,
        rollDeg: roll,
        camLat,
        camLng,
        camAlt,
        groundAlt: groundAlt ?? cleanGround,
      });

      profileStep++;
    }

    stepIdx++;
  }

  return {
    samples,
    metrics: computeSmoothnessMetrics(samples),
    flyCalls,
    profileFlyCalls,
    positionWrites,
    orientationWrites,
    movingSteps,
    minTiltDeg,
    maxTiltDeg,
    minRollDeg,
    maxRollDeg,
    eyeZeroSpikes,
    maxSpeedMps,
    meanCruiseSpeedMps: speedCount > 0 ? speedSum / speedCount : maxSpeedMps,
    rig: {
      truck,
      input,
      setCameraPosition: (cp) => {
        camState.cameraPosition = cp;
      },
      setMapCenter: (c) => {
        camState.center = c;
      },
      dispatchCenterChange: () => {
        target.dispatchEvent(new Event('gmp-centerchange'));
      },
      flyCount: () => flyCalls.length,
      posWriteCount: () => positionWrites.length,
      oriWriteCount: () => orientationWrites.length,
      currentPos: () => curPos,
      currentOri: () => curOri,
    },
  };
}

function assertCameraAndAltitudeContract(
  flyCalls: readonly google.maps.maps3d.FlyToAnimationOptions[],
  positionWrites: readonly google.maps.LatLngAltitudeLiteral[],
): void {
  let badFly = 0;
  for (const call of flyCalls) {
    if (
      call.durationMillis !== 0 ||
      call.endCamera.tilt !== EXPECTED_CAM_TILT_DEG ||
      call.endCamera.range !== EXPECTED_CAM_RANGE_M ||
      call.endCamera.altitudeMode !== 'RELATIVE_TO_GROUND' ||
      call.endCamera.center?.altitude !== 0
    ) {
      badFly++;
    }
  }
  expect(badFly).toBe(0);

  let badAlt = 0;
  for (const pos of positionWrites) {
    if (pos.altitude !== 0) badAlt++;
  }
  expect(badAlt).toBe(0);
}

describe('golden terrain profile tilt replay', () => {
  test('golden terrain profiles have valid bare-earth elevations and spans', () => {
    for (const file of GOLDEN_FILES) {
      const profile = loadGoldenTerrain(file);
      expect(profile.points).toHaveLength(201);
      expect(profile.spacingM).toBe(8);
      expect(profile.totalLengthM).toBe(1600);
      let minAlt = Infinity;
      let maxAlt = -Infinity;
      for (const pt of profile.points) {
        expect(Number.isFinite(pt.altitudeM)).toBe(true);
        if (pt.altitudeM < minAlt) minAlt = pt.altitudeM;
        if (pt.altitudeM > maxAlt) maxAlt = pt.altitudeM;
      }
      expect(maxAlt - minAlt).toBeGreaterThan(50);
    }
  });

  test('replays Whistler, SF Hills, and Everest at low (~20 m/s), mid (~80 m/s), and high (~200 m/s) @ 60 Hz with smooth pitch and 100% flyCameraTo cadence', () => {
    const speeds = [
      { label: 'low', targetSpeedMps: 20, runwayLeadInM: 25, maxProfileDistM: 1450 },
      { label: 'mid', targetSpeedMps: 80, runwayLeadInM: 120, maxProfileDistM: 1450 },
      { label: 'high', targetSpeedMps: 200, runwayLeadInM: 800, maxProfileDistM: 1450 },
    ] as const;

    const profileBounds: Record<
      (typeof GOLDEN_FILES)[number],
      { up: number; down: number; maxTiltRate: number; p95TiltJerk: number }
    > = {
      'whistler.json': { up: -25, down: 25, maxTiltRate: 76, p95TiltJerk: 15_000 },
      'sf-hills.json': { up: -10, down: 5, maxTiltRate: 55, p95TiltJerk: 15_000 },
      'everest.json': { up: -15, down: 30, maxTiltRate: 76, p95TiltJerk: 35_000 },
    };

    for (const file of GOLDEN_FILES) {
      const profile = loadGoldenTerrain(file);
      const bounds = profileBounds[file];

      for (const { targetSpeedMps, runwayLeadInM, maxProfileDistM } of speeds) {
        const res = runGoldenReplay({
          profile,
          targetSpeedMps,
          runwayLeadInM,
          maxProfileDistM,
          dtScheduleS: () => 1 / 60,
        });

        // Verify target speed band reached
        expect(res.meanCruiseSpeedMps).toBeGreaterThan(targetSpeedMps * 0.85);
        expect(res.meanCruiseSpeedMps).toBeLessThan(targetSpeedMps * 1.1);

        // 100% flyCameraTo cadence & untouched camera/altitude contract
        expect(res.movingSteps).toBeGreaterThan(400);
        expect(res.profileFlyCalls).toHaveLength(res.movingSteps);
        assertCameraAndAltitudeContract(res.flyCalls, res.positionWrites);

        // Zero 0 m spikes & tight eye-to-model tracking
        expect(res.eyeZeroSpikes).toBe(0);
        expect(res.metrics.maxCamModelHorizOffsetM).toBeLessThan(0.05);

        // Non-zero realistic uphill (< 0) and downhill (> 0) pitch within [-35°, 35°]
        expect(res.minTiltDeg).toBeLessThan(bounds.up);
        expect(res.maxTiltDeg).toBeGreaterThan(bounds.down);
        expect(res.minTiltDeg).toBeGreaterThanOrEqual(-35);
        expect(res.maxTiltDeg).toBeLessThanOrEqual(35);

        // Smoothness ceilings (rate cap 75 °/s + 0.01° rounding headroom)
        expect(res.metrics.maxTiltRateDegS).toBeLessThanOrEqual(bounds.maxTiltRate);
        expect(res.metrics.maxTiltStepDeg).toBeLessThanOrEqual(1.3);
        expect(res.metrics.p95TiltJerkDegS3).toBeLessThan(bounds.p95TiltJerk);
        expect(res.metrics.maxRollRateDegS).toBe(0);
        expect(res.metrics.maxRollStepDeg).toBe(0);
      }
    }
  });

  test('maintains smooth tilt and steering roll across 30 Hz, 60 Hz, 120 Hz, and 33/50 ms variable-dt hitches with 100% flyCameraTo cadence', () => {
    const profile = loadGoldenTerrain('whistler.json');
    // p95 jerk ceilings account for Truck.applyModel()'s 0.01° angle rounding floor (~0.01 / dt^3)
    const schedules: Array<{
      name: string;
      dtScheduleS: (i: number) => number;
      maxStepCeilingDeg: number;
      p95TiltJerkCeiling: number;
      p95RollJerkCeiling: number;
    }> = [
      {
        name: '30Hz',
        dtScheduleS: () => 1 / 30,
        maxStepCeilingDeg: 75 * (1 / 30) + 0.1,
        p95TiltJerkCeiling: 5_000,
        p95RollJerkCeiling: 3_000,
      },
      {
        name: '60Hz',
        dtScheduleS: () => 1 / 60,
        maxStepCeilingDeg: 75 * (1 / 60) + 0.1,
        p95TiltJerkCeiling: 10_000,
        p95RollJerkCeiling: 8_000,
      },
      {
        name: '120Hz',
        dtScheduleS: () => 1 / 120,
        maxStepCeilingDeg: 75 * (1 / 120) + 0.1,
        p95TiltJerkCeiling: 45_000,
        p95RollJerkCeiling: 45_000,
      },
      {
        name: 'variable-dt-hitches-33ms-50ms',
        dtScheduleS: (i: number) => (i % 17 === 8 ? 0.05 : i % 11 === 4 ? 1 / 30 : 1 / 60),
        maxStepCeilingDeg: 75 * 0.05 + 0.1,
        p95TiltJerkCeiling: 10_000,
        p95RollJerkCeiling: 8_000,
      },
    ];

    const resultsByName = new Map<string, GoldenReplayResult>();

    for (const sched of schedules) {
      const res = runGoldenReplay({
        profile,
        targetSpeedMps: 80,
        runwayLeadInM: 120,
        maxProfileDistM: 1400,
        weave: true,
        dtScheduleS: sched.dtScheduleS,
      });
      resultsByName.set(sched.name, res);

      expect(res.movingSteps).toBeGreaterThan(200);
      expect(res.profileFlyCalls).toHaveLength(res.movingSteps);
      assertCameraAndAltitudeContract(res.flyCalls, res.positionWrites);
      expect(res.eyeZeroSpikes).toBe(0);
      expect(res.metrics.maxCamModelHorizOffsetM).toBeLessThan(0.05);

      // Both pitch (terrain) and roll (steering weave) are active and smoothly bounded
      expect(res.minTiltDeg).toBeLessThan(-25);
      expect(res.maxTiltDeg).toBeGreaterThan(25);
      expect(res.minTiltDeg).toBeGreaterThanOrEqual(-35);
      expect(res.maxTiltDeg).toBeLessThanOrEqual(35);

      expect(res.minRollDeg).toBeLessThan(-2);
      expect(res.maxRollDeg).toBeGreaterThan(2);
      expect(res.minRollDeg).toBeGreaterThanOrEqual(-30);
      expect(res.maxRollDeg).toBeLessThanOrEqual(30);

      expect(res.metrics.maxTiltRateDegS).toBeLessThanOrEqual(55);
      expect(res.metrics.maxTiltStepDeg).toBeLessThanOrEqual(sched.maxStepCeilingDeg);
      expect(res.metrics.p95TiltJerkDegS3).toBeLessThan(sched.p95TiltJerkCeiling);

      expect(res.metrics.maxRollRateDegS).toBeLessThan(25);
      expect(res.metrics.maxRollStepDeg).toBeLessThan(1.5);
      expect(res.metrics.p95RollJerkDegS3).toBeLessThan(sched.p95RollJerkCeiling);
    }

    // Frame-rate invariance across 30/60/120 Hz and 33/50 ms hitches
    const ref60 = resultsByName.get('60Hz')!;
    for (const [name, res] of resultsByName) {
      if (name === '60Hz') continue;
      expect(Math.abs(res.minTiltDeg - ref60.minTiltDeg)).toBeLessThan(1.0);
      expect(Math.abs(res.maxTiltDeg - ref60.maxTiltDeg)).toBeLessThan(1.0);
      expect(Math.abs(res.minRollDeg - ref60.minRollDeg)).toBeLessThan(0.5);
      expect(Math.abs(res.maxRollDeg - ref60.maxRollDeg)).toBeLessThan(0.5);
      expect(Math.abs(res.metrics.maxTiltRateDegS - ref60.metrics.maxTiltRateDegS)).toBeLessThan(3);
      expect(Math.abs(res.metrics.maxRollRateDegS - ref60.metrics.maxRollRateDegS)).toBeLessThan(2);
    }
  });

  test('is immune to single-frame +100 m terrain outliers and 0 m cameraPosition glitches during golden replay', () => {
    for (const file of ['whistler.json', 'sf-hills.json'] as const) {
      const profile = loadGoldenTerrain(file);
      const outlierSteps = new Set([80, 220, 410]);
      const zeroSteps = new Set([140, 310]);

      const clean = runGoldenReplay({
        profile,
        targetSpeedMps: 60,
        runwayLeadInM: 80,
        maxProfileDistM: 900,
        dtScheduleS: () => 1 / 60,
      });

      const glitched = runGoldenReplay({
        profile,
        targetSpeedMps: 60,
        runwayLeadInM: 80,
        maxProfileDistM: 900,
        dtScheduleS: () => 1 / 60,
        injectGroundOffsetM: (step) => (outlierSteps.has(step) ? 100 : 0),
        injectZeroCameraAtSteps: zeroSteps,
      });

      expect(glitched.samples.length).toBe(clean.samples.length);
      expect(glitched.profileFlyCalls).toHaveLength(glitched.movingSteps);
      assertCameraAndAltitudeContract(glitched.flyCalls, glitched.positionWrites);

      let maxPitchDeltaDeg = 0;
      for (let i = 0; i < clean.samples.length; i++) {
        const d = Math.abs(fixAngle(glitched.samples[i]!.tiltDeg - clean.samples[i]!.tiltDeg));
        if (d > maxPitchDeltaDeg) maxPitchDeltaDeg = d;
      }

      // Single-frame +100 m spikes and 0 m cameraPosition glitches are rejected with negligible drift
      expect(maxPitchDeltaDeg).toBeLessThan(0.5);
      expect(glitched.metrics.maxTiltRateDegS).toBeLessThanOrEqual(76);
    }
  });

  test('emits zero stationary writes after coasting to rest on Whistler golden terrain despite noisy camera samples', () => {
    const profile = loadGoldenTerrain('whistler.json');
    const res = runGoldenReplay({
      profile,
      targetSpeedMps: 60,
      runwayLeadInM: 80,
      maxProfileDistM: 320,
      weave: true,
      dtScheduleS: () => 1 / 60,
    });

    // Release controls and coast completely to rest (speed = 0, roll = 0, pitch converged)
    res.rig.input.gas = false;
    res.rig.input.reverse = false;
    res.rig.input.left = false;
    res.rig.input.right = false;
    for (let i = 0; i < 2_400; i++) {
      res.rig.truck.step(1 / 60);
    }

    const settledFly = res.rig.flyCount();
    const settledPos = res.rig.posWriteCount();
    const settledOri = res.rig.oriWriteCount();
    const parkedPos = res.rig.currentPos();
    const parkedGround = sampleGoldenAltitude(profile, parkedPos);
    const parkedHeading = res.rig.currentOri().heading ?? profile.start.heading;

    // Feed 180 stationary frames with noisy map.center, small camera altitude jitter, and 0 m glitches
    for (let i = 0; i < 180; i++) {
      res.rig.setMapCenter({
        lat: parkedPos.lat + (i % 2 === 0 ? 0.00003 : -0.00003),
        lng: parkedPos.lng,
        altitude: parkedGround + (i % 4 === 0 ? 3 : -2),
      });
      res.rig.dispatchCenterChange();
      res.rig.setCameraPosition(
        i % 15 === 0
          ? new PrototypeLatLngAltitude(parkedPos.lat, parkedPos.lng, 0)
          : makePrototypeCameraEye(
              parkedPos,
              parkedGround + (i % 3 === 0 ? 0.4 : -0.4),
              parkedHeading,
            ),
      );
      res.rig.truck.step(1 / 60);
    }

    expect(res.rig.flyCount()).toBe(settledFly);
    expect(res.rig.posWriteCount()).toBe(settledPos);
    expect(res.rig.oriWriteCount()).toBe(settledOri);
  });
});
