# Monster Milktruck 2

A modernized port of the classic [Monster Milktruck](https://earth-api-samples.googlecode.com/) demo, rebuilt on the Google Maps JavaScript API's 3D map mode with photorealistic tiles.

Drive a monster truck across real 3D terrain: San Francisco, Whistler, Mt. Everest, Tokyo. Arrow keys / WASD to steer, or use the on-screen buttons.

## Tech stack

- [Bun](https://bun.sh/) — runtime, bundler, dev server
- [Google Maps JavaScript API (3D)](https://developers.google.com/maps/documentation/javascript/3d/overview) — `Map3DElement` + `Model3DElement`
- TypeScript, no framework, no 3D engine

## Setup

1. Create a [Google Maps Platform API key](https://developers.google.com/maps/documentation/javascript/get-api-key) with the **Maps JavaScript API** enabled. Restrict it to your HTTP referrers.
2. Copy the env template and paste your key:
   ```bash
   cp .env.example .env.local
   # edit .env.local and set GOOGLE_MAPS_API_KEY=...
   ```
3. Install dependencies:
   ```bash
   bun install
   ```
4. Run the dev server:
   ```bash
   bun run dev
   ```
   Then open http://localhost:3000.

## Build

```bash
GOOGLE_MAPS_API_KEY=your_key bun run build
```

Output lands in `dist/`. The key is inlined at build time.

## Deploy (GitHub Pages)

The included workflow at `.github/workflows/deploy.yml` builds and deploys on every push to `main`. To enable it:

1. In the repo **Settings → Pages**, set source to **GitHub Actions**.
2. In **Settings → Secrets and variables → Actions**, add a secret named `GOOGLE_MAPS_API_KEY`.
3. In the Google Cloud Console, add your Pages URL (e.g. `https://<you>.github.io/milktruck2/*`) to the API key's allowed HTTP referrers.

## Controls

| Action   | Keys              |
| -------- | ----------------- |
| Gas      | Up arrow / W      |
| Reverse  | Down arrow / S    |
| Left     | Left arrow / A    |
| Right    | Right arrow / D   |

Click a preset city button to teleport.

## What's different from the original

- Runs on the new 3D Maps API (`Map3DElement`, `Model3DElement`) instead of the retired Google Earth plugin.
- The truck is clamped to the ground via `AltitudeMode.CLAMP_TO_GROUND`. Airborne physics, gravity, and ground-normal tilting from the original demo are dropped — the 3D Maps API doesn't currently expose the terrain raycasting needed to re-implement them.
- Moon rover mode is removed.
- The free-text geocoder is removed; use the preset buttons.

## Layout

```
index.html         HTML entry (references src/main.ts)
src/
  main.ts          boot sequence: load API, create map + truck, wire UI
  truck.ts         driving physics + camera follow + popup logic
  input.ts         keyboard + on-screen button input state
  math3d.ts        angle helpers + east/north-to-lat/lng conversion
  styles.css
public/
  milktruck.glb    truck model
build.ts           production build script
bunfig.toml        dev-server env inlining config
```

## License

Apache License, Version 2.0 (inherited from the original Google demo).
