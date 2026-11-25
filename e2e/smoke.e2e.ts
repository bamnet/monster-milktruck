import { expect, test, type Page } from '@playwright/test';
import { PRESETS } from '../src/config.ts';
import { fixAngle } from '../src/math3d.ts';
import {
  attachErrorTracking,
  buildAndServeApp,
  eyeToTargetLatLng,
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

  test('upgrades gmp-map-3d and gmp-model-3d, toggles map mode, and re-snaps camera on mode switch', async ({
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

    await page.locator('#map-mode').selectOption('ROADMAP');
    const switchedState = await page.evaluate(() => ({
      mode: String((document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement).mode),
      flyMode: (window as unknown as { __lastFlyMode: string | null }).__lastFlyMode,
    }));
    expect(switchedState.mode).toBe('ROADMAP');
    expect(switchedState.flyMode).toBe('RELATIVE_TO_GROUND');
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
    // Because Truck does not steer at zero speed, the projected camera target must remain unchanged.
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

  test('drives truck forward on ArrowUp and keeps camera target tracking model position', async ({
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

    await expect(async () => {
      const snap = await readMapAndModelSnapshot(page);
      const target = resolveCameraTarget(snap);
      expect(horizontalDistanceMeters(startSnap.modelPos, snap.modelPos)).toBeGreaterThan(40);
      expect(horizontalDistanceMeters(startSnap.modelPos, target)).toBeGreaterThan(25);
      expect(horizontalDistanceMeters(snap.modelPos, target)).toBeLessThan(25);
    }).toPass({ timeout: 8_000, intervals: [200] });

    expect(errors).toEqual([]);
  });

  test('deep-links location, heading, and map mode via URL hash and syncs live updates cleanly', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    const sf = PRESETS.find((p) => p.label === 'San Francisco')!;
    const whistler = PRESETS.find((p) => p.label === 'Whistler')!;
    const tokyo = PRESETS.find((p) => p.label === 'Tokyo')!;

    // 1. Load directly from a deep-linked URL hash in roadmap mode (while preserving query params)
    await page.goto(
      `${app!.url}/?utm_source=share#lat=${sf.lat.toFixed(6)}&lng=${sf.lng.toFixed(6)}&heading=220&mode=roadmap`,
    );
    await waitForMapAndModelReady(page);

    const bootSnap = await readMapAndModelSnapshot(page);
    const bootMeta = await page.evaluate(() => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
      return {
        mapMode: String(map.mode),
        selectValue: (document.getElementById('map-mode') as HTMLSelectElement).value,
        search: window.location.search,
        hash: window.location.hash,
      };
    });

    expect(bootMeta.mapMode).toBe('ROADMAP');
    expect(bootMeta.selectValue).toBe('ROADMAP');
    expect(bootMeta.search).toBe('?utm_source=share');
    expect(bootMeta.hash).toBe('#lat=37.774900&lng=-122.419400&heading=220&mode=roadmap');
    expect(horizontalDistanceMeters(bootSnap.modelPos, sf)).toBeLessThan(1);
    expect(horizontalDistanceMeters(resolveCameraTarget(bootSnap), sf)).toBeLessThan(25);
    expect(Math.abs(fixAngle(bootSnap.mapHeading - 220))).toBeLessThan(3);

    // 2. Switching map mode and clicking a preset update the URL hash immediately
    await page.locator('#map-mode').selectOption('SATELLITE');
    expect(await page.evaluate(() => window.location.hash)).toBe(
      '#lat=37.774900&lng=-122.419400&heading=220&mode=satellite',
    );

    await page.locator('#presets button', { hasText: whistler.label }).click();
    expect(await page.evaluate(() => window.location.hash)).toBe(
      `#lat=${whistler.lat.toFixed(6)}&lng=${whistler.lng.toFixed(6)}&heading=${whistler.heading}&mode=satellite`,
    );
    expect(await page.evaluate(() => window.location.search)).toBe('?utm_source=share');

    // 3. Editing window.location.hash in-place teleports and updates map mode without reload
    await page.evaluate(
      ({ lat, lng, heading }) => {
        window.location.hash = `#lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&heading=${heading}&mode=roadmap`;
      },
      tokyo,
    );

    await expect(async () => {
      const state = await page.evaluate(() => {
        const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
        const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
        const p = model.position as google.maps.LatLngAltitude;
        const select = document.getElementById('map-mode') as HTMLSelectElement;
        return {
          mapMode: String(map.mode),
          selectValue: select.value,
          modelPos: { lat: p.lat, lng: p.lng },
        };
      });
      expect(state.mapMode).toBe('ROADMAP');
      expect(state.selectValue).toBe('ROADMAP');
      expect(horizontalDistanceMeters(state.modelPos, tokyo)).toBeLessThan(2);
    }).toPass({ timeout: 5_000, intervals: [150] });

    // 4. Driving throttles history.replaceState calls while moving
    await page.evaluate(() => {
      const win = window as unknown as { __replaceCount: number };
      win.__replaceCount = 0;
      const orig = window.history.replaceState.bind(window.history);
      window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
        win.__replaceCount++;
        return orig(...args);
      };
    });

    const driveStartMs = Date.now();
    try {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(1_300);
      await expect(async () => {
        const { modelPos, hashPos } = await page.evaluate(() => {
          const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
          const p = model.position as google.maps.LatLngAltitude;
          const params = new URLSearchParams(window.location.hash.slice(1));
          return {
            modelPos: { lat: p.lat, lng: p.lng },
            hashPos: {
              lat: Number(params.get('lat')),
              lng: Number(params.get('lng')),
            },
          };
        });
        expect(horizontalDistanceMeters(modelPos, tokyo)).toBeGreaterThan(15);
        expect(horizontalDistanceMeters(hashPos, tokyo)).toBeGreaterThan(1);
      }).toPass({ timeout: 5_000, intervals: [150] });
    } finally {
      await page.keyboard.up('ArrowUp');
    }

    const driveElapsedMs = Date.now() - driveStartMs;
    const replaceCount = await page.evaluate(
      () => (window as unknown as { __replaceCount: number }).__replaceCount,
    );
    expect(replaceCount).toBeGreaterThanOrEqual(1);
    expect(replaceCount).toBeLessThanOrEqual(Math.ceil(driveElapsedMs / 1_000) + 2);

    // 5. Coming to rest after a brief nudge flushes the exact final position to the URL hash
    await page.locator('#presets button', { hasText: sf.label }).click();
    await page.waitForFunction((target: { lat: number; lng: number }) => {
      const p = (document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement)
        .position as google.maps.LatLngAltitude;
      return Math.abs(p.lat - target.lat) < 0.00001 && Math.abs(p.lng - target.lng) < 0.00001;
    }, sf);

    // Release ArrowUp synchronously in-page on the first frame past 0.2m so launch speed
    // stays <= 12 m/s (<= ~6s sim coast time) regardless of SwiftShader frame rate / IPC lag.
    await page.evaluate(
      (origin: { lat: number; lng: number }) =>
        new Promise<void>((resolve, reject) => {
          const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
          const deadline = window.setTimeout(() => {
            window.dispatchEvent(
              new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true, cancelable: true }),
            );
            reject(new Error('Timed out waiting for truck nudge past 0.2m'));
          }, 5_000);
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
          );
          const check = () => {
            const p = model.position as google.maps.LatLngAltitude | null;
            if (p) {
              const dN = (p.lat - origin.lat) * 111_319.9;
              const dE =
                (p.lng - origin.lng) * 111_319.9 * Math.cos((origin.lat * Math.PI) / 180);
              if (Math.hypot(dE, dN) > 0.2) {
                window.clearTimeout(deadline);
                window.dispatchEvent(
                  new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true, cancelable: true }),
                );
                resolve();
                return;
              }
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }),
      sf,
    );

    let prevPos: { lat: number; lng: number } | null = null;
    await expect(async () => {
      const { modelPos, hashPos } = await page.evaluate(() => {
        const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
        const p = model.position as google.maps.LatLngAltitude;
        const params = new URLSearchParams(window.location.hash.slice(1));
        return {
          modelPos: { lat: p.lat, lng: p.lng },
          hashPos: {
            lat: Number(params.get('lat')),
            lng: Number(params.get('lng')),
          },
        };
      });
      const stopped =
        prevPos !== null &&
        prevPos.lat === modelPos.lat &&
        prevPos.lng === modelPos.lng;
      prevPos = modelPos;
      expect(stopped).toBe(true);
      expect(horizontalDistanceMeters(modelPos, sf)).toBeGreaterThan(0.5);
      expect(horizontalDistanceMeters(modelPos, hashPos)).toBeLessThan(0.25);
    }).toPass({ timeout: 20_000, intervals: [350] });

    expect(errors).toEqual([]);
  });
});
