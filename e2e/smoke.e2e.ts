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
      return {
        fatalHidden: Boolean(fatal?.hidden),
        mode: String(map.mode),
        modelPos: { lat: pos.lat, lng: pos.lng },
      };
    });

    expect(initState.fatalHidden).toBe(true);
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
});
