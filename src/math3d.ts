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

export function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}

export function offsetToLatLng(
  lat: number,
  lng: number,
  east: number,
  north: number,
): { lat: number; lng: number } {
  const nextLat = clamp(lat + (north / EARTH_RADIUS_M) * (180 / Math.PI), -90, 90);
  const cosLat = Math.max(Math.abs(Math.cos(degToRad(lat))), 1e-6);
  const dLng = (east / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI);
  return { lat: nextLat, lng: fixAngle(lng + dLng) };
}

export function horizontalDistanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = degToRad(b.lat - a.lat);
  const dLng = degToRad(fixAngle(b.lng - a.lng));
  const midLat = degToRad((a.lat + b.lat) / 2);
  const north = dLat * EARTH_RADIUS_M;
  const east = dLng * EARTH_RADIUS_M * Math.cos(midLat);
  return Math.hypot(east, north);
}
