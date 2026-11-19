import { describe, expect, test } from 'bun:test';
import type { InputState } from './input.ts';
import { degToRad, fixAngle } from './math3d.ts';
import { Truck } from './truck.ts';

interface FakeMap {
  flyCalls: google.maps.maps3d.FlyToAnimationOptions[];
  center: google.maps.LatLngAltitudeLiteral;
  range: number;
  dispatchSteady(isSteady: boolean): void;
  dispatchCenterChange(): void;
  dispatchAnimationEnd(): void;
  element: google.maps.maps3d.Map3DElement;
}

interface FakeModel {
  positionWrites: google.maps.LatLngAltitudeLiteral[];
  orientationWrites: google.maps.Orientation3DLiteral[];
  element: google.maps.maps3d.Model3DElement;
}

function createFakeMap(): FakeMap {
  const target = new EventTarget();
  const flyCalls: google.maps.maps3d.FlyToAnimationOptions[] = [];
  const state: { center: google.maps.LatLngAltitudeLiteral; range: number } = {
    center: { lat: 0, lng: 0, altitude: 0 },
    range: 55,
  };

  const element = {
    get center() {
      return state.center;
    },
    set center(val: google.maps.LatLngAltitudeLiteral) {
      state.center = val;
    },
    get range() {
      return state.range;
    },
    set range(val: number) {
      state.range = val;
    },
    flyCameraTo(options: google.maps.maps3d.FlyToAnimationOptions) {
      flyCalls.push(options);
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as google.maps.maps3d.Map3DElement;

  return {
    flyCalls,
    get center() {
      return state.center;
    },
    set center(val: google.maps.LatLngAltitudeLiteral) {
      state.center = val;
    },
    get range() {
      return state.range;
    },
    set range(val: number) {
      state.range = val;
    },
    dispatchSteady(isSteady: boolean) {
      const ev = Object.assign(new Event('gmp-steadychange'), { isSteady });
      target.dispatchEvent(ev);
    },
    dispatchCenterChange() {
      target.dispatchEvent(new Event('gmp-centerchange'));
    },
    dispatchAnimationEnd() {
      target.dispatchEvent(new Event('gmp-animationend'));
    },
    element,
  };
}

function createFakeModel(): FakeModel {
  const positionWrites: google.maps.LatLngAltitudeLiteral[] = [];
  const orientationWrites: google.maps.Orientation3DLiteral[] = [];
  let currentPos: google.maps.LatLngAltitudeLiteral = { lat: 0, lng: 0, altitude: 0 };
  let currentOri: google.maps.Orientation3DLiteral = { heading: 0, tilt: 0, roll: 0 };

  const element = {
    get position() {
      return currentPos;
    },
    set position(val: google.maps.LatLngAltitudeLiteral) {
      currentPos = val;
      positionWrites.push(val);
    },
    get orientation() {
      return currentOri;
    },
    set orientation(val: google.maps.Orientation3DLiteral) {
      currentOri = val;
      orientationWrites.push(val);
    },
  } as unknown as google.maps.maps3d.Model3DElement;

  return { positionWrites, orientationWrites, element };
}

function createInputState(overrides: Partial<InputState> = {}): InputState {
  return {
    left: false,
    right: false,
    gas: false,
    reverse: false,
    ...overrides,
  };
}

function createFakePopup(): HTMLElement {
  return {
    textContent: '',
    hidden: true,
  } as unknown as HTMLElement;
}

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const metersPerDegLat = 111_319.9;
  const dN = (b.lat - a.lat) * metersPerDegLat;
  const dE = (b.lng - a.lng) * metersPerDegLat * Math.cos(degToRad((a.lat + b.lat) / 2));
  return Math.hypot(dE, dN);
}

const START = { lat: 37.423501, lng: -122.086744, heading: 90 };

describe('Truck', () => {
  test('defers initial camera snap until gmp-steadychange and avoids updates while stationary', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState();
    const popup = createFakePopup();

    let readyCount = 0;
    const truck = new Truck(
      map.element,
      model.element,
      input,
      popup,
      'RELATIVE_TO_GROUND',
      START,
      () => {
        readyCount++;
      },
    );

    expect(model.positionWrites).toHaveLength(1);
    expect(model.orientationWrites).toHaveLength(1);
    expect(map.flyCalls).toHaveLength(0);
    expect(readyCount).toBe(0);

    // 60 stationary frames at 60 FPS should not mutate model or call flyCameraTo
    for (let i = 0; i < 60; i++) {
      truck.step(1 / 60);
    }
    expect(model.positionWrites).toHaveLength(1);
    expect(model.orientationWrites).toHaveLength(1);
    expect(map.flyCalls).toHaveLength(0);

    // Unsteady event should be ignored
    map.dispatchSteady(false);
    expect(map.flyCalls).toHaveLength(0);
    expect(readyCount).toBe(0);

    // First steady event snaps camera once, invokes onReady, then unregisters listener
    map.dispatchSteady(true);
    expect(map.flyCalls).toHaveLength(1);
    expect(readyCount).toBe(1);
    expect(map.flyCalls[0]?.durationMillis).toBe(0);
    expect(map.flyCalls[0]?.endCamera.center).toEqual({
      lat: START.lat,
      lng: START.lng,
      altitude: 0,
    });

    map.dispatchSteady(true);
    expect(map.flyCalls).toHaveLength(1);
    expect(readyCount).toBe(1);
  });

  test('updates model.position without redundantly updating model.orientation when driving straight', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const popup = createFakePopup();

    const truck = new Truck(map.element, model.element, input, popup, 'RELATIVE_TO_GROUND', START);

    expect(model.positionWrites).toHaveLength(1);
    expect(model.orientationWrites).toHaveLength(1);

    for (let i = 0; i < 10; i++) {
      truck.step(1 / 60);
      map.dispatchCenterChange();
    }

    expect(model.positionWrites.length).toBeGreaterThan(5);
    // Heading and roll never changed while driving straight, so orientation was only set once in constructor
    expect(model.orientationWrites).toHaveLength(1);
  });

  test('gates overlapping flyCameraTo(0) calls before initial steady, then updates every frame once steady', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const popup = createFakePopup();

    const truck = new Truck(map.element, model.element, input, popup, 'RELATIVE_TO_GROUND', START);

    // Frame 1 (before initial gmp-steadychange) starts an in-flight camera update
    truck.step(1 / 60);
    expect(map.flyCalls).toHaveLength(1);

    // Frame 2 occurs immediately before gmp-centerchange / gmp-steadychange fires:
    // model position updates, but overlapping flyCameraTo(0) is held back during initial load
    truck.step(1 / 60);
    expect(model.positionWrites).toHaveLength(3);
    expect(map.flyCalls).toHaveLength(1);

    // gmp-animationend also clears the pre-steady in-flight guard
    map.dispatchAnimationEnd();
    truck.step(1 / 60);
    expect(map.flyCalls).toHaveLength(2);

    // Once the initial scene is steady, subsequent driving frames update every frame without gating
    map.dispatchSteady(true);
    truck.step(1 / 60);
    expect(map.flyCalls).toHaveLength(3);
    truck.step(1 / 60);
    expect(map.flyCalls).toHaveLength(4);
  });

  test('clamps residual velocity, roll, and camera lag to zero after coming to rest', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true, right: true });
    const popup = createFakePopup();

    const truck = new Truck(map.element, model.element, input, popup, 'RELATIVE_TO_GROUND', START);

    for (let i = 0; i < 5; i++) {
      truck.step(1 / 60);
      map.dispatchCenterChange();
    }

    input.gas = false;
    input.right = false;
    for (let i = 0; i < 300; i++) {
      truck.step(1 / 60);
      map.dispatchCenterChange();
    }

    const posWritesAfterStop = model.positionWrites.length;
    const oriWritesAfterStop = model.orientationWrites.length;
    const flyCallsAfterStop = map.flyCalls.length;

    for (let i = 0; i < 30; i++) {
      truck.step(1 / 60);
      map.dispatchCenterChange();
    }

    expect(model.positionWrites).toHaveLength(posWritesAfterStop);
    expect(model.orientationWrites).toHaveLength(oriWritesAfterStop);
    expect(map.flyCalls).toHaveLength(flyCallsAfterStop);
  });

  test('teleportTo flies camera over 1200ms, suppresses followCamera during flight, and resumes afterward', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const popup = createFakePopup();

    let fakeNow = 1_000;
    const origNow = performance.now;
    performance.now = () => fakeNow;
    try {
      const truck = new Truck(map.element, model.element, input, popup, 'ABSOLUTE', START);

      truck.teleportTo(35.668607, 139.822026, 180);
      expect(map.flyCalls).toHaveLength(1);
      expect(map.flyCalls[0]?.durationMillis).toBe(1200);
      expect(map.flyCalls[0]?.endCamera.altitudeMode).toBe('ABSOLUTE');
      expect(map.flyCalls[0]?.endCamera.center).toEqual({
        lat: 35.668607,
        lng: 139.822026,
        altitude: 0,
      });

      // Delayed initial steady during an active teleport flight must not interrupt it with a 0ms snap
      fakeNow += 200;
      map.dispatchSteady(true);
      expect(map.flyCalls).toHaveLength(1);

      // While teleport fly-in is active, followCamera does not override it with 0ms calls
      truck.step(1 / 60);
      expect(map.flyCalls).toHaveLength(1);

      // Once the 1200ms flight finishes, followCamera resumes 0ms tracking
      fakeNow += 1100;
      truck.step(1 / 60);
      expect(map.flyCalls).toHaveLength(2);
      expect(map.flyCalls[1]?.durationMillis).toBe(0);
      expect(map.flyCalls[1]?.endCamera.altitudeMode).toBe('ABSOLUTE');
    } finally {
      performance.now = origNow;
    }
  });

  test('accelerates along heading and converges to a drag-limited terminal top speed', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const popup = createFakePopup();

    const northStart = { lat: 37.423501, lng: -122.086744, heading: 0 };
    const truck = new Truck(map.element, model.element, input, popup, 'RELATIVE_TO_GROUND', northStart);
    map.dispatchSteady(true);

    const dt = 1 / 60;
    let prevPos = model.element.position as google.maps.LatLngAltitudeLiteral;
    let lastFrameSpeed = 0;

    // 45 seconds is enough for quadratic drag (ACCEL = v^2 * DRAG_FACTOR + CONSTANT_DRAG -> ~230.9 m/s) to converge
    for (let i = 0; i < 45 * 60; i++) {
      truck.step(dt);
      const curPos = model.element.position as google.maps.LatLngAltitudeLiteral;
      lastFrameSpeed = distanceMeters(prevPos, curPos) / dt;
      prevPos = curPos;
    }

    expect(prevPos.lat).toBeGreaterThan(northStart.lat);
    expect(prevPos.lng).toBeCloseTo(northStart.lng, 6);
    expect(lastFrameSpeed).toBeGreaterThan(225);
    expect(lastFrameSpeed).toBeLessThan(235);
  });

  test('caps reverse speed at MAX_REVERSE_SPEED (40 m/s)', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ reverse: true });
    const popup = createFakePopup();

    const northStart = { lat: 37.423501, lng: -122.086744, heading: 0 };
    const truck = new Truck(map.element, model.element, input, popup, 'RELATIVE_TO_GROUND', northStart);
    map.dispatchSteady(true);

    const dt = 1 / 60;
    let prevPos = model.element.position as google.maps.LatLngAltitudeLiteral;
    let maxObservedSpeed = 0;

    for (let i = 0; i < 15 * 60; i++) {
      truck.step(dt);
      const curPos = model.element.position as google.maps.LatLngAltitudeLiteral;
      const frameSpeed = distanceMeters(prevPos, curPos) / dt;
      if (frameSpeed > maxObservedSpeed) maxObservedSpeed = frameSpeed;
      prevPos = curPos;
    }

    expect(prevPos.lat).toBeLessThan(northStart.lat);
    expect(maxObservedSpeed).toBeGreaterThan(38);
    expect(maxObservedSpeed).toBeLessThan(41.5);
  });

  test('scales steering rate with speed: zero when stopped, faster at moderate speed than high speed', () => {
    // 1. Stationary: holding right without gas does not rotate heading
    const stoppedMap = createFakeMap();
    const stoppedModel = createFakeModel();
    const stoppedTruck = new Truck(
      stoppedMap.element,
      stoppedModel.element,
      createInputState({ right: true }),
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      { ...START, heading: 0 },
    );
    for (let i = 0; i < 60; i++) stoppedTruck.step(1 / 60);
    expect(stoppedModel.orientationWrites).toHaveLength(1);

    // Helper: accelerate straight for warmupSec, then measure heading delta over 0.25s of right steer
    const measureTurnRate = (warmupSec: number) => {
      const map = createFakeMap();
      const model = createFakeModel();
      const input = createInputState({ gas: true });
      const truck = new Truck(
        map.element,
        model.element,
        input,
        createFakePopup(),
        'RELATIVE_TO_GROUND',
        { ...START, heading: 0 },
      );
      for (let i = 0; i < warmupSec * 60; i++) truck.step(1 / 60);
      const before = model.orientationWrites[model.orientationWrites.length - 1]?.heading ?? 0;
      input.right = true;
      for (let i = 0; i < 15; i++) truck.step(1 / 60);
      const after = model.orientationWrites[model.orientationWrites.length - 1]?.heading ?? 0;
      return Math.abs(fixAngle(after - before)) / 0.25;
    };

    const moderateSpeedTurnRate = measureTurnRate(0.5); // ~24 m/s (near SPEED_MAX_TURN = 25)
    const highSpeedTurnRate = measureTurnRate(6.0); // >150 m/s (above SPEED_MIN_TURN = 120)

    expect(moderateSpeedTurnRate).toBeGreaterThan(highSpeedTurnRate);
    expect(highSpeedTurnRate).toBeCloseTo(60, 0);
  });

  test('produces frame-rate-independent distance and heading across 30, 60, and 144 Hz and clamps long frame stalls', () => {
    const runDrive = (fps: number) => {
      const map = createFakeMap();
      const model = createFakeModel();
      const input = createInputState({ gas: true });
      const truck = new Truck(
        map.element,
        model.element,
        input,
        createFakePopup(),
        'RELATIVE_TO_GROUND',
        { ...START, heading: 0 },
      );
      map.dispatchSteady(true);

      const dt = 1 / fps;
      // 2s straight + 1s turning right
      for (let i = 0; i < 2 * fps; i++) truck.step(dt);
      input.right = true;
      for (let i = 0; i < 1 * fps; i++) truck.step(dt);

      return {
        dist: distanceMeters(START, model.element.position as google.maps.LatLngAltitudeLiteral),
        heading: model.orientationWrites[model.orientationWrites.length - 1]?.heading ?? 0,
      };
    };

    const r30 = runDrive(30);
    const r60 = runDrive(60);
    const r144 = runDrive(144);

    expect(Math.abs(r30.dist - r144.dist) / r144.dist).toBeLessThan(0.025);
    expect(Math.abs(r60.dist - r144.dist) / r144.dist).toBeLessThan(0.015);
    expect(Math.abs(fixAngle(r30.heading - r144.heading))).toBeLessThan(2.0);
    expect(Math.abs(fixAngle(r60.heading - r144.heading))).toBeLessThan(1.0);

    // Verify start() clamps a 5s background-tab pause to TICK_MAX_DT (0.25s)
    const origRAF = globalThis.requestAnimationFrame;
    const origNow = performance.now;
    let rafCb: FrameRequestCallback | null = null;
    const nowMs = 1_000;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    }) as typeof requestAnimationFrame;
    performance.now = () => nowMs;

    try {
      const stalledMap = createFakeMap();
      const stalledModel = createFakeModel();
      const stalledTruck = new Truck(
        stalledMap.element,
        stalledModel.element,
        createInputState({ gas: true }),
        createFakePopup(),
        'RELATIVE_TO_GROUND',
        START,
      );
      stalledTruck.start();
      expect(rafCb).not.toBeNull();
      rafCb!(1_000 + 5_000); // 5-second pause
      stalledTruck.stop();

      const clampedMap = createFakeMap();
      const clampedModel = createFakeModel();
      const clampedTruck = new Truck(
        clampedMap.element,
        clampedModel.element,
        createInputState({ gas: true }),
        createFakePopup(),
        'RELATIVE_TO_GROUND',
        START,
      );
      clampedTruck.step(0.25);

      expect(stalledModel.element.position).toEqual(clampedModel.element.position);
    } finally {
      globalThis.requestAnimationFrame = origRAF;
      performance.now = origNow;
    }
  });

  test('respects API write budget: zero writes while stationary on noisy map center, no consecutive duplicate writes while driving', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState();
    const popup = createFakePopup();

    const truck = new Truck(map.element, model.element, input, popup, 'RELATIVE_TO_GROUND', START);
    map.dispatchSteady(true);

    const baseFlyCalls = map.flyCalls.length;
    const basePosWrites = model.positionWrites.length;
    const baseOriWrites = model.orientationWrites.length;

    // 5s stationary (300 frames) with noisy external map.center / range fluctuations
    for (let i = 0; i < 300; i++) {
      map.center = {
        lat: START.lat + (i % 2 === 0 ? 0.00005 : -0.00005),
        lng: START.lng,
        altitude: i % 5 === 0 ? 685 + 18 : 685,
      };
      map.range = i % 5 === 0 ? 41 : 55;
      map.dispatchCenterChange();
      truck.step(1 / 60);
    }

    expect(map.flyCalls).toHaveLength(baseFlyCalls);
    expect(model.positionWrites).toHaveLength(basePosWrites);
    expect(model.orientationWrites).toHaveLength(baseOriWrites);

    // 10s driving + weaving (600 frames): writes bounded by frame count and strictly deduplicated
    input.gas = true;
    for (let i = 0; i < 600; i++) {
      input.left = i >= 120 && i < 240;
      input.right = i >= 300 && i < 420;
      truck.step(1 / 60);
    }

    const drivingFlyCalls = map.flyCalls.slice(baseFlyCalls);
    const drivingPosWrites = model.positionWrites.slice(basePosWrites);
    const drivingOriWrites = model.orientationWrites.slice(baseOriWrites);

    expect(drivingFlyCalls.length).toBeGreaterThan(0);
    expect(drivingFlyCalls.length).toBeLessThanOrEqual(600);
    expect(drivingPosWrites.length).toBeLessThanOrEqual(600);
    expect(drivingOriWrites.length).toBeLessThanOrEqual(600);

    for (let i = 1; i < drivingPosWrites.length; i++) {
      expect(drivingPosWrites[i]).not.toEqual(drivingPosWrites[i - 1]);
    }
    for (let i = 1; i < drivingOriWrites.length; i++) {
      expect(drivingOriWrites[i]).not.toEqual(drivingOriWrites[i - 1]);
    }
    for (let i = 1; i < drivingFlyCalls.length; i++) {
      expect(drivingFlyCalls[i]?.endCamera).not.toEqual(drivingFlyCalls[i - 1]?.endCamera);
    }
  });

  test('smooths camera heading without large per-frame jumps including across the +-180 deg seam', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    // Start nearly due south (175 deg) and steer right across the +180/-180 seam
    const input = createInputState({ gas: true, right: true });
    const truck = new Truck(
      map.element,
      model.element,
      input,
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      { ...START, heading: 175 },
    );
    map.dispatchSteady(true);

    let crossedSeam = false;
    let prevCamHeading = map.flyCalls[map.flyCalls.length - 1]?.endCamera.heading ?? 175;
    let maxStepDeg = 0;

    for (let i = 0; i < 120; i++) {
      truck.step(1 / 60);
      const camHeading = map.flyCalls[map.flyCalls.length - 1]?.endCamera.heading ?? prevCamHeading;
      if (prevCamHeading > 150 && camHeading < -150) {
        crossedSeam = true;
      }
      const shortestDelta = Math.abs(fixAngle(camHeading - prevCamHeading));
      if (shortestDelta > maxStepDeg) maxStepDeg = shortestDelta;
      prevCamHeading = camHeading;
    }

    expect(crossedSeam).toBe(true);
    expect(maxStepDeg).toBeLessThan(3.0);
  });

  test('shows and auto-hides idle and high-speed popups while staying quiet at moderate speed', () => {
    // 1. Idle popup (>10s at speed < 20 m/s, visible for 2s)
    const idlePopup = createFakePopup();
    const idleTruck = new Truck(
      createFakeMap().element,
      createFakeModel().element,
      createInputState(),
      idlePopup,
      'RELATIVE_TO_GROUND',
      START,
    );
    for (let i = 0; i < 9; i++) idleTruck.step(1.0);
    expect(idlePopup.hidden).toBe(true);
    idleTruck.step(1.1);
    expect(idlePopup.hidden).toBe(false);
    expect((idlePopup.textContent ?? '').length).toBeGreaterThan(0);
    idleTruck.step(2.1);
    expect(idlePopup.hidden).toBe(true);

    // 2. Fast popup (>7s above 80 m/s, visible for 2s)
    const fastPopup = createFakePopup();
    const fastInput = createInputState({ gas: true });
    const fastTruck = new Truck(
      createFakeMap().element,
      createFakeModel().element,
      fastInput,
      fastPopup,
      'RELATIVE_TO_GROUND',
      START,
    );
    // Accelerate past 80 m/s (~1.8s = 108 frames), then hold >7s (420 frames)
    for (let i = 0; i < 120; i++) fastTruck.step(1 / 60);
    expect(fastPopup.hidden).toBe(true);
    for (let i = 0; i < 420; i++) fastTruck.step(1 / 60);
    expect(fastPopup.hidden).toBe(false);
    expect((fastPopup.textContent ?? '').length).toBeGreaterThan(0);
    for (let i = 0; i < 130; i++) fastTruck.step(1 / 60);
    expect(fastPopup.hidden).toBe(true);

    // 3. Moderate cruising (~40 m/s reverse, between 20 and 80 m/s) stays quiet
    const cruisePopup = createFakePopup();
    const cruiseTruck = new Truck(
      createFakeMap().element,
      createFakeModel().element,
      createInputState({ reverse: true }),
      cruisePopup,
      'RELATIVE_TO_GROUND',
      START,
    );
    for (let i = 0; i < 20 * 60; i++) cruiseTruck.step(1 / 60);
    expect(cruisePopup.hidden).toBe(true);
  });

  test('banks model.orientation roll into turns within [-30, 30] and settles back to 0 when driving straight', () => {
    // Public Maps JS 3D API reference:
    // https://developers.google.com/maps/documentation/javascript/reference/3d-map#Orientation3DLiteral
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const truck = new Truck(
      map.element,
      model.element,
      input,
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      { ...START, heading: 0 },
    );

    expect(model.orientationWrites[0]).toEqual({ heading: 0, tilt: -90, roll: 0 });

    // Build forward speed, then steer right
    for (let i = 0; i < 60; i++) truck.step(1 / 60);
    input.right = true;
    for (let i = 0; i < 45; i++) truck.step(1 / 60);

    const rightTurnOri = model.orientationWrites[model.orientationWrites.length - 1]!;
    expect(rightTurnOri.tilt).toBe(-90);
    expect(rightTurnOri.roll).toBeLessThan(0);
    expect(rightTurnOri.roll).toBeGreaterThanOrEqual(-30);

    // Stop steering and verify roll spring settles back to 0
    input.right = false;
    for (let i = 0; i < 180; i++) truck.step(1 / 60);
    const settledOri = model.orientationWrites[model.orientationWrites.length - 1]!;
    expect(settledOri.roll).toBeCloseTo(0, 5);
  });
});
