import type { TruckStart } from './truck.ts';

export interface Preset extends TruckStart {
  label: string;
}

export const PRESETS: readonly Preset[] = [
  { label: "Th' Plex", lat: 37.423501, lng: -122.086744, heading: 90 },
  { label: 'San Francisco', lat: 37.7749, lng: -122.4194, heading: 0 },
  { label: 'Whistler', lat: 50.085734, lng: -122.855824, heading: 220 },
  { label: 'Pismo', lat: 35.040675, lng: -120.629513, heading: 170 },
  { label: 'Tokyo', lat: 35.668607, lng: 139.822026, heading: 180 },
  { label: 'Everest', lat: 27.991283, lng: 86.92434, heading: 70 },
];

export function resolveAltitudeMode(
  search: string,
): google.maps.maps3d.AltitudeModeString {
  return new URLSearchParams(search).has('fixedAltitude')
    ? 'ABSOLUTE'
    : 'RELATIVE_TO_GROUND';
}
