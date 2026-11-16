import { describe, expect, test } from 'bun:test';
import type { InputState } from './input.ts';
import { degToRad, fixAngle, horizontalDistanceM, offsetToLatLng } from './math3d.ts';
import { Truck } from './truck.ts';

interface FakeMap {
  flyCalls: google.maps.maps3d.FlyToAnimationOptions[];
  center: google.maps.LatLngAltitudeLiteral;
  cameraPosition: { lat: number; lng: number; altitude: number } | null;
  heading: number | null;
  tilt: number | null;
  range: number;
  activeListeners: Map<string, Set<EventListenerOrEventListenerObject>>;
  onFly?: (options: google.maps.maps3d.FlyToAnimationOptions) => void;
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

/**
 * Simulates Google Maps 3D `LatLngAltitude` whose lat/lng/altitude are prototype
 * getters (non-enumerable own properties) rather than plain object fields.
 */
class FakeLatLngAltitude {
  constructor(
    private readonly _lat: number,
    private readonly _lng: number,
    private readonly _altitude: number,
  ) {}
  get lat(): number {
    return this._lat;
  }
  get lng(): number {
    return this._lng;
  }
  get altitude(): number {
    return this._altitude;
  }
}

function makeSyntheticEye(
  target: { lat: number; lng: number },
  groundAltM: number,
  headingDeg: number,
  tiltDeg = 72,
  rangeM = 55,
): FakeLatLngAltitude {
  const horizRange = rangeM * Math.sin(degToRad(tiltDeg));
  const hRad = degToRad(headingDeg);
  const eye = offsetToLatLng(
    target.lat,
    target.lng,
    -horizRange * Math.sin(hRad),
    -horizRange * Math.cos(hRad),
  );
  return new FakeLatLngAltitude(
    eye.lat,
    eye.lng,
    groundAltM + rangeM * Math.cos(degToRad(tiltDeg)),
  );
}

function createFakeMap(): FakeMap {
  const target = new EventTarget();
  const flyCalls: google.maps.maps3d.FlyToAnimationOptions[] = [];
  const activeListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const state: {
    center: google.maps.LatLngAltitudeLiteral;
    cameraPosition: { lat: number; lng: number; altitude: number } | null;
    heading: number | null;
    tilt: number | null;
    range: number;
    onFly?: (options: google.maps.maps3d.FlyToAnimationOptions) => void;
  } = {
    center: { lat: 0, lng: 0, altitude: 0 },
    cameraPosition: null,
    heading: null,
    tilt: null,
    range: 55,
  };

  const element = {
    get center() {
      return state.center;
    },
    set center(val: google.maps.LatLngAltitudeLiteral) {
      state.center = val;
    },
    get cameraPosition() {
      return state.cameraPosition;
    },
    set cameraPosition(val: { lat: number; lng: number; altitude: number } | null) {
      state.cameraPosition = val;
    },
    get heading() {
      return state.heading;
    },
    set heading(val: number | null) {
      state.heading = val;
    },
    get tilt() {
      return state.tilt;
    },
    set tilt(val: number | null) {
      state.tilt = val;
    },
    get range() {
      return state.range;
    },
    set range(val: number) {
      state.range = val;
    },
    flyCameraTo(options: google.maps.maps3d.FlyToAnimationOptions) {
      flyCalls.push(options);
      state.onFly?.(options);
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener) {
        let set = activeListeners.get(type);
        if (!set) {
          set = new Set();
          activeListeners.set(type, set);
        }
        set.add(listener);
      }
      target.addEventListener(type, listener, options);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (listener) {
        activeListeners.get(type)?.delete(listener);
      }
      target.removeEventListener(type, listener, options);
    },
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as google.maps.maps3d.Map3DElement;

  return {
    flyCalls,
    activeListeners,
    get center() {
      return state.center;
    },
    set center(val: google.maps.LatLngAltitudeLiteral) {
      state.center = val;
    },
    get cameraPosition() {
      return state.cameraPosition;
    },
    set cameraPosition(val: { lat: number; lng: number; altitude: number } | null) {
      state.cameraPosition = val;
    },
    get heading() {
      return state.heading;
    },
    set heading(val: number | null) {
      state.heading = val;
    },
    get tilt() {
      return state.tilt;
    },
    set tilt(val: number | null) {
      state.tilt = val;
    },
    get range() {
      return state.range;
    },
    set range(val: number) {
      state.range = val;
    },
    get onFly() {
      return state.onFly;
    },
    set onFly(fn: ((options: google.maps.maps3d.FlyToAnimationOptions) => void) | undefined) {
      state.onFly = fn;
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
  return horizontalDistanceM(a, b);
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

    expect(model.orientationWrites[0]).toEqual({ heading: 0, tilt: 0, roll: 0 });

    // Build forward speed, then steer right
    for (let i = 0; i < 60; i++) truck.step(1 / 60);
    input.right = true;
    for (let i = 0; i < 45; i++) truck.step(1 / 60);

    const rightTurnOri = model.orientationWrites[model.orientationWrites.length - 1]!;
    expect(rightTurnOri.tilt).toBe(0);
    expect(rightTurnOri.roll).toBeLessThan(0);
    expect(rightTurnOri.roll).toBeGreaterThanOrEqual(-30);

    // Stop steering and verify roll spring settles back to 0
    input.right = false;
    for (let i = 0; i < 180; i++) truck.step(1 / 60);
    const settledOri = model.orientationWrites[model.orientationWrites.length - 1]!;
    expect(settledOri.roll).toBeCloseTo(0, 5);
  });

  test('preserves camera tracking contract unchanged: tilt=72, range=55, altitude=0, and 100% moving-frame flyCameraTo cadence post-steady', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const truck = new Truck(
      map.element,
      model.element,
      input,
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      START,
    );

    map.dispatchSteady(true);
    expect(map.flyCalls).toHaveLength(1);
    expect(map.flyCalls[0]?.endCamera.tilt).toBe(72);
    expect(map.flyCalls[0]?.endCamera.range).toBe(55);
    expect(map.flyCalls[0]?.endCamera.altitudeMode).toBe('RELATIVE_TO_GROUND');
    expect(map.flyCalls[0]?.endCamera.center?.altitude).toBe(0);

    const movingFrames = 300;
    const baseFly = map.flyCalls.length;
    for (let i = 0; i < movingFrames; i++) {
      // Deliberately do NOT dispatch gmp-centerchange / gmp-animationend to prove zero post-steady throttling
      truck.step(1 / 60);
    }

    expect(map.flyCalls.length - baseFly).toBe(movingFrames);
    for (const call of map.flyCalls.slice(baseFly)) {
      expect(call.durationMillis).toBe(0);
      expect(call.endCamera.tilt).toBe(72);
      expect(call.endCamera.range).toBe(55);
      expect(call.endCamera.altitudeMode).toBe('RELATIVE_TO_GROUND');
      expect(call.endCamera.center?.altitude).toBe(0);
    }
    for (const pos of model.positionWrites) {
      expect(pos.altitude).toBe(0);
    }
  });

  test('tilts smoothly nose-up uphill, nose-down downhill, and stays nose-up reversing on synthetic terrain', () => {
    const northStart = { lat: 50.085734, lng: -122.855824, heading: 0 };
    const slope15 = Math.tan(degToRad(15));

    const wireSyntheticTerrain = (
      map: FakeMap,
      groundFn: (pos: { lat: number; lng: number }) => number,
    ) => {
      map.onFly = (opts) => {
        const c = opts.endCamera.center;
        if (!c) return;
        const heading = opts.endCamera.heading ?? 0;
        const tilt = opts.endCamera.tilt ?? 72;
        const range = opts.endCamera.range ?? 55;
        map.heading = heading;
        map.tilt = tilt;
        map.cameraPosition = makeSyntheticEye(c, groundFn(c), heading, tilt, range);
      };
    };

    const northMetersFrom = (pos: { lat: number; lng: number }) =>
      degToRad(pos.lat - northStart.lat) * 6378137;

    // 1. Uphill climb (+15° going North): tilt converges near -15°
    const upMap = createFakeMap();
    const upModel = createFakeModel();
    const upInput = createInputState({ gas: true });
    wireSyntheticTerrain(upMap, (p) => 1000 + northMetersFrom(p) * slope15);
    const upTruck = new Truck(
      upMap.element,
      upModel.element,
      upInput,
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      northStart,
    );
    upMap.dispatchSteady(true);

    for (let i = 0; i < 180; i++) upTruck.step(1 / 60);
    const upOri = upModel.orientationWrites[upModel.orientationWrites.length - 1]!;
    expect(upOri.tilt).toBeLessThan(-14);
    expect(upOri.tilt).toBeGreaterThan(-16);
    expect(upTruck.getPitchDeg()).toBeCloseTo(upOri.tilt ?? 0, 1);

    // 2. Downhill descent (-15° going North): tilt converges near +15°
    const downMap = createFakeMap();
    const downModel = createFakeModel();
    const downInput = createInputState({ gas: true });
    wireSyntheticTerrain(downMap, (p) => 1000 - northMetersFrom(p) * slope15);
    const downTruck = new Truck(
      downMap.element,
      downModel.element,
      downInput,
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      northStart,
    );
    downMap.dispatchSteady(true);

    for (let i = 0; i < 180; i++) downTruck.step(1 / 60);
    const downOri = downModel.orientationWrites[downModel.orientationWrites.length - 1]!;
    expect(downOri.tilt).toBeGreaterThan(14);
    expect(downOri.tilt).toBeLessThan(16);

    // 3. Reversing down an uphill slope (facing North uphill, backing South): nose stays UP (< 0)
    const revMap = createFakeMap();
    const revModel = createFakeModel();
    const revInput = createInputState({ reverse: true });
    wireSyntheticTerrain(revMap, (p) => 1000 + northMetersFrom(p) * slope15);
    const revTruck = new Truck(
      revMap.element,
      revModel.element,
      revInput,
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      northStart,
    );
    revMap.dispatchSteady(true);

    for (let i = 0; i < 180; i++) revTruck.step(1 / 60);
    const revOri = revModel.orientationWrites[revModel.orientationWrites.length - 1]!;
    expect(revOri.tilt).toBeLessThan(-14);
    expect(revOri.tilt).toBeGreaterThan(-16);
  });

  test('post-teleport settling waits for gmp-animationend and avoids fake pitch spike on flat urban terrain', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState();

    let fakeNow = 10_000;
    const origNow = performance.now;
    performance.now = () => fakeNow;
    try {
      const truck = new Truck(
        map.element,
        model.element,
        input,
        createFakePopup(),
        'RELATIVE_TO_GROUND',
        START,
      );
      map.dispatchSteady(true);

      const sf = { lat: 37.7749, lng: -122.4194, heading: 0 };
      truck.teleportTo(sf.lat, sf.lng, sf.heading);
      expect(truck.getPitchDeg()).toBe(0);

      // Even past 1200ms wall-clock, while teleport animation has not yet ended
      // (gmp-animationend not yet fired), settling camera altitude must not lock pitch.
      fakeNow += 1300;
      map.heading = sf.heading;
      map.tilt = 68;
      map.cameraPosition = makeSyntheticEye(sf, 32, sf.heading, 68);
      truck.step(1 / 60);
      expect(truck.getPitchDeg()).toBe(0);

      // Animation ends; camera locks and tiles refine down from 22 m -> 17 m while stationary
      map.dispatchAnimationEnd();
      map.tilt = 72;
      for (const alt of [22.0, 20.5, 19.0, 17.8, 17.0, 17.0]) {
        fakeNow += 16.67;
        map.cameraPosition = makeSyntheticEye(sf, alt, sf.heading, 72);
        truck.step(1 / 60);
        expect(truck.getPitchDeg()).toBe(0);
      }

      // Now drive on flat 17.0 m terrain: pitch must stay < 1° (exact 0°)
      input.gas = true;
      map.onFly = (opts) => {
        const c = opts.endCamera.center;
        if (!c) return;
        map.heading = opts.endCamera.heading ?? 0;
        map.tilt = opts.endCamera.tilt ?? 72;
        map.cameraPosition = makeSyntheticEye(c, 17.0, map.heading, map.tilt, 55);
      };

      let maxAbsTilt = 0;
      for (let i = 0; i < 120; i++) {
        fakeNow += 16.67;
        truck.step(1 / 60);
        const ori = model.orientationWrites[model.orientationWrites.length - 1]!;
        maxAbsTilt = Math.max(maxAbsTilt, Math.abs(ori.tilt ?? 0));
      }
      expect(maxAbsTilt).toBeLessThan(1.0);
      expect(maxAbsTilt).toBe(0);
    } finally {
      performance.now = origNow;
    }
  });

  test('keeps tilt strictly 0 in fixedAltitude (ABSOLUTE) mode even when cameraPosition climbs steep terrain', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const northStart = { lat: 50.085734, lng: -122.855824, heading: 0 };
    const slope15 = Math.tan(degToRad(15));

    map.onFly = (opts) => {
      const c = opts.endCamera.center;
      if (!c) return;
      const dN = degToRad(c.lat - northStart.lat) * 6378137;
      map.heading = opts.endCamera.heading ?? 0;
      map.tilt = opts.endCamera.tilt ?? 72;
      map.cameraPosition = makeSyntheticEye(c, 1000 + dN * slope15, map.heading, map.tilt, 55);
    };

    const truck = new Truck(
      map.element,
      model.element,
      input,
      createFakePopup(),
      'ABSOLUTE',
      northStart,
    );
    map.dispatchSteady(true);

    for (let i = 0; i < 180; i++) {
      truck.step(1 / 60);
    }

    expect(truck.getPitchDeg()).toBe(0);
    for (const ori of model.orientationWrites) {
      expect(ori.tilt).toBe(0);
    }
    expect(model.orientationWrites).toHaveLength(1);
    for (const call of map.flyCalls) {
      expect(call.endCamera.altitudeMode).toBe('ABSOLUTE');
    }
  });

  test('produces frame-rate-independent steering roll across 30/60/144 Hz and survives 0.25s hitches without instability', () => {
    const runRollProfile = (schedule: number[]) => {
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

      let elapsed = 0;
      let peakAbsRoll = 0;
      let rollAfterTurn = 0;
      let recordedTurn = false;
      for (const dt of schedule) {
        input.right = elapsed >= 1.0 && elapsed < 2.0;
        truck.step(dt);
        elapsed += dt;
        const curRoll = model.orientationWrites[model.orientationWrites.length - 1]?.roll ?? 0;
        peakAbsRoll = Math.max(peakAbsRoll, Math.abs(curRoll));
        if (!recordedTurn && elapsed >= 1.99) {
          rollAfterTurn = curRoll;
          recordedTurn = true;
        }
      }
      const finalRoll = model.orientationWrites[model.orientationWrites.length - 1]?.roll ?? 0;
      return { peakAbsRoll, rollAfterTurn, finalRoll };
    };

    const makeConst = (fps: number, sec: number) =>
      Array.from({ length: Math.round(fps * sec) }, () => 1 / fps);

    // 4.5s total: 1s straight, 1s turning right, 2.5s straight settle
    const r30 = runRollProfile(makeConst(30, 4.5));
    const r60 = runRollProfile(makeConst(60, 4.5));
    const r144 = runRollProfile(makeConst(144, 4.5));

    // Schedule with repeated 0.25s frame stalls during turning and settling
    const hitchSchedule: number[] = [];
    let t = 0;
    let idx = 0;
    while (t < 4.5 - 1e-6) {
      const rawDt = idx % 8 === 3 ? 0.25 : 1 / 60;
      const dt = Math.min(rawDt, 4.5 - t);
      hitchSchedule.push(dt);
      t += dt;
      idx++;
    }
    const rHitch = runRollProfile(hitchSchedule);

    expect(r60.rollAfterTurn).toBeLessThan(-1);
    expect(Math.abs(r30.rollAfterTurn - r144.rollAfterTurn)).toBeLessThan(0.4);
    expect(Math.abs(r60.rollAfterTurn - r144.rollAfterTurn)).toBeLessThan(0.25);
    expect(rHitch.peakAbsRoll).toBeLessThanOrEqual(30);
    expect(Math.abs(rHitch.rollAfterTurn - r60.rollAfterTurn)).toBeLessThan(1.0);
    expect(r30.finalRoll).toBe(0);
    expect(r60.finalRoll).toBe(0);
    expect(r144.finalRoll).toBe(0);
    expect(rHitch.finalRoll).toBe(0);
  });

  test('stop() detaches map event listeners and start() clamps negative rAF timestamps to dt=0', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    let readyCalls = 0;
    const truck = new Truck(
      map.element,
      model.element,
      input,
      createFakePopup(),
      'RELATIVE_TO_GROUND',
      START,
      () => {
        readyCalls++;
      },
    );

    expect(map.activeListeners.get('gmp-centerchange')?.size).toBe(1);
    expect(map.activeListeners.get('gmp-animationend')?.size).toBe(1);
    expect(map.activeListeners.get('gmp-steadychange')?.size).toBe(1);

    // Negative first-frame rAF timestamp must not move the truck backwards
    const origRAF = globalThis.requestAnimationFrame;
    const origNow = performance.now;
    let rafCb: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 42;
    }) as typeof requestAnimationFrame;
    performance.now = () => 2_000;

    try {
      truck.start();
      const posBefore = model.element.position;
      rafCb!(1_950); // t < lastTime (-50 ms)
      expect(model.element.position).toEqual(posBefore);

      truck.stop();
    } finally {
      globalThis.requestAnimationFrame = origRAF;
      performance.now = origNow;
    }

    expect(map.activeListeners.get('gmp-centerchange')?.size ?? 0).toBe(0);
    expect(map.activeListeners.get('gmp-animationend')?.size ?? 0).toBe(0);
    expect(map.activeListeners.get('gmp-steadychange')?.size ?? 0).toBe(0);

    // Dispatching steady after stop() must not trigger onReady or flyCameraTo
    map.dispatchSteady(true);
    expect(readyCalls).toBe(0);
    expect(map.flyCalls).toHaveLength(0);
  });
});
