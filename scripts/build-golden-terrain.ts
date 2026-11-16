import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { degToRad, offsetToLatLng } from '../src/math3d.ts';
import type { GoldenTerrainPoint, GoldenTerrainProfile } from '../src/trace-types.ts';
import type { TruckStart } from '../src/truck.ts';

// Offline generator for compact bare-earth golden terrain profiles used ONLY by
// unit/regression tests in testdata/terrain/*.json (never imported by src/ runtime).
// Tile source: AWS Open Data Terrain Tiles (Mapzen Terrarium 256x256 PNG encoding:
// elevation_m = R * 256 + G + B / 256 - 32768).

const TILE_SIZE = 256;
const ZOOM = 14;
const SPACING_M = 8;
const POINT_COUNT = 201; // 200 intervals * 8 m = 1,600 m
const TERRARIUM_URL_TEMPLATE =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SOURCE_LABEL = `AWS Open Data Terrain Tiles (Mapzen Terrarium z=${ZOOM}, bilinear)`;

interface ProfileSpec {
  filename: string;
  name: string;
  description: string;
  start: TruckStart;
}

const PROFILES: readonly ProfileSpec[] = [
  {
    filename: 'whistler.json',
    name: 'Whistler',
    description: 'Steep mountain ridge and alpine descent along Whistler preset heading',
    start: { lat: 50.085734, lng: -122.855824, heading: 220 },
  },
  {
    filename: 'sf-hills.json',
    name: 'San Francisco Hills',
    description: 'San Francisco Nob Hill and Russian Hill corridor heading north',
    start: { lat: 37.7845, lng: -122.4126, heading: 351 },
  },
  {
    filename: 'everest.json',
    name: 'Mt. Everest',
    description: 'Extreme Himalayan ridge slope along Everest preset heading',
    start: { lat: 27.991283, lng: 86.92434, heading: 70 },
  },
];

interface DecodedPng {
  width: number;
  height: number;
  bpp: number;
  pixels: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(buf: Uint8Array): DecodedPng {
  if (buf.length < 33) throw new Error('PNG buffer too small');
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error('Invalid PNG signature');
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      buf[offset + 4]!,
      buf[offset + 5]!,
      buf[offset + 6]!,
      buf[offset + 7]!,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new Error(`Truncated PNG chunk ${type}`);

    if (type === 'IHDR') {
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = buf[dataStart + 8]!;
      colorType = buf[dataStart + 9]!;
      const compression = buf[dataStart + 10]!;
      const filter = buf[dataStart + 11]!;
      const interlace = buf[dataStart + 12]!;
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error(
          `Unsupported PNG format (depth=${bitDepth}, comp=${compression}, filter=${filter}, interlace=${interlace})`,
        );
      }
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`Unsupported PNG colorType=${colorType} (expected RGB=2 or RGBA=6)`);
      }
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || idatChunks.length === 0) {
    throw new Error('Missing PNG IHDR or IDAT chunks');
  }

  const bpp = colorType === 6 ? 4 : 3;
  const totalCompressed = idatChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const compressed = new Uint8Array(totalCompressed);
  let writePos = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, writePos);
    writePos += chunk.byteLength;
  }

  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * bpp;
  if (raw.length < height * (1 + stride)) {
    throw new Error(`Inflated PNG too short: got ${raw.length}, expected ${height * (1 + stride)}`);
  }

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const rawRowStart = y * (1 + stride);
    const filterType = raw[rawRowStart]!;
    const curRowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawRowStart + 1 + x]!;
      const a = x >= bpp ? pixels[curRowStart + x - bpp]! : 0;
      const b = y > 0 ? pixels[prevRowStart + x]! : 0;
      const c = x >= bpp && y > 0 ? pixels[prevRowStart + x - bpp]! : 0;

      let recon: number;
      switch (filterType) {
        case 0:
          recon = rawByte;
          break;
        case 1:
          recon = (rawByte + a) & 0xff;
          break;
        case 2:
          recon = (rawByte + b) & 0xff;
          break;
        case 3:
          recon = (rawByte + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          recon = (rawByte + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Invalid PNG filter type ${filterType} on row ${y}`);
      }
      pixels[curRowStart + x] = recon;
    }
  }

  return { width, height, bpp, pixels };
}

class TerrariumSampler {
  private readonly cache = new Map<string, DecodedPng>();

  private async getTile(z: number, x: number, y: number): Promise<DecodedPng> {
    const key = `${z}/${x}/${y}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    const url = TERRARIUM_URL_TEMPLATE.replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch Terrarium tile ${key}: HTTP ${resp.status}`);
    }
    const decoded = decodePng(new Uint8Array(await resp.arrayBuffer()));
    if (decoded.width !== TILE_SIZE || decoded.height !== TILE_SIZE) {
      throw new Error(`Unexpected tile dimensions ${decoded.width}x${decoded.height} for ${key}`);
    }
    this.cache.set(key, decoded);
    return decoded;
  }

  private async sampleGlobalPixel(z: number, gx: number, gy: number): Promise<number> {
    const worldPx = (1 << z) * TILE_SIZE;
    const wx = ((gx % worldPx) + worldPx) % worldPx;
    const wy = Math.max(0, Math.min(worldPx - 1, gy));
    const tileX = Math.floor(wx / TILE_SIZE);
    const tileY = Math.floor(wy / TILE_SIZE);
    const lx = wx - tileX * TILE_SIZE;
    const ly = wy - tileY * TILE_SIZE;

    const tile = await this.getTile(z, tileX, tileY);
    const idx = (ly * tile.width + lx) * tile.bpp;
    const r = tile.pixels[idx]!;
    const g = tile.pixels[idx + 1]!;
    const b = tile.pixels[idx + 2]!;
    return r * 256 + g + b / 256 - 32768;
  }

  async elevationMeters(lat: number, lng: number, z = ZOOM): Promise<number> {
    const n = 1 << z;
    const fx = ((lng + 180) / 360) * n * TILE_SIZE;
    const latRad = degToRad(lat);
    const fy =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * TILE_SIZE;

    const gx = fx - 0.5;
    const gy = fy - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;

    const [z00, z10, z01, z11] = await Promise.all([
      this.sampleGlobalPixel(z, x0, y0),
      this.sampleGlobalPixel(z, x0 + 1, y0),
      this.sampleGlobalPixel(z, x0, y0 + 1),
      this.sampleGlobalPixel(z, x0 + 1, y0 + 1),
    ]);

    const top = z00 * (1 - tx) + z10 * tx;
    const bottom = z01 * (1 - tx) + z11 * tx;
    return top * (1 - ty) + bottom * ty;
  }
}

function round7(v: number): number {
  return Math.round(v * 1e7) / 1e7;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function formatCompactProfileJson(profile: GoldenTerrainProfile): string {
  const header = {
    name: profile.name,
    description: profile.description,
    source: profile.source,
    start: profile.start,
    spacingM: profile.spacingM,
    totalLengthM: profile.totalLengthM,
  };
  const headerLines = JSON.stringify(header, null, 2).split('\n');
  // Remove closing brace and append points array with one point per line for ~15 KB files and clean diffs.
  headerLines.pop();
  headerLines[headerLines.length - 1] += ',';
  const pointLines = profile.points.map(
    (pt, idx) => `    ${JSON.stringify(pt)}${idx < profile.points.length - 1 ? ',' : ''}`,
  );
  return `${headerLines.join('\n')}\n  "points": [\n${pointLines.join('\n')}\n  ]\n}\n`;
}

function validateAndSummarize(profile: GoldenTerrainProfile) {
  if (profile.points.length !== POINT_COUNT) {
    throw new Error(`${profile.name}: expected ${POINT_COUNT} points, got ${profile.points.length}`);
  }
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  let ascent = 0;
  let descent = 0;
  let maxStep = 0;

  for (let i = 0; i < profile.points.length; i++) {
    const pt = profile.points[i]!;
    if (
      !Number.isFinite(pt.distM) ||
      !Number.isFinite(pt.lat) ||
      !Number.isFinite(pt.lng) ||
      !Number.isFinite(pt.altitudeM)
    ) {
      throw new Error(`${profile.name}: non-finite value at index ${i}`);
    }
    if (pt.altitudeM < -500 || pt.altitudeM > 9000) {
      throw new Error(`${profile.name}: out-of-range altitude ${pt.altitudeM}m at index ${i}`);
    }
    if (pt.altitudeM < minAlt) minAlt = pt.altitudeM;
    if (pt.altitudeM > maxAlt) maxAlt = pt.altitudeM;

    if (i > 0) {
      const prev = profile.points[i - 1]!;
      if (pt.distM <= prev.distM) {
        throw new Error(`${profile.name}: non-monotonic distM at index ${i}`);
      }
      const dAlt = pt.altitudeM - prev.altitudeM;
      if (dAlt > 0) ascent += dAlt;
      else descent += -dAlt;
      const absStep = Math.abs(dAlt);
      if (absStep > maxStep) maxStep = absStep;
      if (absStep > 50) {
        throw new Error(`${profile.name}: suspicious ${absStep.toFixed(2)}m step at index ${i}`);
      }
    }
  }

  const maxSlopeDeg = (Math.atan2(maxStep, profile.spacingM) * 180) / Math.PI;
  return {
    minAlt,
    maxAlt,
    span: maxAlt - minAlt,
    ascent,
    descent,
    maxStep,
    maxSlopeDeg,
  };
}

async function buildProfile(
  sampler: TerrariumSampler,
  spec: ProfileSpec,
): Promise<GoldenTerrainProfile> {
  const hRad = degToRad(spec.start.heading);
  const stepE = Math.sin(hRad) * SPACING_M;
  const stepN = Math.cos(hRad) * SPACING_M;

  const points: GoldenTerrainPoint[] = [];
  let lat = spec.start.lat;
  let lng = spec.start.lng;

  for (let i = 0; i < POINT_COUNT; i++) {
    const alt = await sampler.elevationMeters(lat, lng);
    points.push({
      distM: i * SPACING_M,
      lat: round7(lat),
      lng: round7(lng),
      altitudeM: round2(alt),
    });
    const next = offsetToLatLng(lat, lng, stepE, stepN);
    lat = next.lat;
    lng = next.lng;
  }

  return {
    name: spec.name,
    description: spec.description,
    source: SOURCE_LABEL,
    start: spec.start,
    spacingM: SPACING_M,
    totalLengthM: (POINT_COUNT - 1) * SPACING_M,
    points,
  };
}

async function main(): Promise<void> {
  const outDir = join(process.cwd(), 'testdata', 'terrain');
  mkdirSync(outDir, { recursive: true });

  const sampler = new TerrariumSampler();
  const rows: string[] = [];

  for (const spec of PROFILES) {
    const profile = await buildProfile(sampler, spec);
    const stats = validateAndSummarize(profile);
    const outPath = join(outDir, spec.filename);
    writeFileSync(outPath, formatCompactProfileJson(profile));
    const kb = statSync(outPath).size / 1024;

    rows.push(
      `| \`${spec.filename}\` | ${profile.points.length} | ${stats.minAlt.toFixed(1)} | ${stats.maxAlt.toFixed(1)} | ${stats.span.toFixed(1)} | +${stats.ascent.toFixed(1)} / -${stats.descent.toFixed(1)} | ${stats.maxStep.toFixed(2)} | ${stats.maxSlopeDeg.toFixed(1)} | ${kb.toFixed(1)} KB |`,
    );
  }

  console.log(
    [
      'Generated golden terrain elevation profiles:',
      '',
      '| File | Points | Min Alt (m) | Max Alt (m) | Span (m) | +Ascent / -Descent (m) | Max Step (m) | Max Slope (°) | Size |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...rows,
    ].join('\n'),
  );
}

await main();
