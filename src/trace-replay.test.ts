import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InputState } from './input.ts';
import { fixAngle } from './math3d.ts';
import type { TerrainTrace } from './trace-types.ts';
import { Truck } from './truck.ts';

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
