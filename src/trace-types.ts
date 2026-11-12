import type { InputState } from './input.ts';
import type { TruckStart } from './truck.ts';

export interface TraceFrame {
  tMs: number;
  dt: number;
  input: InputState;
  modelPos: { lat: number; lng: number };
  mapCenter: { lat: number; lng: number; altitude: number };
  mapRange: number;
  mapHeading: number;
}

export interface TerrainTrace {
  preset: string;
  start: TruckStart;
  capturedAt: string;
  frames: TraceFrame[];
}
