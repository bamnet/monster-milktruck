export const EARTH_RADIUS_M = 6378137;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function fixAngle(a: number): number {
  return ((a + 180) % 360 + 360) % 360 - 180;
}

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function offsetToLatLng(
  lat: number,
  lng: number,
  east: number,
  north: number,
): { lat: number; lng: number } {
  const dLat = (north / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (east / (EARTH_RADIUS_M * Math.cos(degToRad(lat)))) * (180 / Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
