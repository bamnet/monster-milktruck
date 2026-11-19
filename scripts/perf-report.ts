import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { InputState } from '../src/input.ts';
import { degToRad, fixAngle } from '../src/math3d.ts';
import type { TerrainTrace } from '../src/trace-types.ts';
import { Truck } from '../src/truck.ts';

interface BundleAssetStat {
  name: string;
  rawKb: number;
  gzipKb: number;
}

async function measureBundleSizes(): Promise<BundleAssetStat[]> {
  const outdir = mkdtempSync(join(tmpdir(), 'milktruck-size-'));
  try {
    const res = await Bun.build({
      entrypoints: ['./index.html'],
      outdir,
      minify: true,
      publicPath: './',
      env: 'disable',
      naming: { asset: '[name]-[hash].[ext]' },
      define: {
        'process.env.GOOGLE_MAPS_API_KEY': JSON.stringify('PLACEHOLDER_API_KEY'),
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
    });
    if (!res.success) {
      throw new Error(`Build failed: ${res.logs.map(String).join('\n')}`);
    }

    const stats: BundleAssetStat[] = [];
    for (const entry of readdirSync(outdir).sort()) {
      const buf = readFileSync(join(outdir, entry));
      const gz = gzipSync(buf);
      stats.push({
        name: basename(entry),
        rawKb: buf.byteLength / 1024,
        gzipKb: gz.byteLength / 1024,
      });
    }
    return stats;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

function createBenchRig(start: { lat: number; lng: number; heading: number }) {
  const target = new EventTarget();
  let flyCount = 0;
  let posWrites = 0;
  let oriWrites = 0;
  let lastCamHeading = start.heading;
  const camHeadings: number[] = [];

  const mapState: { center: google.maps.LatLngAltitudeLiteral; range: number } = {
    center: { lat: start.lat, lng: start.lng, altitude: 0 },
    range: 55,
  };

  const map = {
    get center() {
      return mapState.center;
    },
    set center(v: google.maps.LatLngAltitudeLiteral) {
      mapState.center = v;
    },
    get range() {
      return mapState.range;
    },
    set range(v: number) {
      mapState.range = v;
    },
    flyCameraTo(opts: google.maps.maps3d.FlyToAnimationOptions) {
      flyCount++;
      lastCamHeading = opts.endCamera.heading ?? lastCamHeading;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as google.maps.maps3d.Map3DElement;

  let curPos: google.maps.LatLngAltitudeLiteral = { lat: start.lat, lng: start.lng, altitude: 0 };
  let curOri: google.maps.Orientation3DLiteral = { heading: start.heading, tilt: -90, roll: 0 };
  const model = {
    get position() {
      return curPos;
    },
    set position(v: google.maps.LatLngAltitudeLiteral) {
      curPos = v;
      posWrites++;
    },
    get orientation() {
      return curOri;
    },
    set orientation(v: google.maps.Orientation3DLiteral) {
      curOri = v;
      oriWrites++;
    },
  } as unknown as google.maps.maps3d.Model3DElement;

  const input: InputState = { left: false, right: false, gas: false, reverse: false };
  const popup = { textContent: '', hidden: true } as unknown as HTMLElement;
  const truck = new Truck(map, model, input, popup, 'RELATIVE_TO_GROUND', start);
  target.dispatchEvent(Object.assign(new Event('gmp-steadychange'), { isSteady: true }));

  return {
    truck,
    input,
    mapState,
    target,
    camHeadings,
    recordCamHeading() {
      camHeadings.push(lastCamHeading);
    },
    get modelPos() {
      return curPos;
    },
    get counts() {
      return { flyCount, posWrites, oriWrites };
    },
  };
}

function runStepMicrobench() {
  const frames = 10_000;
  const rig = createBenchRig({ lat: 37.423501, lng: -122.086744, heading: 90 });

  // Warmup JIT
  rig.input.gas = true;
  for (let i = 0; i < 500; i++) rig.truck.step(1 / 60);

  const stepSamplesUs: number[] = [];
  const startCounts = { ...rig.counts };

  for (let i = 0; i < frames; i++) {
    rig.input.gas = i % 1000 < 800;
    rig.input.left = i % 400 >= 100 && i % 400 < 200;
    rig.input.right = i % 400 >= 250 && i % 400 < 350;
    const t0 = performance.now();
    rig.truck.step(1 / 60);
    stepSamplesUs.push((performance.now() - t0) * 1000);
  }

  stepSamplesUs.sort((a, b) => a - b);
  const meanUs = stepSamplesUs.reduce((acc, v) => acc + v, 0) / frames;
  const p95Us = stepSamplesUs[Math.floor(frames * 0.95)] ?? 0;
  const maxUs = stepSamplesUs[frames - 1] ?? 0;

  return {
    frames,
    meanUs,
    p95Us,
    maxUs,
    flyWritesPer1k: ((rig.counts.flyCount - startCounts.flyCount) / frames) * 1000,
    posWritesPer1k: ((rig.counts.posWrites - startCounts.posWrites) / frames) * 1000,
    oriWritesPer1k: ((rig.counts.oriWrites - startCounts.oriWrites) / frames) * 1000,
  };
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const mPerDeg = 111_319.9;
  const dN = (b.lat - a.lat) * mPerDeg;
  const dE = (b.lng - a.lng) * mPerDeg * Math.cos(degToRad((a.lat + b.lat) / 2));
  return Math.hypot(dE, dN);
}

function summarizeTraces() {
  const traceDir = join(process.cwd(), 'testdata', 'traces');
  let files: string[] = [];
  try {
    files = readdirSync(traceDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }

  return files.map((file) => {
    const trace = JSON.parse(readFileSync(join(traceDir, file), 'utf8')) as TerrainTrace;
    const rig = createBenchRig(trace.start);
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    let maxCamRateDegPerSec = 0;
    let prevRate = 0;
    let maxCamJerkDegPerSec2 = 0;

    for (const f of trace.frames) {
      rig.input.left = f.input.left;
      rig.input.right = f.input.right;
      rig.input.gas = f.input.gas;
      rig.input.reverse = f.input.reverse;
      rig.mapState.center = f.mapCenter;
      rig.mapState.range = f.mapRange;
      rig.target.dispatchEvent(new Event('gmp-centerchange'));

      const prevHeading = rig.camHeadings[rig.camHeadings.length - 1] ?? trace.start.heading;
      rig.truck.step(f.dt);
      rig.recordCamHeading();
      const nextHeading = rig.camHeadings[rig.camHeadings.length - 1] ?? prevHeading;

      if (f.dt > 0.001) {
        const rate = fixAngle(nextHeading - prevHeading) / f.dt;
        const absRate = Math.abs(rate);
        if (absRate > maxCamRateDegPerSec) maxCamRateDegPerSec = absRate;
        const jerk = Math.abs(rate - prevRate) / f.dt;
        if (jerk > maxCamJerkDegPerSec2) maxCamJerkDegPerSec2 = jerk;
        prevRate = rate;
      }

      if (f.mapCenter.altitude < minAlt) minAlt = f.mapCenter.altitude;
      if (f.mapCenter.altitude > maxAlt) maxAlt = f.mapCenter.altitude;
    }

    const drivenM = distanceMeters(trace.start, rig.modelPos);
    return {
      preset: trace.preset,
      frames: trace.frames.length,
      drivenM,
      altSpanM: Number.isFinite(minAlt) ? maxAlt - minAlt : 0,
      maxCamRateDegPerSec,
      maxCamJerkDegPerSec2,
    };
  });
}

async function main(): Promise<void> {
  const bundle = await measureBundleSizes();
  const bench = runStepMicrobench();
  const traces = summarizeTraces();

  const totalRaw = bundle.reduce((s, a) => s + a.rawKb, 0);
  const totalGzip = bundle.reduce((s, a) => s + a.gzipKb, 0);

  const lines: string[] = [
    '## Performance & Bundle Report (Advisory)',
    '',
    '### Production Bundle (`dist/`)',
    '| Asset | Raw (KB) | Gzip (KB) |',
    '| --- | ---: | ---: |',
    ...bundle.map((a) => `| \`${a.name}\` | ${a.rawKb.toFixed(2)} | ${a.gzipKb.toFixed(2)} |`),
    `| **Total** | **${totalRaw.toFixed(2)}** | **${totalGzip.toFixed(2)}** |`,
    '',
    '### `Truck.step()` CPU Micro-benchmark (10,000 frames @ 60 Hz)',
    '| Mean (µs/frame) | p95 (µs/frame) | Max (µs/frame) | `flyCameraTo` / 1k frames | `position` writes / 1k | `orientation` writes / 1k |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${bench.meanUs.toFixed(2)} | ${bench.p95Us.toFixed(2)} | ${bench.maxUs.toFixed(2)} | ${bench.flyWritesPer1k.toFixed(0)} | ${bench.posWritesPer1k.toFixed(0)} | ${bench.oriWritesPer1k.toFixed(0)} |`,
  ];

  if (traces.length > 0) {
    lines.push(
      '',
      '### Recorded Terrain Trace Replay Smoothness',
      '| Trace | Frames | Distance (m) | Terrain ΔAlt (m) | Max Cam Rate (°/s) | Max Cam Jerk (°/s²) |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      ...traces.map(
        (t) =>
          `| ${t.preset} | ${t.frames} | ${t.drivenM.toFixed(1)} | ${t.altSpanM.toFixed(1)} | ${t.maxCamRateDegPerSec.toFixed(1)} | ${t.maxCamJerkDegPerSec2.toFixed(0)} |`,
      ),
    );
  }

  const markdown = `${lines.join('\n')}\n`;
  console.log(markdown);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `\n${markdown}`);
  }
}

await main();
