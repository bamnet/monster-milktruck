import { clamp, degToRad, fixAngle, offsetToLatLng } from './math3d.ts';
import type { InputState } from './input.ts';

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
const ROLL_SPRING = 0.5;
const ROLL_DAMP = -0.16;

const CAM_TILT_DEG = 72;
const CAM_RANGE_M = 55;
const CAM_SMOOTH_TAU = 0.5;
const TELEPORT_FLY_MS = 1200;

// Offsets to reconcile the glb's local axes with Google Maps' orientation
// convention (heading=tilt=roll=0 places the model in some default pose that
// depends on how it was exported). Rotations apply in order: roll, tilt, heading.
const MODEL_HEADING_OFFSET = 0;
const MODEL_TILT_OFFSET = -90;
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
  private idleTimer = 0;
  private fastTimer = 0;
  private popupTimer = 0;
  private teleportUntil = 0;

  constructor(
    private readonly map: Map3D,
    private readonly model: Model3D,
    private readonly input: InputState,
    private readonly popupEl: HTMLElement,
    private readonly altitudeMode: google.maps.maps3d.AltitudeModeString,
    start: TruckStart,
  ) {
    this.lat = start.lat;
    this.lng = start.lng;
    this.heading = start.heading;
    this.camHeading = start.heading;
    this.applyModel();
    this.cutCamera();
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
    this.applyModel();
    this.flyCameraToSelf(TELEPORT_FLY_MS);
    this.teleportUntil = performance.now() + TELEPORT_FLY_MS;
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    const tick = (t: number) => {
      if (!this.running) return;
      const dt = Math.min((t - this.lastTime) / 1000, TICK_MAX_DT);
      this.lastTime = t;
      this.step(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
  }

  private step(dt: number): void {
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
    }

    const deltaE = this.velE * dt;
    const deltaN = this.velN * dt;
    const next = offsetToLatLng(this.lat, this.lng, deltaE, deltaN);
    this.lat = next.lat;
    this.lng = next.lng;

    forwardSpeed = this.velE * dirE + this.velN * dirN;
    this.rollSpeed += degToRad(steerDeg) * forwardSpeed * STEER_ROLL;
    this.rollSpeed += ROLL_SPRING * -this.roll + ROLL_DAMP * this.rollSpeed;
    this.roll += this.rollSpeed * dt;
    this.roll = clamp(this.roll, -30, 30);

    this.applyModel();
    this.followCamera(dt);
    this.tickPopups(dt, Math.hypot(this.velE, this.velN));
  }

  private applyModel(): void {
    this.model.position = { lat: this.lat, lng: this.lng, altitude: 0 };
    this.model.orientation = {
      heading: fixAngle(this.heading + MODEL_HEADING_OFFSET),
      tilt: MODEL_TILT_OFFSET,
      roll: fixAngle(this.roll + MODEL_ROLL_OFFSET),
    };
  }

  private cutCamera(): void {
    this.camHeading = this.heading;
    this.flyCameraToSelf(0);
  }

  private followCamera(dt: number): void {
    if (performance.now() < this.teleportUntil) return;
    const c0 = Math.exp(-dt / CAM_SMOOTH_TAU);
    const delta = fixAngle(this.heading - this.camHeading);
    this.camHeading = fixAngle(this.camHeading + (1 - c0) * delta);
    this.flyCameraToSelf(0);
  }

  private flyCameraToSelf(durationMillis: number): void {
    this.map.flyCameraTo({
      endCamera: {
        center: { lat: this.lat, lng: this.lng, altitude: 0 },
        altitudeMode: this.altitudeMode,
        heading: this.camHeading,
        tilt: CAM_TILT_DEG,
        range: CAM_RANGE_M,
      },
      durationMillis,
    });
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

function pickRandom(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
