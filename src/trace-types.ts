import type { InputState } from './input.ts';
import type { TruckStart } from './truck.ts';

export interface LatLngAlt {
  lat: number;
  lng: number;
  altitude: number;
}

export interface Orientation3D {
  heading: number;
  tilt: number;
  roll: number;
}

export interface TraceFrame {
  tMs: number;
  dt: number;
  input: InputState;
  modelPos: { lat: number; lng: number; altitude?: number };
  mapCenter: LatLngAlt;
  mapRange: number;
  mapHeading: number;
  mapTilt?: number;
  cameraPosition?: LatLngAlt;
  modelOrientation?: Orientation3D;
  groundAltitude?: number;
}

export interface TerrainTrace {
  preset: string;
  start: TruckStart;
  capturedAt: string;
  frames: TraceFrame[];
}

export interface GoldenTerrainPoint {
  distM: number;
  lat: number;
  lng: number;
  altitudeM: number;
}

export interface GoldenTerrainProfile {
  name: string;
  description: string;
  source: string;
  start: TruckStart;
  spacingM: number;
  totalLengthM: number;
  points: GoldenTerrainPoint[];
}
