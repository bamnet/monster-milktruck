import { PRESETS } from './config.ts';
import { clamp, fixAngle } from './math3d.ts';

export type AppMapMode = 'SATELLITE' | 'ROADMAP';

export interface UrlViewState {
  lat: number;
  lng: number;
  heading: number;
  mode: AppMapMode;
}

export interface UrlHistoryTarget {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  replaceHash(url: string): void;
}

export interface UrlStateSyncOptions {
  initialState: UrlViewState;
  target: UrlHistoryTarget;
  now?: () => number;
  throttleMs?: number;
}

export interface UrlStateSync {
  getState(): UrlViewState;
  getLastHash(): string;
  updatePose(pose: { lat: number; lng: number; heading: number }, immediate?: boolean): void;
  setMode(mode: AppMapMode): void;
  setState(next: UrlViewState, immediate?: boolean): void;
  flush(): void;
}

export const DEFAULT_URL_SYNC_THROTTLE_MS = 1000;

export function defaultUrlViewState(): UrlViewState {
  const start = PRESETS[0]!;
  return {
    lat: start.lat,
    lng: start.lng,
    heading: start.heading,
    mode: 'SATELLITE',
  };
}

export function toCompassHeading(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  return Object.is(wrapped, -0) || wrapped === 360 ? 0 : wrapped;
}

export function toCompassHeadingInt(deg: number): number {
  const rounded = Math.round(toCompassHeading(deg));
  return rounded === 360 ? 0 : rounded;
}

export function parseUrlHash(
  hash: string,
  fallback: UrlViewState = defaultUrlViewState(),
): UrlViewState {
  let raw = hash.trim();
  if (raw.startsWith('#')) raw = raw.slice(1);
  if (raw.startsWith('?')) raw = raw.slice(1);

  const params = new URLSearchParams(raw);
  const rawLat = parseFiniteParam(params.get('lat'));
  const rawLng = parseFiniteParam(params.get('lng'));

  const hasValidCoords =
    rawLat !== null &&
    rawLng !== null &&
    rawLat >= -90 &&
    rawLat <= 90 &&
    rawLng >= -180 &&
    rawLng <= 180;

  const lat = hasValidCoords ? normalizeZero(rawLat) : fallback.lat;
  const lng = hasValidCoords ? normalizeZero(rawLng) : fallback.lng;

  const rawHeading = parseFiniteParam(params.get('heading'));
  const heading =
    rawHeading !== null
      ? toCompassHeading(rawHeading)
      : hasValidCoords
        ? 0
        : fallback.heading;

  const rawMode = params.get('mode')?.trim().toUpperCase();
  const mode: AppMapMode =
    rawMode === 'ROADMAP'
      ? 'ROADMAP'
      : rawMode === 'SATELLITE'
        ? 'SATELLITE'
        : fallback.mode;

  return { lat, lng, heading, mode };
}

export function formatUrlHash(state: UrlViewState): string {
  const lat = formatCoord6(clamp(state.lat, -90, 90));
  const lng = formatCoord6(clamp(state.lng, -180, 180));
  const heading = toCompassHeadingInt(state.heading);
  const mode = state.mode === 'ROADMAP' ? 'roadmap' : 'satellite';
  return `#lat=${lat}&lng=${lng}&heading=${heading}&mode=${mode}`;
}

export function hasPoseChangedForUrl(
  a: { lat: number; lng: number; heading: number },
  b: { lat: number; lng: number; heading: number },
): boolean {
  return (
    Math.abs(a.lat - b.lat) >= 1e-6 ||
    Math.abs(a.lng - b.lng) >= 1e-6 ||
    Math.abs(fixAngle(a.heading - b.heading)) >= 0.5
  );
}

export function browserUrlHistoryTarget(win: Window = window): UrlHistoryTarget {
  return {
    get pathname() {
      return win.location.pathname;
    },
    get search() {
      return win.location.search;
    },
    get hash() {
      return win.location.hash;
    },
    replaceHash(url: string) {
      try {
        win.history.replaceState(null, '', url);
      } catch {
        // Ignore SecurityError in opaque-origin / sandboxed contexts.
      }
    },
  };
}

export function createUrlStateSync(options: UrlStateSyncOptions): UrlStateSync {
  const {
    target,
    now = () => performance.now(),
    throttleMs = DEFAULT_URL_SYNC_THROTTLE_MS,
  } = options;

  let state: UrlViewState = { ...options.initialState };
  let lastWrittenHash = '';
  let lastWriteTimeMs = -Infinity;

  const writeIfDue = (immediate: boolean): void => {
    const nextHash = formatUrlHash(state);
    if (nextHash === lastWrittenHash && target.hash === nextHash) {
      return;
    }
    if (target.hash === nextHash) {
      lastWrittenHash = nextHash;
      return;
    }
    const nowMs = now();
    if (!immediate && nowMs - lastWriteTimeMs < throttleMs) {
      return;
    }
    lastWrittenHash = nextHash;
    lastWriteTimeMs = nowMs;
    target.replaceHash(`${target.pathname}${target.search}${nextHash}`);
  };

  return {
    getState(): UrlViewState {
      return { ...state };
    },
    getLastHash(): string {
      return lastWrittenHash;
    },
    updatePose(pose, immediate = false): void {
      state = {
        ...state,
        lat: pose.lat,
        lng: pose.lng,
        heading: pose.heading,
      };
      writeIfDue(immediate);
    },
    setMode(mode: AppMapMode): void {
      state = { ...state, mode };
      writeIfDue(true);
    },
    setState(next: UrlViewState, immediate = true): void {
      state = { ...next };
      writeIfDue(immediate);
    },
    flush(): void {
      writeIfDue(true);
    },
  };
}

function parseFiniteParam(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function normalizeZero(v: number): number {
  return Object.is(v, -0) || v === 0 ? 0 : v;
}

function formatCoord6(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 5e-7) {
    return '0.000000';
  }
  return v.toFixed(6);
}
