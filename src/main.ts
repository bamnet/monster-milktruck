import { createInput } from './input.ts';
import { Truck, type TruckStart } from './truck.ts';
import truckModelUrl from '../public/milktruck.glb' with { type: 'file' };
import './styles.css';

declare const process: { env: { GOOGLE_MAPS_API_KEY?: string } };

const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';

const PRESETS: Array<{ label: string; lat: number; lng: number; heading: number }> = [
  { label: "Th' Plex", lat: 37.423501, lng: -122.086744, heading: 90 },
  { label: 'San Francisco', lat: 37.7749, lng: -122.4194, heading: 0 },
  { label: 'Whistler', lat: 50.085734, lng: -122.855824, heading: 220 },
  { label: 'Pismo', lat: 35.040675, lng: -120.629513, heading: 170 },
  { label: 'Tokyo', lat: 35.668607, lng: 139.822026, heading: 180 },
  { label: 'Everest', lat: 27.991283, lng: 86.92434, heading: 70 },
];

const INIT_LOC: TruckStart = PRESETS[0]!;

declare global {
  interface Window {
    __mapsReady?: () => void;
  }
}

function loadMapsApi(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    window.__mapsReady = () => resolve();
    const s = document.createElement('script');
    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      libraries: 'maps3d',
      callback: '__mapsReady',
    });
    s.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    s.async = true;
    s.onerror = () => reject(new Error('Failed to load Google Maps API'));
    document.head.appendChild(s);
  });
}

function fatal(msg: string): void {
  const el = document.getElementById('fatal');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<pre style="position:fixed;inset:0;background:#000;color:#f55;padding:2em;z-index:9999;white-space:pre-wrap">${msg}</pre>`,
    );
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    fatal(
      'Missing GOOGLE_MAPS_API_KEY.\n\n' +
        'Copy .env.example to .env and add your key, then restart the dev server.',
    );
    return;
  }

  await loadMapsApi(API_KEY);

  const { Map3DElement, Model3DElement, AltitudeMode, MapMode } =
    (await google.maps.importLibrary('maps3d')) as typeof google.maps.maps3d;

  const map = new Map3DElement({
    center: { lat: INIT_LOC.lat, lng: INIT_LOC.lng, altitude: 0 },
    heading: INIT_LOC.heading,
    tilt: 72,
    range: 55,
    mode: MapMode.SATELLITE,
    defaultUIHidden: true,
  });

  document.getElementById('map-container')!.appendChild(map);

  const model = new Model3DElement({
    src: truckModelUrl,
    position: { lat: INIT_LOC.lat, lng: INIT_LOC.lng, altitude: 0 },
    orientation: { heading: INIT_LOC.heading, tilt: 0, roll: 0 },
    altitudeMode: AltitudeMode.CLAMP_TO_GROUND,
    scale: 1,
  });
  map.append(model);

  const input = createInput();
  const popupEl = document.getElementById('popup')!;
  const truck = new Truck(map, model, input, popupEl, AltitudeMode.RELATIVE_TO_GROUND, INIT_LOC);

  renderPresets(truck);

  truck.start();
}

function renderPresets(truck: Truck): void {
  const container = document.getElementById('presets');
  if (!container) return;
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      truck.teleportTo(p.lat, p.lng, p.heading);
    });
    container.appendChild(btn);
  }
}

main().catch((err) => {
  console.error(err);
  fatal(String(err));
});
