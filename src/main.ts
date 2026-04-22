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

function loadMapsAPI(apiKey: string) {
  // @ts-ignore
  (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({
    key: apiKey,
    v: "alpha",
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

  loadMapsAPI(API_KEY);

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

  const mapModeSelect = document.getElementById('map-mode') as HTMLSelectElement;
  if (mapModeSelect) {
    mapModeSelect.addEventListener('change', () => {
      map.mode = mapModeSelect.value === 'ROADMAP' ? MapMode.ROADMAP : MapMode.SATELLITE;
    });
  }

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
