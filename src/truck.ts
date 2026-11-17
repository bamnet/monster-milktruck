import { clamp, degToRad, fixAngle, offsetToLatLng } from './math3d.ts';
import type { InputState } from './input.ts';
import { TerrainPitchTracker } from './terrain-pitch.ts';

const TICK_MAX_DT = 0.25;
const ACCEL = 50.0;
const DECEL = 80.0;
const MAX_REVERSE_SPEED = 40.0;

const TURN_SPEED_MIN = 60;
const TURN_SPEED_MAX = 100;
const SPEED_MAX_TURN = 25;
const SPEED_MIN_TURN = 120;

const DRAG_FACTOR = 0.00090;
const CONSTANT_DRAG = 2.0;

const STEER_ROLL = -1.0;
const ROLL_SPRING_K = 30.0;
const ROLL_DAMP_C = 9.6;
const ROLL_MAX_SUBSTEP_S = 1 / 120;

const CAM_TILT_DEG = 72;
const CAM_RANGE_M = 55;
const CAM_SMOOTH_TAU = 0.5;
const TELEPORT_FLY_MS = 1200;
const TELEPORT_SETTLE_CEILING_MS = 800;
const TELEPORT_ANIM_END_EARLY_MS = 200;
const CAMERA_IN_FLIGHT_MAX_MS = 50;

// The glb root node is upright (+X right, +Y forward, +Z up), matching Google Maps
// Model3DElement's orientation convention (rotations apply in order: roll, tilt, heading)
// without a 90° tilt offset. tilt < 0 pitches nose up (uphill), tilt > 0 pitches nose down.
const MODEL_HEADING_OFFSET = 0;
const MODEL_TILT_OFFSET = 0;
const MODEL_ROLL_OFFSET = 0;

const IDLE_MESSAGES = [
  "Let's deliver some milk!",
  'Hello?',
  'Dude, step on it!',
  "I'm sitting here getting sour!",
  'We got customers waiting!',
  'Zzzzzzz',
  'Sometimes I wish I worked for UPS.',
];

const FAST_MESSAGES = [
  'Whoah there, cowboy!',
  'Wheeeeeeeeee!',
  'Creamy!',
  "Hey, we're hauling glass bottles here!",
];

export interface TruckStart {
  lat: number;
  lng: number;
  heading: number;
}

type Map3D = google.maps.maps3d.Map3DElement;
type Model3D = google.maps.maps3d.Model3DElement;

export class Truck {
  private lat: number;
  private lng: number;
  private heading: number;
  private velE = 0;
  private velN = 0;
  private roll = 0;
  private rollSpeed = 0;
  private camHeading: number;

  private lastTime = 0;
  private running = false;
  private rafId: number | null = null;
  private idleTimer = 0;
  private fastTimer = 0;
  private popupTimer = 0;
  private teleportUntil = 0;
  private teleportPitchLockUntil = 0;
  private awaitingTeleportAnimationEnd = false;
  private lastPositionKey = '';
  private lastOrientationKey = '';
  private lastCameraKey = '';
  private readonly initialCameraKey: string;
  private cameraFlyInFlightUntil = 0;
  private initialSceneReady = false;
  private terrainPitchReady = false;
  private listenersAttached = false;
  private readonly fixedAltitude: boolean;
  private readonly terrainPitch = new TerrainPitchTracker();

  private readonly onCenterChange = (): void => {
    this.cameraFlyInFlightUntil = 0;
  };

  private readonly onAnimationEnd = (): void => {
    this.cameraFlyInFlightUntil = 0;
    if (
      this.awaitingTeleportAnimationEnd &&
      performance.now() >= this.teleportUntil - TELEPORT_ANIM_END_EARLY_MS
    ) {
      this.awaitingTeleportAnimationEnd = false;
    }
  };

  private readonly onInitialSteady = (e: Event): void => {
    if (!(e as Event & { isSteady?: boolean }).isSteady) return;
    this.initialSceneReady = true;
    this.terrainPitchReady = true;
    this.cameraFlyInFlightUntil = 0;
    this.map.removeEventListener('gmp-steadychange', this.onInitialSteady);
    if (this.lastCameraKey === this.initialCameraKey && performance.now() >= this.teleportUntil) {
      this.flyCameraToSelf(0, true);
    }
    this.onReady?.();
  };

  constructor(
    private readonly map: Map3D,
    private readonly model: Model3D,
    private readonly input: InputState,
    private readonly popupEl: HTMLElement,
    private readonly altitudeMode: google.maps.maps3d.AltitudeModeString,
    start: TruckStart,
    private readonly onReady?: () => void,
  ) {
    this.fixedAltitude = altitudeMode === 'ABSOLUTE';
    this.lat = start.lat;
    this.lng = start.lng;
    this.heading = start.heading;
    this.camHeading = start.heading;
    this.applyModel();

    // Wait for the initial scene to finish loading (gmp-steadychange) before
    // snapping the camera to RELATIVE_TO_GROUND.
    this.initialCameraKey = this.cameraKey();
    this.lastCameraKey = this.initialCameraKey;
    this.attachMapListeners();
  }

  getPitchDeg(): number {
    return this.fixedAltitude ? 0 : this.terrainPitch.pitchDeg;
  }

  teleportTo(lat: number, lng: number, heading = 0): void {
    this.lat = lat;
    this.lng = lng;
    this.heading = heading;
    this.camHeading = heading;
    this.velE = 0;
    this.velN = 0;
    this.roll = 0;
    this.rollSpeed = 0;
    this.idleTimer = 0;
    this.fastTimer = 0;
    this.terrainPitch.reset();
    this.applyModel();
    this.flyCameraToSelf(TELEPORT_FLY_MS);
    const now = performance.now();
    this.teleportUntil = now + TELEPORT_FLY_MS;
    this.awaitingTeleportAnimationEnd = true;
    this.teleportPitchLockUntil = now + TELEPORT_FLY_MS + TELEPORT_SETTLE_CEILING_MS;
  }

  start(): void {
    if (!this.listenersAttached) {
      this.attachMapListeners();
    }
    this.running = true;
    this.lastTime = performance.now();
    const tick = (t: number) => {
      if (!this.running) return;
      const dt = clamp((t - this.lastTime) / 1000, 0, TICK_MAX_DT);
      this.lastTime = t;
      this.step(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.detachMapListeners();
  }

  step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;

    this.updateTerrainPitch(dt);

    const { left, right, gas, reverse } = this.input;
    const speed = Math.hypot(this.velE, this.velN);

    let steerDeg = 0;
    if (left || right) {
      let turnSpeed: number;
      if (speed < SPEED_MAX_TURN) {
        turnSpeed = TURN_SPEED_MIN + (TURN_SPEED_MAX - TURN_SPEED_MIN)
          * (SPEED_MAX_TURN - speed) / SPEED_MAX_TURN;
        turnSpeed *= (speed / SPEED_MAX_TURN);
      } else if (speed < SPEED_MIN_TURN) {
        turnSpeed = TURN_SPEED_MIN + (TURN_SPEED_MAX - TURN_SPEED_MIN)
          * (SPEED_MIN_TURN - speed) / (SPEED_MIN_TURN - SPEED_MAX_TURN);
      } else {
        turnSpeed = TURN_SPEED_MIN;
      }
      if (left) steerDeg = -turnSpeed * dt;
      if (right) steerDeg = turnSpeed * dt;
    }

    this.heading = fixAngle(this.heading + steerDeg);

    // heading 0 = north, 90 = east. Forward = (sin h, cos h) in (east, north).
    const hRad = degToRad(this.heading);
    const dirE = Math.sin(hRad);
    const dirN = Math.cos(hRad);
    // Right of forward = 90° CW = (cos h, -sin h)
    const rightE = Math.cos(hRad);
    const rightN = -Math.sin(hRad);

    // Sideways-slip damp (ad-hoc friction)
    const slip = this.velE * rightE + this.velN * rightN;
    const slipDamp = 1 - Math.exp(-dt / 0.5);
    this.velE -= rightE * slip * slipDamp;
    this.velN -= rightN * slip * slipDamp;

    let forwardSpeed = this.velE * dirE + this.velN * dirN;
    if (gas) {
      this.velE += dirE * ACCEL * dt;
      this.velN += dirN * ACCEL * dt;
    } else if (reverse) {
      if (forwardSpeed > -MAX_REVERSE_SPEED) {
        this.velE -= dirE * DECEL * dt;
        this.velN -= dirN * DECEL * dt;
      }
    }

    // Drag: quadratic + constant rolling resistance
    const absSpeed = Math.hypot(this.velE, this.velN);
    if (absSpeed > 0.01) {
      let drag = absSpeed * absSpeed * DRAG_FACTOR + CONSTANT_DRAG;
      if (drag > absSpeed / dt) drag = absSpeed / dt;
      this.velE -= (this.velE / absSpeed) * drag * dt;
      this.velN -= (this.velN / absSpeed) * drag * dt;
      if (Math.hypot(this.velE, this.velN) <= 0.01 && !gas && !reverse) {
        this.velE = 0;
        this.velN = 0;
      }
    } else if (!gas && !reverse) {
      this.velE = 0;
      this.velN = 0;
    }

    if (this.velE !== 0 || this.velN !== 0) {
      const deltaE = this.velE * dt;
      const deltaN = this.velN * dt;
      const next = offsetToLatLng(this.lat, this.lng, deltaE, deltaN);
      this.lat = next.lat;
      this.lng = next.lng;
    }

    forwardSpeed = this.velE * dirE + this.velN * dirN;
    this.stepRoll(dt, steerDeg, forwardSpeed, left || right);

    this.applyModel();
    this.followCamera(dt);
    this.tickPopups(dt, Math.hypot(this.velE, this.velN));
  }

  private attachMapListeners(): void {
    this.map.addEventListener('gmp-centerchange', this.onCenterChange);
    this.map.addEventListener('gmp-animationend', this.onAnimationEnd);
    if (!this.initialSceneReady) {
      this.map.addEventListener('gmp-steadychange', this.onInitialSteady);
    }
    this.listenersAttached = true;
  }

  private detachMapListeners(): void {
    if (!this.listenersAttached) return;
    this.map.removeEventListener('gmp-centerchange', this.onCenterChange);
    this.map.removeEventListener('gmp-animationend', this.onAnimationEnd);
    this.map.removeEventListener('gmp-steadychange', this.onInitialSteady);
    this.listenersAttached = false;
  }

  private readCameraPosition(): { lat: number; lng: number; altitude: number } | null {
    const pos = this.map.cameraPosition;
    if (!pos) return null;
    const lat = pos.lat;
    const lng = pos.lng;
    const altitude = pos.altitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(altitude)) {
      return null;
    }
    return { lat, lng, altitude };
  }

  private updateTerrainPitch(dt: number): void {
    if (this.fixedAltitude || !this.terrainPitchReady) return;
    let teleporting = false;
    if (this.teleportUntil > 0) {
      const now = performance.now();
      teleporting =
        now < this.teleportUntil ||
        (this.awaitingTeleportAnimationEnd && now < this.teleportPitchLockUntil);
    }
    if (teleporting) return;
    const rawHeading = this.map.heading;
    const rawTilt = this.map.tilt;
    this.terrainPitch.update({
      dt,
      truckPos: { lat: this.lat, lng: this.lng },
      headingDeg: this.heading,
      speedMps: Math.hypot(this.velE, this.velN),
      sceneReady: this.terrainPitchReady,
      teleporting: false,
      cameraPosition: this.readCameraPosition(),
      cameraHeadingDeg:
        typeof rawHeading === 'number' && Number.isFinite(rawHeading)
          ? rawHeading
          : this.camHeading,
      liveTiltDeg:
        typeof rawTilt === 'number' && Number.isFinite(rawTilt) ? rawTilt : null,
      targetRangeM: CAM_RANGE_M,
      targetTiltDeg: CAM_TILT_DEG,
    });
  }

  private stepRoll(
    dt: number,
    steerDeg: number,
    forwardSpeed: number,
    steering: boolean,
  ): void {
    if (!steering && steerDeg === 0 && this.roll === 0 && this.rollSpeed === 0) {
      return;
    }
    const steerAccel = (degToRad(steerDeg) / dt) * forwardSpeed * STEER_ROLL;
    const steps = Math.max(1, Math.ceil(dt / ROLL_MAX_SUBSTEP_S));
    const subDt = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.rollSpeed +=
        (steerAccel - ROLL_SPRING_K * this.roll - ROLL_DAMP_C * this.rollSpeed) * subDt;
      this.roll += this.rollSpeed * subDt;
      if (this.roll < -30) {
        this.roll = -30;
        if (this.rollSpeed < 0) this.rollSpeed = 0;
      } else if (this.roll > 30) {
        this.roll = 30;
        if (this.rollSpeed > 0) this.rollSpeed = 0;
      }
    }
    if (!steering && Math.abs(this.roll) < 0.005 && Math.abs(this.rollSpeed) < 0.01) {
      this.roll = 0;
      this.rollSpeed = 0;
    }
  }

  private applyModel(): void {
    const lat = roundCoord(this.lat);
    const lng = roundCoord(this.lng);
    const posKey = `${lat},${lng}`;
    if (posKey !== this.lastPositionKey) {
      this.lastPositionKey = posKey;
      this.model.position = { lat, lng, altitude: 0 };
    }

    const heading = roundAngle(fixAngle(this.heading + MODEL_HEADING_OFFSET));
    const tilt = roundAngle(
      fixAngle((this.fixedAltitude ? 0 : this.terrainPitch.pitchDeg) + MODEL_TILT_OFFSET),
    );
    const roll = roundAngle(fixAngle(this.roll + MODEL_ROLL_OFFSET));
    const oriKey = `${heading},${tilt},${roll}`;
    if (oriKey !== this.lastOrientationKey) {
      this.lastOrientationKey = oriKey;
      this.model.orientation = {
        heading,
        tilt,
        roll,
      };
    }
  }

  private followCamera(dt: number): void {
    if (performance.now() < this.teleportUntil) return;
    const delta = fixAngle(this.heading - this.camHeading);
    if (Math.abs(delta) < 0.01) {
      this.camHeading = this.heading;
    } else {
      const c0 = Math.exp(-dt / CAM_SMOOTH_TAU);
      this.camHeading = fixAngle(this.camHeading + (1 - c0) * delta);
    }
    this.flyCameraToSelf(0);
  }

  private cameraKey(): string {
    return `${roundCoord(this.lat)},${roundCoord(this.lng)},${roundAngle(this.camHeading)},${this.altitudeMode}`;
  }

  private flyCameraToSelf(durationMillis: number, force = false): void {
    const now = performance.now();
    const key = this.cameraKey();
    if (!force && durationMillis === 0) {
      if (key === this.lastCameraKey) return;
      if (now < this.cameraFlyInFlightUntil) return;
    }
    this.lastCameraKey = key;
    this.cameraFlyInFlightUntil =
      durationMillis === 0 && !this.initialSceneReady ? now + CAMERA_IN_FLIGHT_MAX_MS : 0;

    this.map.flyCameraTo({
      endCamera: {
        center: { lat: roundCoord(this.lat), lng: roundCoord(this.lng), altitude: 0 },
        altitudeMode: this.altitudeMode,
        heading: roundAngle(this.camHeading),
        tilt: CAM_TILT_DEG,
        range: CAM_RANGE_M,
      },
      durationMillis,
    });
    if (this.altitudeMode === 'RELATIVE_TO_GROUND') {
      this.terrainPitchReady = true;
    }
  }

  private tickPopups(dt: number, speed: number): void {
    if (this.popupTimer > 0) {
      this.popupTimer -= dt;
      this.idleTimer = 0;
      this.fastTimer = 0;
      if (this.popupTimer <= 0) {
        this.popupTimer = 0;
        this.popupEl.hidden = true;
      }
      return;
    }
    if (speed < 20) {
      this.idleTimer += dt;
      if (this.idleTimer > 10) {
        this.showPopup(pickRandom(IDLE_MESSAGES));
      }
      this.fastTimer = 0;
    } else {
      this.idleTimer = 0;
      if (speed > 80) {
        this.fastTimer += dt;
        if (this.fastTimer > 7) {
          this.showPopup(pickRandom(FAST_MESSAGES));
        }
      } else {
        this.fastTimer = 0;
      }
    }
  }

  private showPopup(msg: string): void {
    this.popupEl.textContent = msg;
    this.popupEl.hidden = false;
    this.popupTimer = 2.0;
  }
}

function roundCoord(v: number): number {
  return Math.round(v * 1e7) / 1e7;
}

function roundAngle(v: number): number {
  const rounded = Math.round(v * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function pickRandom(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
