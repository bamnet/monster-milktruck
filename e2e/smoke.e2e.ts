import { expect, test, type Page } from '@playwright/test';
import { PRESETS } from '../src/config.ts';
import { fixAngle } from '../src/math3d.ts';
import {
  attachErrorTracking,
  buildAndServeApp,
  horizontalDistanceMeters,
  loadEnvIfNeeded,
  type AppServer,
} from './helpers.ts';

loadEnvIfNeeded();

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
  });

  test('produces zero idle camera churn and prevents arrow keys from panning a focused map', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    await page.goto(app!.url);
    await waitForMapAndModelReady(page);

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
    // Because Truck does not steer at zero speed, map.center must remain unchanged.
    await page.locator('#map-container').click();
    const centerBefore = await page.evaluate(() => {
      const c = (document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement)
        .center as google.maps.LatLngAltitude;
      return { lat: c.lat, lng: c.lng };
    });
    const flyBeforeKey = await page.evaluate(
      () => (window as unknown as { __flyCount: number }).__flyCount,
    );

    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(150);

    const afterKey = await page.evaluate(() => {
      const c = (document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement)
        .center as google.maps.LatLngAltitude;
      return {
        flyCount: (window as unknown as { __flyCount: number }).__flyCount,
        center: { lat: c.lat, lng: c.lng },
      };
    });

    expect(afterKey.flyCount).toBe(flyBeforeKey);
    expect(horizontalDistanceMeters(centerBefore, afterKey.center)).toBeLessThan(0.5);
    expect(errors).toEqual([]);
  });

  test('teleports model and camera to a selected preset location', async ({ page }) => {
    const whistler = PRESETS.find((p) => p.label === 'Whistler')!;
    await page.goto(app!.url);
    await waitForMapAndModelReady(page);

    await page.locator('#presets button', { hasText: 'Whistler' }).click();

    await page.waitForFunction(
      (target: { lat: number; lng: number }) => {
        const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
        const c = map.center as google.maps.LatLngAltitude;
        return Math.abs(c.lat - target.lat) < 0.001 && Math.abs(c.lng - target.lng) < 0.001;
      },
      { lat: whistler.lat, lng: whistler.lng },
      { timeout: 12_000 },
    );

    const landed = await page.evaluate(() => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
      const c = map.center as google.maps.LatLngAltitude;
      const p = model.position as google.maps.LatLngAltitude;
      return {
        mapCenter: { lat: c.lat, lng: c.lng },
        mapHeading: map.heading ?? 0,
        modelPos: { lat: p.lat, lng: p.lng },
      };
    });

    expect(horizontalDistanceMeters(landed.modelPos, whistler)).toBeLessThan(1);
    expect(horizontalDistanceMeters(landed.mapCenter, whistler)).toBeLessThan(100);
    expect(Math.abs(fixAngle(landed.mapHeading - whistler.heading))).toBeLessThan(3);
  });

  test('drives truck forward on ArrowUp and keeps camera center tracking model position', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    await page.goto(app!.url);
    await waitForMapAndModelReady(page);
    await page.waitForTimeout(1_500);

    const startPos = await page.evaluate(() => {
      const p = (document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement)
        .position as google.maps.LatLngAltitude;
      return { lat: p.lat, lng: p.lng };
    });

    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1_800);
    await page.keyboard.up('ArrowUp');

    await page.waitForFunction(
      (initLng: number) => {
        const c = (document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement)
          .center as google.maps.LatLngAltitude;
        return Math.abs(c.lng - initLng) > 0.0002;
      },
      PRESETS[0]!.lng,
      { timeout: 8_000 },
    );

    const endState = await page.evaluate(() => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
      const c = map.center as google.maps.LatLngAltitude;
      const p = model.position as google.maps.LatLngAltitude;
      return {
        modelPos: { lat: p.lat, lng: p.lng },
        mapCenter: { lat: c.lat, lng: c.lng },
      };
    });

    const drivenM = horizontalDistanceMeters(startPos, endState.modelPos);
    const cameraMovedM = horizontalDistanceMeters(startPos, endState.mapCenter);
    const trackingOffsetM = horizontalDistanceMeters(endState.modelPos, endState.mapCenter);

    expect(drivenM).toBeGreaterThan(40);
    expect(cameraMovedM).toBeGreaterThan(25);
    expect(trackingOffsetM).toBeLessThan(80);
    expect(errors).toEqual([]);
  });

  test('deep-links location, heading, and map mode via URL hash and syncs live updates cleanly', async ({
    page,
  }) => {
    const errors = attachErrorTracking(page);
    const sf = PRESETS.find((p) => p.label === 'San Francisco')!;
    const whistler = PRESETS.find((p) => p.label === 'Whistler')!;
    const tokyo = PRESETS.find((p) => p.label === 'Tokyo')!;

    // 1. Load directly from a deep-linked URL hash (while preserving ?fixedAltitude=1)
    await page.goto(
      `${app!.url}/?fixedAltitude=1#lat=${sf.lat.toFixed(6)}&lng=${sf.lng.toFixed(6)}&heading=220&mode=roadmap`,
    );
    await waitForMapAndModelReady(page);

    const bootState = await page.evaluate(() => {
      const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
      const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
      const c = map.center as google.maps.LatLngAltitude;
      const p = model.position as google.maps.LatLngAltitude;
      return {
        mapMode: String(map.mode),
        selectValue: (document.getElementById('map-mode') as HTMLSelectElement).value,
        search: window.location.search,
        hash: window.location.hash,
        mapCenter: { lat: c.lat, lng: c.lng },
        mapHeading: map.heading ?? 0,
        modelPos: { lat: p.lat, lng: p.lng },
      };
    });

    expect(bootState.mapMode).toBe('ROADMAP');
    expect(bootState.selectValue).toBe('ROADMAP');
    expect(bootState.search).toBe('?fixedAltitude=1');
    expect(bootState.hash).toBe('#lat=37.774900&lng=-122.419400&heading=220&mode=roadmap');
    expect(horizontalDistanceMeters(bootState.modelPos, sf)).toBeLessThan(1);
    expect(horizontalDistanceMeters(bootState.mapCenter, sf)).toBeLessThan(25);
    expect(Math.abs(fixAngle(bootState.mapHeading - 220))).toBeLessThan(3);

    // 2. Switching map mode and clicking a preset update the URL hash immediately
    await page.locator('#map-mode').selectOption('SATELLITE');
    expect(await page.evaluate(() => window.location.hash)).toBe(
      '#lat=37.774900&lng=-122.419400&heading=220&mode=satellite',
    );

    await page.locator('#presets button', { hasText: whistler.label }).click();
    expect(await page.evaluate(() => window.location.hash)).toBe(
      `#lat=${whistler.lat.toFixed(6)}&lng=${whistler.lng.toFixed(6)}&heading=${whistler.heading}&mode=satellite`,
    );
    expect(await page.evaluate(() => window.location.search)).toBe('?fixedAltitude=1');

    // 3. Editing window.location.hash in-place teleports and updates map mode without reload
    await page.evaluate(
      ({ lat, lng, heading }) => {
        window.location.hash = `#lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&heading=${heading}&mode=roadmap`;
      },
      tokyo,
    );

    await expect
      .poll(async () => {
        return page.evaluate((target: { lat: number; lng: number }) => {
          const map = document.querySelector('gmp-map-3d') as google.maps.maps3d.Map3DElement;
          const model = document.querySelector('gmp-model-3d') as google.maps.maps3d.Model3DElement;
          const p = model.position as google.maps.LatLngAltitude;
          const select = document.getElementById('map-mode') as HTMLSelectElement;
          return (
            String(map.mode) === 'ROADMAP' &&
            select.value === 'ROADMAP' &&
            Math.abs(p.lat - target.lat) < 0.00001 &&
            Math.abs(p.lng - target.lng) < 0.00001
          );
        }, tokyo);
      })
      .toBe(true);

    // 4. Driving throttles history.replaceState calls and flushes exact final position on stop
    await page.evaluate(() => {
      const win = window as unknown as { __replaceCount: number };
      win.__replaceCount = 0;
      const orig = window.history.replaceState.bind(window.history);
      window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
        win.__replaceCount++;
        return orig(...args);
      };
    });

    try {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(1_300);
    } finally {
      await page.keyboard.up('ArrowUp');
    }

    await expect
      .poll(
        async () => {
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
          return (
            horizontalDistanceMeters(modelPos, tokyo) > 15 &&
            horizontalDistanceMeters(modelPos, hashPos) < 0.25
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const replaceCount = await page.evaluate(
      () => (window as unknown as { __replaceCount: number }).__replaceCount,
    );
    expect(replaceCount).toBeGreaterThanOrEqual(1);
    expect(replaceCount).toBeLessThanOrEqual(6);
    expect(errors).toEqual([]);
  });
});
