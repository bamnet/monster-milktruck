import { describe, expect, test } from 'bun:test';
import { degToRad, horizontalDistanceM, offsetToLatLng } from './math3d.ts';
import {
  TerrainPitchTracker,
  extractGroundAltitude,
  eyeToTargetLatLng,
} from './terrain-pitch.ts';

const ORIGIN = { lat: 50.085734, lng: -122.855824 };
const CAM_TILT = 72;
const CAM_RANGE = 55;

/**
 * Builds the exact Maps 3D camera eye position (`cameraPosition`) for a chase
 * camera looking at `target` at elevation `groundAltM`.
 */
function makeCameraEye(
  target: { lat: number; lng: number },
  groundAltM: number,
  headingDeg: number,
  tiltDeg = CAM_TILT,
  rangeM = CAM_RANGE,
): { lat: number; lng: number; altitude: number } {
  const horizRange = rangeM * Math.sin(degToRad(tiltDeg));
  const hRad = degToRad(headingDeg);
  // Camera eye sits behind the target (opposite of look heading)
  const eyeLatLng = offsetToLatLng(
    target.lat,
    target.lng,
    -horizRange * Math.sin(hRad),
    -horizRange * Math.cos(hRad),
  );
  const eyeAlt = groundAltM + rangeM * Math.cos(degToRad(tiltDeg));
  return { lat: eyeLatLng.lat, lng: eyeLatLng.lng, altitude: eyeAlt };
}

describe('terrain-pitch geometry helpers', () => {
  test('extractGroundAltitude recovers exact ground elevation at sea level and mountain altitudes', () => {
    const eyeHeightAt72 = CAM_RANGE * Math.cos(degToRad(CAM_TILT));
    expect(extractGroundAltitude(eyeHeightAt72, CAM_RANGE, CAM_TILT)).toBeCloseTo(0, 6);
    expect(extractGroundAltitude(2317.4 + eyeHeightAt72, CAM_RANGE, CAM_TILT)).toBeCloseTo(
      2317.4,
      6,
    );
    // Straight-down camera (tilt = 0): eye is directly `range` above ground
    expect(extractGroundAltitude(155, 55, 0)).toBeCloseTo(100, 6);
  });

  test('eyeToTargetLatLng recovers target coordinates for arbitrary headings and tilts', () => {
    for (const heading of [0, 45, 90, 180, -135, 220]) {
      const eye = makeCameraEye(ORIGIN, 500, heading, CAM_TILT, CAM_RANGE);
      const recovered = eyeToTargetLatLng(eye, heading, CAM_TILT, CAM_RANGE);
      expect(horizontalDistanceM(ORIGIN, recovered)).toBeLessThan(0.01);
    }
  });
});

describe('TerrainPitchTracker', () => {
  test('stays strictly 0 on a flat road at both sea level and high mountain altitude', () => {
    for (const baseAlt of [0, 2300]) {
      const tracker = new TerrainPitchTracker();
      const dt = 1 / 60;
      const speed = 40;
      const heading = 90;
      let dist = 0;

      for (let i = 0; i < 180; i++) {
        const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, dist, 0);
        const camPos = makeCameraEye(pos, baseAlt, heading);
        const pitch = tracker.update({
          dt,
          truckPos: pos,
          headingDeg: heading,
          speedMps: speed,
          sceneReady: true,
          teleporting: false,
          cameraPosition: camPos,
          cameraHeadingDeg: heading,
          liveTiltDeg: CAM_TILT,
          targetRangeM: CAM_RANGE,
          targetTiltDeg: CAM_TILT,
        });
        expect(pitch).toBe(0);
        dist += speed * dt;
      }
    }
  });

  test('pitches nose UP (< 0) on a +15° uphill ramp and nose DOWN (> 0) on a -15° downhill ramp', () => {
    const dt = 1 / 60;
    const speed = 30;
    const heading = 0;
    const slope15 = Math.tan(degToRad(15));

    // Uphill (+15° going north) -> tilt < 0 (-15°)
    const uphill = new TerrainPitchTracker();
    let maxUpRate = 0;
    let prevPitch = 0;
    for (let i = 0; i < 240; i++) {
      const dist = i * speed * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      const groundAlt = 100 + dist * slope15;
      const pitch = uphill.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAlt, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      maxUpRate = Math.max(maxUpRate, Math.abs(pitch - prevPitch) / dt);
      prevPitch = pitch;
    }
    expect(uphill.pitchDeg).toBeCloseTo(-15, 0);
    expect(uphill.pitchDeg).toBeLessThan(-14.5);
    expect(uphill.pitchDeg).toBeGreaterThan(-15.5);
    expect(maxUpRate).toBeLessThanOrEqual(75.01);

    // Downhill (-15° going north) -> tilt > 0 (+15°)
    const downhill = new TerrainPitchTracker();
    for (let i = 0; i < 240; i++) {
      const dist = i * speed * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      const groundAlt = 500 - dist * slope15;
      downhill.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAlt, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
    }
    expect(downhill.pitchDeg).toBeCloseTo(15, 0);
    expect(downhill.pitchDeg).toBeGreaterThan(14.5);
    expect(downhill.pitchDeg).toBeLessThan(15.5);
  });

  test('keeps nose pitched UP when reversing down an uphill slope (both from rest and after climbing)', () => {
    const dt = 1 / 60;
    const heading = 0; // Truck nose faces North (uphill)
    const slope15 = Math.tan(degToRad(15));
    const groundAtNorth = (northM: number) => 500 + northM * slope15;

    // 1. Reversing from rest (backing South while facing North uphill)
    const revFromRest = new TerrainPitchTracker();
    const revSpeed = 20;
    for (let i = 0; i < 240; i++) {
      const northM = -i * revSpeed * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, northM);
      revFromRest.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: revSpeed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAtNorth(northM), heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
    }
    expect(revFromRest.pitchDeg).toBeLessThan(-14.5);
    expect(revFromRest.pitchDeg).toBeGreaterThan(-15.5);

    // 2. Drive forward up the hill, then reverse back down without nose dipping downhill
    const fwdThenRev = new TerrainPitchTracker();
    let northM = 0;
    for (let i = 0; i < 180; i++) {
      northM += 25 * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, northM);
      fwdThenRev.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: 25,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAtNorth(northM), heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
    }
    expect(fwdThenRev.pitchDeg).toBeLessThan(-14.5);

    for (let i = 0; i < 180; i++) {
      northM -= 20 * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, northM);
      const pitch = fwdThenRev.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: 20,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAtNorth(northM), heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      // Nose must remain steadily pitched UP throughout the direction reversal
      expect(pitch).toBeLessThan(-13);
    }
    expect(fwdThenRev.pitchDeg).toBeLessThan(-14.5);
    expect(fwdThenRev.pitchDeg).toBeGreaterThan(-15.5);
  });

  test('clamps extreme cliff slopes to [-35°, 35°]', () => {
    const tracker = new TerrainPitchTracker();
    const dt = 1 / 60;
    const speed = 20;
    const heading = 0;
    const extremeSlope = 1.8; // ~61°

    for (let i = 0; i < 240; i++) {
      const dist = i * speed * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      const pitch = tracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, 100 + dist * extremeSlope, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      expect(pitch).toBeGreaterThanOrEqual(-35);
      expect(pitch).toBeLessThanOrEqual(35);
    }
    expect(tracker.pitchDeg).toBeLessThan(-34);
    expect(tracker.pitchDeg).toBeGreaterThanOrEqual(-35);
  });

  test('tracks rolling hills smoothly at both 20 m/s and 200 m/s within angular rate cap', () => {
    for (const speed of [20, 200]) {
      const tracker = new TerrainPitchTracker();
      const dt = 1 / 60;
      const heading = 90;
      const wavelength = 400; // meters
      const amplitude = 25; // max slope = 2π * 25 / 400 ≈ 0.393 (~21.4°)

      let minPitch = Infinity;
      let maxPitch = -Infinity;
      let maxRate = 0;
      let prevPitch = 0;
      const totalDist = wavelength * 1.5;
      const frames = Math.ceil(totalDist / (speed * dt));

      for (let i = 0; i < frames; i++) {
        const dist = i * speed * dt;
        const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, dist, 0);
        const groundAlt = 300 + amplitude * Math.sin((2 * Math.PI * dist) / wavelength);
        const pitch = tracker.update({
          dt,
          truckPos: pos,
          headingDeg: heading,
          speedMps: speed,
          sceneReady: true,
          teleporting: false,
          cameraPosition: makeCameraEye(pos, groundAlt, heading),
          cameraHeadingDeg: heading,
          liveTiltDeg: CAM_TILT,
          targetRangeM: CAM_RANGE,
          targetTiltDeg: CAM_TILT,
        });
        minPitch = Math.min(minPitch, pitch);
        maxPitch = Math.max(maxPitch, pitch);
        maxRate = Math.max(maxRate, Math.abs(pitch - prevPitch) / dt);
        prevPitch = pitch;
      }

      // Should cleanly pitch both nose-up and nose-down over the rolling wave
      expect(minPitch).toBeLessThan(-10);
      expect(maxPitch).toBeGreaterThan(10);
      expect(minPitch).toBeGreaterThanOrEqual(-35);
      expect(maxPitch).toBeLessThanOrEqual(35);
      expect(maxRate).toBeLessThanOrEqual(75.01);
    }
  });

  test('rejects 100 m single-frame outliers and damps 1.5 m DTM seams without wild spikes', () => {
    const dt = 1 / 60;
    const speed = 30;
    const heading = 0;

    // 1. Single-frame 100 m outlier on flat terrain -> zero pitch disturbance
    const outlierTracker = new TerrainPitchTracker();
    let maxOutlierPitch = 0;
    for (let i = 0; i < 120; i++) {
      const dist = i * speed * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      const groundAlt = i === 60 ? 200 : 100; // +100 m single-frame glitch
      const pitch = outlierTracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAlt, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      maxOutlierPitch = Math.max(maxOutlierPitch, Math.abs(pitch));
    }
    expect(maxOutlierPitch).toBe(0);

    // 2. 1.5 m DTM tile seam at 100 m/s -> gentle bounded bump, returns cleanly to 0°
    const seamTracker = new TerrainPitchTracker();
    const fastSpeed = 100;
    let maxSeamPitch = 0;
    for (let i = 0; i < 240; i++) {
      const dist = i * fastSpeed * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      const groundAlt = dist >= 100 ? 101.5 : 100.0;
      const pitch = seamTracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: fastSpeed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAlt, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      maxSeamPitch = Math.max(maxSeamPitch, Math.abs(pitch));
    }
    expect(maxSeamPitch).toBeLessThan(6);
    expect(seamTracker.pitchDeg).toBe(0);
  });

  test('refreshes sole anchor in-place during post-teleport stationary settling (no fake nose-down spike)', () => {
    const tracker = new TerrainPitchTracker();
    const dt = 1 / 60;
    const heading = 0;

    // Teleport finishes; camera locks at an elevated settling altitude (24 m) while
    // terrain tiles finish refining down to 17 m over 20 stationary frames.
    const settleAlts = [24.0, 22.8, 21.5, 20.1, 19.0, 18.2, 17.5, 17.1, 17.0, 17.0];
    for (const alt of settleAlts) {
      const pitch = tracker.update({
        dt,
        truckPos: ORIGIN,
        headingDeg: heading,
        speedMps: 0,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(ORIGIN, alt, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      expect(pitch).toBe(0);
    }

    // Now drive forward on flat 17.0 m urban terrain: max |pitchDeg| must stay < 1° (exact 0°)
    let maxPitch = 0;
    const speed = 25;
    for (let i = 1; i <= 120; i++) {
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, i * speed * dt);
      const pitch = tracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, 17.0, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      maxPitch = Math.max(maxPitch, Math.abs(pitch));
    }
    expect(maxPitch).toBeLessThan(1.0);
    expect(maxPitch).toBe(0);
  });

  test('rejects 0 m startup glitches while accepting real sea-level (~17 m) camera eyes', () => {
    const tracker = new TerrainPitchTracker();
    const dt = 1 / 60;
    const heading = 0;
    const slope15 = Math.tan(degToRad(15));

    // Uninitialized 0 m cameraPosition frames must be ignored (must not lock at -17 m ground)
    for (let i = 0; i < 10; i++) {
      const pitch = tracker.update({
        dt,
        truckPos: ORIGIN,
        headingDeg: heading,
        speedMps: 0,
        sceneReady: true,
        teleporting: false,
        cameraPosition: { lat: ORIGIN.lat, lng: ORIGIN.lng, altitude: 0 },
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      expect(pitch).toBe(0);
    }

    // Real sea-level driving (ground = 0 m -> eye ~17.0 m) climbing a 15° coastal ramp
    const speed = 25;
    for (let i = 0; i < 180; i++) {
      const dist = i * speed * dt;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      const groundAlt = dist * slope15; // starts at exact 0 m sea level!
      tracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, groundAlt, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
    }
    expect(tracker.pitchDeg).toBeLessThan(-14.5);
    expect(tracker.pitchDeg).toBeGreaterThan(-15.5);
  });

  test('rejects samples with |liveTilt - 72| > 1° or eye-target offset >= 15 m', () => {
    const tracker = new TerrainPitchTracker();
    const dt = 1 / 60;
    const heading = 0;

    // Mid-flight liveTilt = 69° (3° error) must not lock even with steep bogus groundAlt
    for (let i = 0; i < 30; i++) {
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, i * 1.0);
      const pitch = tracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: 20,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, 100 + i * 5, heading, 69),
        cameraHeadingDeg: heading,
        liveTiltDeg: 69,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      expect(pitch).toBe(0);
    }

    // Stale camera eye displaced 25 m behind truck must also be rejected
    for (let i = 0; i < 30; i++) {
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, i * 1.0);
      const staleTarget = offsetToLatLng(pos.lat, pos.lng, 0, -25);
      const pitch = tracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: 20,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(staleTarget, 100 + i * 5, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      expect(pitch).toBe(0);
    }
  });

  test('re-locks and relaxes smoothly to 0° when switching from mountain SATELLITE to flat ROADMAP', () => {
    const tracker = new TerrainPitchTracker();
    const dt = 1 / 60;
    const speed = 30;
    const heading = 0;
    const slope15 = Math.tan(degToRad(15));

    // Climb Whistler at 2300 m until pitched to -15°
    let dist = 0;
    for (let i = 0; i < 180; i++) {
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      tracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, 2300 + dist * slope15, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      dist += speed * dt;
    }
    expect(tracker.pitchDeg).toBeLessThan(-14.5);

    // Switch to MapMode.ROADMAP: bare-earth plane collapses to flat 0 m (eye ~17 m)
    let maxRate = 0;
    let prevPitch = tracker.pitchDeg;
    for (let i = 0; i < 180; i++) {
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      const pitch = tracker.update({
        dt,
        truckPos: pos,
        headingDeg: heading,
        speedMps: speed,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, 0, heading),
        cameraHeadingDeg: heading,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
      maxRate = Math.max(maxRate, Math.abs(pitch - prevPitch) / dt);
      prevPitch = pitch;
      dist += speed * dt;
    }

    expect(tracker.pitchDeg).toBe(0);
    expect(maxRate).toBeLessThanOrEqual(75.01);
  });

  test('is invariant across 15, 30, 60, 120 Hz and variable-dt frame hitches', () => {
    const heading = 0;
    const speed = 40;
    const durationS = 4.0;
    const wavelength = 240;
    const amplitude = 16;

    const runWithStepSchedule = (dts: number[]) => {
      const tracker = new TerrainPitchTracker();
      let t = 0;
      const samples: Array<{ t: number; pitch: number }> = [];
      for (const dt of dts) {
        const dist = t * speed;
        const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
        const groundAlt = 400 + amplitude * Math.sin((2 * Math.PI * dist) / wavelength);
        const pitch = tracker.update({
          dt,
          truckPos: pos,
          headingDeg: heading,
          speedMps: speed,
          sceneReady: true,
          teleporting: false,
          cameraPosition: makeCameraEye(pos, groundAlt, heading),
          cameraHeadingDeg: heading,
          liveTiltDeg: CAM_TILT,
          targetRangeM: CAM_RANGE,
          targetTiltDeg: CAM_TILT,
        });
        t += dt;
        samples.push({ t, pitch });
      }
      return samples;
    };

    const makeConstantSchedule = (fps: number) =>
      Array.from({ length: Math.round(durationS * fps) }, () => 1 / fps);

    // Variable-dt schedule mixing 60 Hz frames with periodic 0.15s–0.25s hitches
    const variableSchedule: number[] = [];
    let acc = 0;
    let idx = 0;
    while (acc < durationS - 1e-6) {
      const rawDt = idx % 20 === 10 ? 0.25 : idx % 13 === 5 ? 0.15 : 1 / 60;
      const dt = Math.min(rawDt, durationS - acc);
      variableSchedule.push(dt);
      acc += dt;
      idx++;
    }

    const ref120 = runWithStepSchedule(makeConstantSchedule(120));
    const finalRef = ref120[ref120.length - 1]!.pitch;

    for (const [label, schedule] of [
      ['15Hz', makeConstantSchedule(15)],
      ['30Hz', makeConstantSchedule(30)],
      ['60Hz', makeConstantSchedule(60)],
      ['variable-hitch', variableSchedule],
    ] as const) {
      const run = runWithStepSchedule(schedule);
      const finalPitch = run[run.length - 1]!.pitch;
      // Endpoints after 4s of rolling hills should closely match 120 Hz reference
      expect(Math.abs(finalPitch - finalRef)).toBeLessThan(label === 'variable-hitch' ? 2.5 : 1.5);
    }
  });

  test('reset() clears pitch and state, and sceneReady/teleporting gates hold pitch at 0', () => {
    const tracker = new TerrainPitchTracker();
    const dt = 1 / 60;
    const slope15 = Math.tan(degToRad(15));

    // Ignored before sceneReady
    for (let i = 0; i < 60; i++) {
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, i * 0.5);
      expect(
        tracker.update({
          dt,
          truckPos: pos,
          headingDeg: 0,
          speedMps: 30,
          sceneReady: false,
          teleporting: false,
          cameraPosition: makeCameraEye(pos, 100 + i * 0.5 * slope15, 0),
          cameraHeadingDeg: 0,
          liveTiltDeg: CAM_TILT,
          targetRangeM: CAM_RANGE,
          targetTiltDeg: CAM_TILT,
        }),
      ).toBe(0);
    }

    // Build real pitch once sceneReady
    for (let i = 0; i < 120; i++) {
      const dist = i * 0.5;
      const pos = offsetToLatLng(ORIGIN.lat, ORIGIN.lng, 0, dist);
      tracker.update({
        dt,
        truckPos: pos,
        headingDeg: 0,
        speedMps: 30,
        sceneReady: true,
        teleporting: false,
        cameraPosition: makeCameraEye(pos, 100 + dist * slope15, 0),
        cameraHeadingDeg: 0,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      });
    }
    expect(tracker.pitchDeg).toBeLessThan(-10);

    // reset() immediately zeroes pitch and suppresses updates while teleporting
    tracker.reset();
    expect(tracker.pitchDeg).toBe(0);
    expect(
      tracker.update({
        dt,
        truckPos: ORIGIN,
        headingDeg: 0,
        speedMps: 0,
        sceneReady: true,
        teleporting: true,
        cameraPosition: makeCameraEye(ORIGIN, 500, 0),
        cameraHeadingDeg: 0,
        liveTiltDeg: CAM_TILT,
        targetRangeM: CAM_RANGE,
        targetTiltDeg: CAM_TILT,
      }),
    ).toBe(0);
  });
});
