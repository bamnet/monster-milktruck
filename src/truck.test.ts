import { describe, expect, test } from 'bun:test';
import type { InputState } from './input.ts';
import { Truck } from './truck.ts';

interface FakeMap {
  flyCalls: google.maps.maps3d.FlyToAnimationOptions[];
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

  const element = {
    flyCameraTo(options: google.maps.maps3d.FlyToAnimationOptions) {
      flyCalls.push(options);
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as google.maps.maps3d.Map3DElement;

  return {
    flyCalls,
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

describe('Truck', () => {
  test('defers initial camera snap until gmp-steadychange and avoids updates while stationary', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState();
    const popup = createFakePopup();

    const truck = new Truck(
      map.element,
      model.element,
      input,
      popup,
      'RELATIVE_TO_GROUND',
      { lat: 37.423501, lng: -122.086744, heading: 90 },
    );

    expect(model.positionWrites).toHaveLength(1);
    expect(model.orientationWrites).toHaveLength(1);
    expect(map.flyCalls).toHaveLength(0);

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

    // First steady event snaps camera once, then unregisters listener
    map.dispatchSteady(true);
    expect(map.flyCalls).toHaveLength(1);
    expect(map.flyCalls[0]?.durationMillis).toBe(0);
    expect(map.flyCalls[0]?.endCamera.center).toEqual({
      lat: 37.423501,
      lng: -122.086744,
      altitude: 0,
    });

    map.dispatchSteady(true);
    expect(map.flyCalls).toHaveLength(1);
  });

  test('updates model.position without redundantly updating model.orientation when driving straight', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const popup = createFakePopup();

    const truck = new Truck(
      map.element,
      model.element,
      input,
      popup,
      'RELATIVE_TO_GROUND',
      { lat: 37.423501, lng: -122.086744, heading: 90 },
    );

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

  test('gates overlapping flyCameraTo(0) calls until in-flight update settles', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const popup = createFakePopup();

    const truck = new Truck(
      map.element,
      model.element,
      input,
      popup,
      'RELATIVE_TO_GROUND',
      { lat: 37.423501, lng: -122.086744, heading: 90 },
    );

    // Frame 1 starts an in-flight camera update
    truck.step(1 / 60);
    expect(map.flyCalls).toHaveLength(1);

    // Frame 2 occurs immediately before gmp-centerchange / gmp-animationend fires:
    // model position updates, but overlapping flyCameraTo(0) is held back
    truck.step(1 / 60);
    expect(model.positionWrites).toHaveLength(3);
    expect(map.flyCalls).toHaveLength(1);

    // Once the map signals the previous camera update settled, the next frame updates immediately
    map.dispatchCenterChange();
    truck.step(1 / 60);
    expect(map.flyCalls).toHaveLength(2);
  });

  test('clamps residual velocity, roll, and camera lag to zero after coming to rest', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true, right: true });
    const popup = createFakePopup();

    const truck = new Truck(
      map.element,
      model.element,
      input,
      popup,
      'RELATIVE_TO_GROUND',
      { lat: 37.423501, lng: -122.086744, heading: 90 },
    );

    // Accelerate and turn briefly
    for (let i = 0; i < 5; i++) {
      truck.step(1 / 60);
      map.dispatchCenterChange();
    }

    // Release all inputs and let truck coast to a stop
    input.gas = false;
    input.right = false;
    for (let i = 0; i < 300; i++) {
      truck.step(1 / 60);
      map.dispatchCenterChange();
    }

    const posWritesAfterStop = model.positionWrites.length;
    const oriWritesAfterStop = model.orientationWrites.length;
    const flyCallsAfterStop = map.flyCalls.length;

    // Additional frames once stopped should be completely idle
    for (let i = 0; i < 30; i++) {
      truck.step(1 / 60);
      map.dispatchCenterChange();
    }

    expect(model.positionWrites).toHaveLength(posWritesAfterStop);
    expect(model.orientationWrites).toHaveLength(oriWritesAfterStop);
    expect(map.flyCalls).toHaveLength(flyCallsAfterStop);
  });

  test('teleportTo flies camera over 1200ms and suppresses followCamera during flight', () => {
    const map = createFakeMap();
    const model = createFakeModel();
    const input = createInputState({ gas: true });
    const popup = createFakePopup();

    const truck = new Truck(
      map.element,
      model.element,
      input,
      popup,
      'RELATIVE_TO_GROUND',
      { lat: 37.423501, lng: -122.086744, heading: 90 },
    );

    truck.teleportTo(35.668607, 139.822026, 180);
    expect(map.flyCalls).toHaveLength(1);
    expect(map.flyCalls[0]?.durationMillis).toBe(1200);
    expect(map.flyCalls[0]?.endCamera.center).toEqual({
      lat: 35.668607,
      lng: 139.822026,
      altitude: 0,
    });

    // While teleport fly-in is active, followCamera does not override it with 0ms calls
    truck.step(1 / 60);
    expect(map.flyCalls).toHaveLength(1);
  });
});
