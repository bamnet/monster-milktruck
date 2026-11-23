import { PRESETS, resolveAltitudeMode } from './config.ts';
import { createInput } from './input.ts';
import { createLoadingScreen } from './loading.ts';
import { fixAngle } from './math3d.ts';
import { Truck } from './truck.ts';
import {
  browserUrlHistoryTarget,
  createUrlStateSync,
  hasPoseChangedForUrl,
  parseUrlHash,
  type AppMapMode,
} from './url-state.ts';
import truckModelUrl from '../public/milktruck.glb' with { type: 'file' };
import './styles.css';

declare const process: { env: { GOOGLE_MAPS_API_KEY?: string } };

const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';

const loadingScreen = createLoadingScreen({
  root: document.getElementById('loading-screen'),
  status: document.getElementById('loading-status'),
  barFill: document.getElementById('loading-bar-fill'),
});

function loadMapsAPI(apiKey: string) {
  // @ts-ignore
  (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({
    key: apiKey,
    v: "alpha",
  });
}

function fatal(msg: string): void {
  loadingScreen.dismissImmediately();
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
  loadingScreen.setProgress(30);

  const { Map3DElement, Model3DElement, AltitudeMode, MapMode } =
    (await google.maps.importLibrary('maps3d')) as typeof google.maps.maps3d;

  loadingScreen.setProgress(60);

  const initState = parseUrlHash(window.location.hash);
  const initHeading = fixAngle(initState.heading);
  const urlSync = createUrlStateSync({
    initialState: initState,
    target: browserUrlHistoryTarget(window),
  });
  const toSdkMapMode = (mode: AppMapMode) =>
    mode === 'ROADMAP' ? MapMode.ROADMAP : MapMode.SATELLITE;

  const map = new Map3DElement({
    center: { lat: initState.lat, lng: initState.lng, altitude: 0 },
    heading: initHeading,
    tilt: 72,
    range: 55,
    mode: toSdkMapMode(initState.mode),
    defaultUIHidden: true,
  });

  document.getElementById('map-container')!.appendChild(map);

  const mapModeSelect = document.getElementById('map-mode') as HTMLSelectElement | null;
  if (mapModeSelect) {
    mapModeSelect.value = initState.mode;
    mapModeSelect.addEventListener('change', () => {
      const nextMode: AppMapMode = mapModeSelect.value === 'ROADMAP' ? 'ROADMAP' : 'SATELLITE';
      map.mode = toSdkMapMode(nextMode);
      urlSync.setMode(nextMode);
    });
  }

  const model = new Model3DElement({
    src: truckModelUrl,
    position: { lat: initState.lat, lng: initState.lng, altitude: 0 },
    orientation: { heading: initHeading, tilt: 0, roll: 0 },
    altitudeMode: AltitudeMode.CLAMP_TO_GROUND,
    scale: 1,
  });
  map.append(model);

  const altitudeMode = resolveAltitudeMode(window.location.search);

  const input = createInput();
  const popupEl = document.getElementById('popup')!;
  const truck = new Truck(
    map,
    model,
    input,
    popupEl,
    altitudeMode,
    { lat: initState.lat, lng: initState.lng, heading: initHeading },
    () => {
      loadingScreen.complete();
    },
    (pose, immediate) => {
      urlSync.updatePose(pose, immediate);
    },
  );

  urlSync.flush();

  window.addEventListener('hashchange', () => {
    if (window.location.hash === urlSync.getLastHash()) return;
    const prev = urlSync.getState();
    const next = parseUrlHash(window.location.hash, prev);
    const poseChanged = hasPoseChangedForUrl(next, truck.getPose());
    urlSync.setState(next, true);
    if (next.mode !== prev.mode) {
      map.mode = toSdkMapMode(next.mode);
      if (mapModeSelect) {
        mapModeSelect.value = next.mode;
      }
    }
    if (poseChanged) {
      truck.teleportTo(next.lat, next.lng, next.heading);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      urlSync.flush();
    }
  });
  window.addEventListener('pagehide', () => {
    urlSync.flush();
  });

  renderPresets(truck);
  loadingScreen.setProgress(82);

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
