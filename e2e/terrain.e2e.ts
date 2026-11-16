import { expect, test, type Page } from '@playwright/test';
import { PRESETS } from '../src/config.ts';
import { fixAngle, horizontalDistanceM } from '../src/math3d.ts';
import { computeSmoothnessMetrics, type SmoothnessSample } from '../src/smoothness.ts';
import { extractGroundAltitude, eyeToTargetLatLng } from '../src/terrain-pitch.ts';
import type { LatLngAlt, Orientation3D } from '../src/trace-types.ts';
import {
  attachErrorTracking,
  buildAndServeApp,
  loadEnvIfNeeded,
  teleportToPresetAndWaitSteady,
  waitForMapReadyAndSteady,
  type AppServer,
} from './helpers.ts';

loadEnvIfNeeded();

const DEFAULT_CAM_TILT_DEG = 72;
const DEFAULT_CAM_RANGE_M = 55;

interface RawBrowserTelemetrySample {
  tMs: number;
  dtS: number;
  modelPos: LatLngAlt;
  modelOri: Orientation3D;
  camPos?: LatLngAlt;
  mapHeading: number;
  mapTilt: number;
  targetRange: number;
  targetAltOffset: number;
}

interface TelemetryCapture {
  samples: RawBrowserTelemetrySample[];
  flyCalls: number;
  posWrites: number;
  oriWrites: number;
  flyModes: string[];
  flyCenterAlts: number[];
}

function nearestRankPercentile(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.max(0, Math.min(n - 1, Math.ceil(n * p) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Installs prototype-getter telemetry instrumentation on `gmp-map-3d` and
 * `gmp-model-3d` and starts rAF sampling.
 */
async function startTelemetryCapture(page: Page): Promise<void> {
  await page.evaluate(
    ({ defaultTilt, defaultRange }) => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement & {
        cameraPosition?: google.maps.LatLngAltitude | null;
      };
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
      const win = window as unknown as {
        __terrainCap?: {
          active: boolean;
          flyCalls: number;
          posWrites: number;
          oriWrites: number;
          flyModes: string[];
          flyCenterAlts: number[];
          lastTargetRange: number;
          lastTargetTilt: number;
          lastTargetHeading: number;
          lastTargetAltOffset: number;
          samples: RawBrowserTelemetrySample[];
          restore: () => void;
        };
      };
      win.__terrainCap?.restore();

      const origFly = map.flyCameraTo.bind(map);
      const modelProto = Object.getPrototypeOf(model);
      const posDesc = Object.getOwnPropertyDescriptor(modelProto, 'position');
      const oriDesc = Object.getOwnPropertyDescriptor(modelProto, 'orientation');

      const cap = {
        active: true,
        flyCalls: 0,
        posWrites: 0,
        oriWrites: 0,
        flyModes: [] as string[],
        flyCenterAlts: [] as number[],
        lastTargetRange: defaultRange,
        lastTargetTilt: defaultTilt,
        lastTargetHeading: Number.isFinite(map.heading) ? (map.heading as number) : 0,
        lastTargetAltOffset: 0,
        samples: [] as RawBrowserTelemetrySample[],
        restore: () => {
          cap.active = false;
          map.flyCameraTo = origFly;
          if (posDesc) Object.defineProperty(model, 'position', posDesc);
          if (oriDesc) Object.defineProperty(model, 'orientation', oriDesc);
        },
      };

      map.flyCameraTo = (opts: google.maps.maps3d.FlyToAnimationOptions) => {
        cap.flyCalls++;
        cap.flyModes.push(String(opts?.endCamera?.altitudeMode ?? ''));
        if (Number.isFinite(opts?.endCamera?.range)) {
          cap.lastTargetRange = opts.endCamera.range!;
        }
        if (Number.isFinite(opts?.endCamera?.tilt)) {
          cap.lastTargetTilt = opts.endCamera.tilt!;
        }
        if (Number.isFinite(opts?.endCamera?.heading)) {
          cap.lastTargetHeading = opts.endCamera.heading!;
        }
        const c = opts?.endCamera?.center as google.maps.LatLngAltitudeLiteral | undefined;
        if (c && Number.isFinite(c.altitude)) {
          cap.lastTargetAltOffset = c.altitude!;
          cap.flyCenterAlts.push(c.altitude!);
        }
        return origFly(opts);
      };

      if (posDesc?.get && posDesc?.set) {
        Object.defineProperty(model, 'position', {
          configurable: true,
          get() {
            return posDesc.get!.call(this);
          },
          set(v) {
            cap.posWrites++;
            posDesc.set!.call(this, v);
          },
        });
      }
      if (oriDesc?.get && oriDesc?.set) {
        Object.defineProperty(model, 'orientation', {
          configurable: true,
          get() {
            return oriDesc.get!.call(this);
          },
          set(v) {
            cap.oriWrites++;
            oriDesc.set!.call(this, v);
          },
        });
      }

      win.__terrainCap = cap;

      const startMs = performance.now();
      let prevMs = startMs;
      const tick = (now: number) => {
        if (!cap.active) return;
        const dtMs = now - prevMs;
        prevMs = now;

        // Explicitly read prototype getters into plain objects.
        const pos = model.position as google.maps.LatLngAltitude | null;
        const ori = model.orientation as google.maps.Orientation3D | null;
        const cp = map.cameraPosition;

        const modelPos: LatLngAlt = {
          lat: pos?.lat ?? 0,
          lng: pos?.lng ?? 0,
          altitude: pos?.altitude ?? 0,
        };
        const modelOri: Orientation3D = {
          heading: ori?.heading ?? 0,
          tilt: ori?.tilt ?? 0,
          roll: ori?.roll ?? 0,
        };
        const camPos: LatLngAlt | undefined =
          cp && Number.isFinite(cp.lat) && Number.isFinite(cp.lng) && Number.isFinite(cp.altitude)
            ? { lat: cp.lat, lng: cp.lng, altitude: cp.altitude }
            : undefined;

        cap.samples.push({
          tMs: now - startMs,
          dtS: dtMs / 1000,
          modelPos,
          modelOri,
          camPos,
          mapHeading: Number.isFinite(map.heading)
            ? (map.heading as number)
            : cap.lastTargetHeading,
          mapTilt: Number.isFinite(map.tilt) ? (map.tilt as number) : cap.lastTargetTilt,
          targetRange: cap.lastTargetRange,
          targetAltOffset: cap.lastTargetAltOffset,
        });

        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { defaultTilt: DEFAULT_CAM_TILT_DEG, defaultRange: DEFAULT_CAM_RANGE_M },
  );
}

async function stopTelemetryCapture(page: Page): Promise<TelemetryCapture> {
  return page.evaluate<TelemetryCapture>(() => {
    const win = window as unknown as {
      __terrainCap?: {
        samples: RawBrowserTelemetrySample[];
        flyCalls: number;
        posWrites: number;
        oriWrites: number;
        flyModes: string[];
        flyCenterAlts: number[];
        restore: () => void;
      };
    };
    const cap = win.__terrainCap!;
    cap.restore();
    return {
      samples: cap.samples,
      flyCalls: cap.flyCalls,
      posWrites: cap.posWrites,
      oriWrites: cap.oriWrites,
      flyModes: cap.flyModes,
      flyCenterAlts: cap.flyCenterAlts,
    };
  });
}

async function waitForDrivenMeters(
  page: Page,
  start: { lat: number; lng: number },
  minMeters: number,
  timeoutMs = 15_000,
): Promise<void> {
  await page.waitForFunction(
    ({ origin, thresholdM }: { origin: { lat: number; lng: number }; thresholdM: number }) => {
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
      const p = model.position as google.maps.LatLngAltitude | null;
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
      const dLat = ((p.lat - origin.lat) * Math.PI) / 180;
      const dLng = ((p.lng - origin.lng) * Math.PI) / 180;
      const midLat = (((origin.lat + p.lat) * 0.5) * Math.PI) / 180;
      const dist = Math.hypot(dLng * 6378137 * Math.cos(midLat), dLat * 6378137);
      return dist >= thresholdM;
    },
    { origin: start, thresholdM: minMeters },
    { timeout: timeoutMs },
  );
}

function summarizeTelemetry(capture: TelemetryCapture) {
  let maxAbsTiltDeg = 0;
  let maxAbsRollDeg = 0;
  let eyeZeroSpikes = 0;
  let minGroundAlt = Infinity;
  let maxGroundAlt = -Infinity;
  const lagEyeSamples: number[] = [];
  const smoothnessSamples: SmoothnessSample[] = [];

  for (const s of capture.samples) {
    // Model3DElement.orientation may normalize angles into [0, 360); wrap via fixAngle into [-180, 180).
    const wrappedTilt = fixAngle(s.modelOri.tilt);
    const wrappedRoll = fixAngle(s.modelOri.roll);
    if (Math.abs(wrappedTilt) > maxAbsTiltDeg) maxAbsTiltDeg = Math.abs(wrappedTilt);
    if (Math.abs(wrappedRoll) > maxAbsRollDeg) maxAbsRollDeg = Math.abs(wrappedRoll);

    let camLat: number | undefined;
    let camLng: number | undefined;
    let camAlt: number | undefined;
    let groundAlt: number | undefined;

    if (s.camPos) {
      camAlt = s.camPos.altitude;
      if (Math.abs(s.camPos.altitude) < 0.01) {
        eyeZeroSpikes++;
      } else {
        const projected = eyeToTargetLatLng(s.camPos, s.mapHeading, s.mapTilt, s.targetRange);
        camLat = projected.lat;
        camLng = projected.lng;
        groundAlt =
          extractGroundAltitude(s.camPos.altitude, s.targetRange, s.mapTilt) - s.targetAltOffset;
        lagEyeSamples.push(horizontalDistanceM(s.modelPos, projected));
        if (groundAlt < minGroundAlt) minGroundAlt = groundAlt;
        if (groundAlt > maxGroundAlt) maxGroundAlt = groundAlt;
      }
    }

    const modelAlt =
      groundAlt !== undefined ? groundAlt + s.modelPos.altitude : s.modelPos.altitude;
    smoothnessSamples.push({
      tMs: s.tMs,
      dtS: s.dtS,
      modelLat: s.modelPos.lat,
      modelLng: s.modelPos.lng,
      modelAlt,
      headingDeg: s.modelOri.heading,
      tiltDeg: wrappedTilt,
      rollDeg: wrappedRoll,
      camLat,
      camLng,
      camAlt,
      groundAlt,
    });
  }

  lagEyeSamples.sort((a, b) => a - b);
  const firstPos = capture.samples[0]?.modelPos;
  const lastPos = capture.samples[capture.samples.length - 1]?.modelPos;
  const drivenM = firstPos && lastPos ? horizontalDistanceM(firstPos, lastPos) : 0;

  return {
    drivenM,
    maxAbsTiltDeg,
    maxAbsRollDeg,
    eyeZeroSpikes,
    groundAltSpanM: Number.isFinite(minGroundAlt) ? maxGroundAlt - minGroundAlt : 0,
    lagEyeCount: lagEyeSamples.length,
    lagEyeP95M: nearestRankPercentile(lagEyeSamples, 0.95),
    lagEyeMaxM: lagEyeSamples.length ? (lagEyeSamples[lagEyeSamples.length - 1] ?? 0) : 0,
    smoothness: computeSmoothnessMetrics(smoothnessSamples),
  };
}

// Real-browser terrain-tilt E2E tests against public Google Maps 3D JS API custom elements:
// https://developers.google.com/maps/documentation/javascript/3d/overview
// https://developers.google.com/maps/documentation/javascript/reference/3d-map
test.describe('Monster Milktruck terrain tilt E2E tests', () => {
  let app: AppServer | null = null;

  test.beforeAll(async () => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY is required to run browser terrain E2E tests.');
    }
    app = await buildAndServeApp(apiKey);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('Whistler hilly drive produces smooth non-zero terrain pitch with tight eye tracking and zero 0m spikes', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    const whistler = PRESETS.find((p) => p.label === 'Whistler')!;

    await page.goto(app!.url);
    await waitForMapReadyAndSteady(page, PRESETS.length);
    await teleportToPresetAndWaitSteady(page, whistler);

    await startTelemetryCapture(page);
    try {
      await page.keyboard.down('ArrowUp');
      await waitForDrivenMeters(page, whistler, 90, 15_000);
      // Include a brief right steer so banking roll smoothness is exercised alongside mountain pitch
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(800);
    } finally {
      await page.keyboard.up('ArrowRight');
      await page.keyboard.up('ArrowUp');
    }

    const capture = await stopTelemetryCapture(page);
    const summary = summarizeTelemetry(capture);

    expect(capture.samples.length).toBeGreaterThanOrEqual(5);
    expect(summary.drivenM).toBeGreaterThan(80);
    expect(summary.lagEyeCount).toBeGreaterThanOrEqual(3);

    // Non-zero smooth pitch responds to Whistler slope (wrapped from [0, 360) via fixAngle)
    expect(summary.maxAbsTiltDeg).toBeGreaterThan(1.0);
    expect(summary.maxAbsTiltDeg).toBeLessThanOrEqual(35.1);

    // Bounded per-frame tilt and roll steps & angular rate
    expect(summary.smoothness.maxTiltStepDeg).toBeLessThan(20);
    expect(summary.smoothness.maxTiltRateDegS).toBeLessThan(80);
    expect(summary.smoothness.maxRollStepDeg).toBeLessThan(15);
    expect(summary.maxAbsRollDeg).toBeLessThanOrEqual(30.1);

    // Camera eye projection stays tightly locked to model with zero 0 m altitude spikes
    expect(summary.lagEyeP95M).toBeLessThan(5);
    expect(summary.lagEyeMaxM).toBeLessThan(15);
    expect(summary.eyeZeroSpikes).toBe(0);

    // Model remains ground-clamped at altitude === 0
    for (const s of capture.samples) {
      expect(s.modelPos.altitude).toBe(0);
    }
    expect(errors).toEqual([]);
  });

  test('San Francisco flat downtown drive stays calm without post-teleport nose-down spike', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    const sf = PRESETS.find((p) => p.label === 'San Francisco')!;

    await page.goto(app!.url);
    await waitForMapReadyAndSteady(page, PRESETS.length);
    await teleportToPresetAndWaitSteady(page, sf);

    await startTelemetryCapture(page);
    try {
      await page.keyboard.down('ArrowUp');
      await waitForDrivenMeters(page, sf, 75, 15_000);
    } finally {
      await page.keyboard.up('ArrowUp');
    }

    const capture = await stopTelemetryCapture(page);
    const summary = summarizeTelemetry(capture);

    expect(capture.samples.length).toBeGreaterThanOrEqual(4);
    expect(summary.drivenM).toBeGreaterThan(60);

    // Flat downtown ground stays calm (guards against any +20° post-teleport nose-down spike)
    expect(summary.maxAbsTiltDeg).toBeLessThan(10);
    expect(summary.smoothness.maxTiltStepDeg).toBeLessThan(10);

    // Ground-clamped model altitude and clean eye tracking
    expect(summary.eyeZeroSpikes).toBe(0);
    if (summary.lagEyeCount > 0) {
      expect(summary.lagEyeP95M).toBeLessThan(5);
    }
    for (const s of capture.samples) {
      expect(s.modelPos.altitude).toBe(0);
    }
    expect(errors).toEqual([]);
  });

  test('?fixedAltitude=1 keeps tilt === 0 and altitude === 0 while driving and emits zero idle writes', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    const origin = PRESETS[0]!;

    await page.goto(`${app!.url}/?fixedAltitude=1`);
    await waitForMapReadyAndSteady(page, PRESETS.length);

    // Wait two settled rAF ticks so any initial steady snap completes before measuring idle writes
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    // 1. Idle zero-write verification
    await startTelemetryCapture(page);
    await page.waitForTimeout(1_400);
    const idleCapture = await stopTelemetryCapture(page);

    expect(idleCapture.flyCalls).toBe(0);
    expect(idleCapture.posWrites).toBe(0);
    expect(idleCapture.oriWrites).toBe(0);
    for (const s of idleCapture.samples) {
      expect(Math.abs(fixAngle(s.modelOri.tilt))).toBeLessThan(0.01);
      expect(s.modelPos.altitude).toBe(0);
    }

    // 2. Driving parity under ?fixedAltitude=1 (ABSOLUTE mode, tilt === 0, altitude === 0)
    await startTelemetryCapture(page);
    try {
      await page.keyboard.down('ArrowUp');
      await waitForDrivenMeters(page, origin, 60, 15_000);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(600);
    } finally {
      await page.keyboard.up('ArrowRight');
      await page.keyboard.up('ArrowUp');
    }

    const driveCapture = await stopTelemetryCapture(page);
    const driveSummary = summarizeTelemetry(driveCapture);

    expect(driveSummary.drivenM).toBeGreaterThan(50);
    expect(driveCapture.flyCalls).toBeGreaterThan(0);
    for (const mode of driveCapture.flyModes) {
      expect(mode).toBe('ABSOLUTE');
    }
    for (const alt of driveCapture.flyCenterAlts) {
      expect(alt).toBe(0);
    }
    expect(driveSummary.maxAbsTiltDeg).toBeLessThan(0.01);
    for (const s of driveCapture.samples) {
      expect(Math.abs(fixAngle(s.modelOri.tilt))).toBe(0);
      expect(s.modelPos.altitude).toBe(0);
    }
    expect(errors).toEqual([]);
  });
});
