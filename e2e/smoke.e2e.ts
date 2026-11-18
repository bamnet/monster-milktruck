import { expect, test, type Page } from '@playwright/test';
import { PRESETS } from '../src/config.ts';
import { fixAngle } from '../src/math3d.ts';
import { eyeToTargetLatLng } from '../src/terrain-pitch.ts';
import {
  attachErrorTracking,
  buildAndServeApp,
  horizontalDistanceMeters,
  loadEnvIfNeeded,
  teleportToPresetAndWaitSteady,
  waitForMapReadyAndSteady,
  type AppServer,
} from './helpers.ts';

loadEnvIfNeeded();

const DEFAULT_CAM_TILT_DEG = 72;
const DEFAULT_CAM_RANGE_M = 55;

interface MapAndModelSnapshot {
  modelPos: { lat: number; lng: number };
  camPos: { lat: number; lng: number; altitude: number } | null;
  mapCenter: { lat: number; lng: number };
  mapHeading: number;
  mapTilt: number;
}

// Public Google Maps 3D JS API custom elements and properties tested below:
// https://developers.google.com/maps/documentation/javascript/3d/overview
// https://developers.google.com/maps/documentation/javascript/reference/3d-map
async function waitForMapAndModelReady(page: Page): Promise<void> {
  await page.waitForFunction(
    (expectedPresets: number) => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement | null;
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement | null;
      const presets = document.querySelectorAll('#presets button');
      return Boolean(
        map &&
        model &&
        customElements.get('gmp-map-3d') &&
        customElements.get('gmp-model-3d') &&
        typeof map.flyCameraTo === 'function' &&
        model.position &&
        presets.length === expectedPresets
      );
    },
    PRESETS.length,
    { timeout: 20_000 },
  );
}

/**
 * Reads prototype getters on `gmp-map-3d` and `gmp-model-3d` into plain values.
 */
async function readMapAndModelSnapshot(page: Page): Promise<MapAndModelSnapshot> {
  return page.evaluate((defaultTilt: number) => {
    const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement & {
      cameraPosition?: google.maps.LatLngAltitude | null;
    };
    const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
    const cp = map.cameraPosition;
    const c = map.center as google.maps.LatLngAltitude | null;
    const p = model.position as google.maps.LatLngAltitude;
    const camPos =
      cp &&
      Number.isFinite(cp.lat) &&
      Number.isFinite(cp.lng) &&
      Number.isFinite(cp.altitude) &&
      Math.abs(cp.altitude) >= 0.01
        ? { lat: cp.lat, lng: cp.lng, altitude: cp.altitude }
        : null;
    return {
      modelPos: { lat: p.lat, lng: p.lng },
      camPos,
      mapCenter: { lat: c?.lat ?? 0, lng: c?.lng ?? 0 },
      mapHeading: typeof map.heading === 'number' && Number.isFinite(map.heading) ? map.heading : 0,
      mapTilt:
        typeof map.tilt === 'number' && Number.isFinite(map.tilt) ? map.tilt : defaultTilt,
    };
  }, DEFAULT_CAM_TILT_DEG);
}

/**
 * Projects the 3D camera eye onto its ground look-at target (`eyeToTargetLatLng`),
 * avoiding `map.center` 3D mesh raycast overshoot on steep ridges or trees/buildings.
 * Falls back to `map.center` only when `map.cameraPosition` is unavailable.
 */
function resolveCameraTarget(snap: MapAndModelSnapshot): { lat: number; lng: number } {
  if (snap.camPos) {
    return eyeToTargetLatLng(snap.camPos, snap.mapHeading, snap.mapTilt, DEFAULT_CAM_RANGE_M);
  }
  return snap.mapCenter;
}

test.describe('Monster Milktruck browser smoke tests', () => {
  let app: AppServer | null = null;

  test.beforeAll(async () => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY is required to run browser smoke tests.');
    }
    app = await buildAndServeApp(apiKey);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('displays a clear fatal error when GOOGLE_MAPS_API_KEY is missing', async ({ page }) => {
    const keylessApp = await buildAndServeApp('');
    const errors = attachErrorTracking(page);
    try {
      await page.goto(keylessApp.url);
      const fatal = page.locator('#fatal');
      await expect(fatal).toBeVisible();
      await expect(fatal).toContainText('GOOGLE_MAPS_API_KEY');
      await expect(page.locator('#loading-screen')).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await keylessApp.close();
    }
  });

  test('upgrades gmp-map-3d and gmp-model-3d, toggles map mode, and honors ?fixedAltitude', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    await page.goto(app!.url);
    await waitForMapAndModelReady(page);

    const initState = await page.evaluate(() => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
      const pos = model.position as google.maps.LatLngAltitude;
      const fatal = document.getElementById('fatal');
      const loadingScreen = document.getElementById('loading-screen');
      return {
        fatalHidden: Boolean(fatal?.hidden),
        hasLoadingScreen: Boolean(loadingScreen),
        mode: String(map.mode),
        modelPos: { lat: pos.lat, lng: pos.lng },
      };
    });

    expect(initState.fatalHidden).toBe(true);
    expect(initState.hasLoadingScreen).toBe(true);
    expect(initState.mode).toBe('SATELLITE');
    expect(horizontalDistanceMeters(initState.modelPos, PRESETS[0]!)).toBeLessThan(1);

    await page.locator('#map-mode').selectOption('ROADMAP');
    const switchedMode = await page.evaluate(() =>
      String((document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement).mode),
    );
    expect(switchedMode).toBe('ROADMAP');
    expect(errors).toEqual([]);

    // Verify ?fixedAltitude configures AltitudeMode.ABSOLUTE on flyCameraTo
    await page.goto(`${app!.url}/?fixedAltitude=1`);
    await waitForMapAndModelReady(page);
    await page.evaluate(() => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
      (window as unknown as { __lastFlyMode: string | null }).__lastFlyMode = null;
      const orig = map.flyCameraTo.bind(map);
      map.flyCameraTo = (opts: google.maps.maps3d.FlyToAnimationOptions) => {
        (window as unknown as { __lastFlyMode: string | null }).__lastFlyMode =
          opts?.endCamera?.altitudeMode ?? null;
        return orig(opts);
      };
    });

    await page.keyboard.down('ArrowUp');
    await page.waitForFunction(
      () => (window as unknown as { __lastFlyMode: string | null }).__lastFlyMode !== null,
    );
    await page.keyboard.up('ArrowUp');

    const flyMode = await page.evaluate(
      () => (window as unknown as { __lastFlyMode: string | null }).__lastFlyMode,
    );
    expect(flyMode).toBe('ABSOLUTE');
    expect(errors).toEqual([]);
  });

  test('produces zero idle camera churn and prevents arrow keys from panning a focused map', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    await page.goto(app!.url);
    await waitForMapReadyAndSteady(page, PRESETS.length);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    await page.evaluate(() => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
      (window as unknown as { __flyCount: number }).__flyCount = 0;
      const orig = map.flyCameraTo.bind(map);
      map.flyCameraTo = (opts: google.maps.maps3d.FlyToAnimationOptions) => {
        (window as unknown as { __flyCount: number }).__flyCount++;
        return orig(opts);
      };
    });

    await page.waitForTimeout(500);
    const beforeIdle = await page.evaluate(
      () => (window as unknown as { __flyCount: number }).__flyCount,
    );
    expect(beforeIdle).toBeLessThanOrEqual(1);

    await page.waitForTimeout(1_200);
    const afterIdle = await page.evaluate(
      () => (window as unknown as { __flyCount: number }).__flyCount,
    );
    expect(afterIdle - beforeIdle).toBeLessThanOrEqual(1);

    // Focus the map container and hold ArrowLeft while stationary (speed = 0).
    // Because Truck does not steer at zero speed, camera target must remain unchanged.
    await page.locator('#map-container').click();
    const beforeKeySnap = await readMapAndModelSnapshot(page);
    const flyBeforeKey = await page.evaluate(
      () => (window as unknown as { __flyCount: number }).__flyCount,
    );

    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(150);

    const afterKeySnap = await readMapAndModelSnapshot(page);
    const flyAfterKey = await page.evaluate(
      () => (window as unknown as { __flyCount: number }).__flyCount,
    );

    expect(flyAfterKey).toBe(flyBeforeKey);
    expect(
      horizontalDistanceMeters(resolveCameraTarget(beforeKeySnap), resolveCameraTarget(afterKeySnap)),
    ).toBeLessThan(0.5);
    expect(errors).toEqual([]);
  });

  test('teleports model and camera to a selected preset location', async ({ page }) => {
    const errors = attachErrorTracking(page);
    const whistler = PRESETS.find((p) => p.label === 'Whistler')!;
    await page.goto(app!.url);
    await waitForMapReadyAndSteady(page, PRESETS.length);
    await teleportToPresetAndWaitSteady(page, whistler);

    const landed = await readMapAndModelSnapshot(page);
    const cameraTarget = resolveCameraTarget(landed);

    expect(horizontalDistanceMeters(landed.modelPos, whistler)).toBeLessThan(1);
    expect(horizontalDistanceMeters(cameraTarget, whistler)).toBeLessThan(25);
    expect(Math.abs(fixAngle(landed.mapHeading - whistler.heading))).toBeLessThan(3);
    expect(errors).toEqual([]);
  });

  test('drives truck forward on ArrowUp and keeps camera center tracking model position', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    await page.goto(app!.url);
    await waitForMapReadyAndSteady(page, PRESETS.length);

    const startSnap = await readMapAndModelSnapshot(page);

    try {
      await page.keyboard.down('ArrowUp');
      await page.waitForFunction(
        (origin: { lat: number; lng: number }) => {
          const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
          const p = model.position as google.maps.LatLngAltitude | null;
          if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
          const dLat = ((p.lat - origin.lat) * Math.PI) / 180;
          const dLng = ((p.lng - origin.lng) * Math.PI) / 180;
          const midLat = (((origin.lat + p.lat) * 0.5) * Math.PI) / 180;
          const dist = Math.hypot(dLng * 6378137 * Math.cos(midLat), dLat * 6378137);
          return dist >= 45;
        },
        startSnap.modelPos,
        { timeout: 15_000 },
      );
    } finally {
      await page.keyboard.up('ArrowUp');
    }

    let drivenM = 0;
    let cameraMovedM = 0;
    let trackingOffsetM = Infinity;

    await expect
      .poll(
        async () => {
          const snap = await readMapAndModelSnapshot(page);
          const target = resolveCameraTarget(snap);
          drivenM = horizontalDistanceMeters(startSnap.modelPos, snap.modelPos);
          cameraMovedM = horizontalDistanceMeters(startSnap.modelPos, target);
          trackingOffsetM = horizontalDistanceMeters(snap.modelPos, target);
          return cameraMovedM > 25 && trackingOffsetM < 25;
        },
        { timeout: 8_000 },
      )
      .toBe(true);

    expect(drivenM).toBeGreaterThan(40);
    expect(cameraMovedM).toBeGreaterThan(25);
    expect(trackingOffsetM).toBeLessThan(25);
    expect(errors).toEqual([]);
  });
});
