import { describe, expect, test } from 'bun:test';
import { PRESETS } from './config.ts';
import {
  browserUrlHistoryTarget,
  createUrlStateSync,
  defaultUrlViewState,
  formatUrlHash,
  hasPoseChangedForUrl,
  parseUrlHash,
  type UrlHistoryTarget,
} from './url-state.ts';

function createFakeHistoryTarget(initial = { pathname: '/', search: '', hash: '' }): {
  target: UrlHistoryTarget;
  writes: string[];
} {
  let pathname = initial.pathname;
  let search = initial.search;
  let hash = initial.hash;
  const writes: string[] = [];

  return {
    writes,
    target: {
      get pathname() {
        return pathname;
      },
      get search() {
        return search;
      },
      get hash() {
        return hash;
      },
      replaceHash(url: string) {
        writes.push(url);
        const parsed = new URL(url, 'https://example.com');
        pathname = parsed.pathname;
        search = parsed.search;
        hash = parsed.hash;
      },
    },
  };
}

describe('url-state', () => {
  test('parseUrlHash returns PRESETS[0] and SATELLITE when hash is empty', () => {
    const start = PRESETS[0]!;
    expect(parseUrlHash('')).toEqual({
      lat: start.lat,
      lng: start.lng,
      heading: start.heading,
      mode: 'SATELLITE',
    });
    expect(parseUrlHash('#')).toEqual({
      lat: start.lat,
      lng: start.lng,
      heading: start.heading,
      mode: 'SATELLITE',
    });
  });

  test('parseUrlHash parses full lat, lng, heading, and case-insensitive mode', () => {
    expect(parseUrlHash('#lat=37.774900&lng=-122.419400&heading=180&mode=roadmap')).toEqual({
      lat: 37.7749,
      lng: -122.4194,
      heading: 180,
      mode: 'ROADMAP',
    });

    expect(parseUrlHash('#lat=-33.856784&lng=151.215297&heading=-90&mode=SATELLITE')).toEqual({
      lat: -33.856784,
      lng: 151.215297,
      heading: 270,
      mode: 'SATELLITE',
    });
  });

  test('parseUrlHash supports partial hashes and defaults heading to 0 for custom coordinates', () => {
    const start = PRESETS[0]!;

    // Coordinates without heading or mode default to heading 0 and SATELLITE
    expect(parseUrlHash('#lat=36.0544&lng=-112.1401')).toEqual({
      lat: 36.0544,
      lng: -112.1401,
      heading: 0,
      mode: 'SATELLITE',
    });

    // Mode-only hash preserves fallback location and heading
    expect(parseUrlHash('#mode=roadmap')).toEqual({
      lat: start.lat,
      lng: start.lng,
      heading: start.heading,
      mode: 'ROADMAP',
    });

    // Heading-only hash updates heading while preserving fallback coordinates
    expect(parseUrlHash('#heading=225')).toEqual({
      lat: start.lat,
      lng: start.lng,
      heading: 225,
      mode: 'SATELLITE',
    });
  });

  test('parseUrlHash rejects malformed, incomplete, or out-of-range parameters cleanly', () => {
    const fallback = defaultUrlViewState();

    // Out-of-bounds latitude or longitude falls back to default coordinates
    expect(parseUrlHash('#lat=91&lng=-122.4&heading=45&mode=roadmap')).toEqual({
      lat: fallback.lat,
      lng: fallback.lng,
      heading: 45,
      mode: 'ROADMAP',
    });
    expect(parseUrlHash('#lat=37.7&lng=-181')).toEqual(fallback);

    // Incomplete coordinate pair (missing lng) or empty/NaN values fall back cleanly
    expect(parseUrlHash('#lat=37.7749')).toEqual(fallback);
    expect(parseUrlHash('#lat=&lng=&heading=&mode=unknown')).toEqual(fallback);
    expect(parseUrlHash('#lat=abc&lng=def&heading=NaN&mode=hybrid')).toEqual(fallback);
  });

  test('formatUrlHash formats 6-decimal coords, integer [0, 360) compass headings, and avoids -0', () => {
    expect(
      formatUrlHash({
        lat: 37.7749,
        lng: -122.4194,
        heading: -180,
        mode: 'ROADMAP',
      }),
    ).toBe('#lat=37.774900&lng=-122.419400&heading=180&mode=roadmap');

    expect(
      formatUrlHash({
        lat: -0.0000001,
        lng: -0,
        heading: 359.7,
        mode: 'SATELLITE',
      }),
    ).toBe('#lat=0.000000&lng=0.000000&heading=0&mode=satellite');

    expect(
      formatUrlHash({
        lat: 50.085734,
        lng: -122.855824,
        heading: -140,
        mode: 'SATELLITE',
      }),
    ).toBe('#lat=50.085734&lng=-122.855824&heading=220&mode=satellite');
  });

  test('hasPoseChangedForUrl compares coordinates and wrapped angles across 0/360 and +-180 seams', () => {
    const base = { lat: 37.7749, lng: -122.4194, heading: -140 };
    // Equivalent compass angle (220 deg == -140 deg) and sub-micrometer jitter
    expect(hasPoseChangedForUrl(base, { lat: 37.7749004, lng: -122.4194004, heading: 220 })).toBe(
      false,
    );
    expect(hasPoseChangedForUrl({ lat: 0, lng: 0, heading: 359.8 }, { lat: 0, lng: 0, heading: 0.1 })).toBe(
      false,
    );
    expect(hasPoseChangedForUrl(base, { ...base, lat: 37.775 })).toBe(true);
    expect(hasPoseChangedForUrl(base, { ...base, heading: 222 })).toBe(true);
  });

  test('createUrlStateSync throttles driving updates to 1s, flushes immediately on stop/teleport/mode, and preserves query params', () => {
    let nowMs = 0;
    const { target, writes } = createFakeHistoryTarget({
      pathname: '/monster-milktruck/',
      search: '?utm_source=share',
      hash: '',
    });

    const sync = createUrlStateSync({
      initialState: {
        lat: 37.423501,
        lng: -122.086744,
        heading: 90,
        mode: 'SATELLITE',
      },
      target,
      now: () => nowMs,
      throttleMs: 1000,
    });

    // Boot flush writes initial state while preserving pathname and ?utm_source=share
    sync.flush();
    expect(writes).toEqual([
      '/monster-milktruck/?utm_source=share#lat=37.423501&lng=-122.086744&heading=90&mode=satellite',
    ]);

    // Duplicate flush with unchanged state is a no-op
    sync.flush();
    expect(writes).toHaveLength(1);

    // Driving frames within 1000ms window are throttled
    for (let i = 1; i <= 50; i++) {
      nowMs = i * 16; // up to 800ms
      sync.updatePose({ lat: 37.423501, lng: -122.086744 + i * 0.00001, heading: 90 }, false);
    }
    expect(writes).toHaveLength(1);

    // Crossing the 1000ms threshold writes once
    nowMs = 1005;
    sync.updatePose({ lat: 37.423501, lng: -122.0861, heading: 92 }, false);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(
      '/monster-milktruck/?utm_source=share#lat=37.423501&lng=-122.086100&heading=92&mode=satellite',
    );

    // Coming to rest at 1350ms (inside next throttle window) flushes immediately
    nowMs = 1350;
    sync.updatePose({ lat: 37.423501, lng: -122.0858, heading: 95 }, true);
    expect(writes).toHaveLength(3);
    expect(writes[2]).toBe(
      '/monster-milktruck/?utm_source=share#lat=37.423501&lng=-122.085800&heading=95&mode=satellite',
    );

    // Changing map mode at 1400ms flushes immediately
    nowMs = 1400;
    sync.setMode('ROADMAP');
    expect(writes).toHaveLength(4);
    expect(writes[3]).toBe(
      '/monster-milktruck/?utm_source=share#lat=37.423501&lng=-122.085800&heading=95&mode=roadmap',
    );
  });

  test('createUrlStateSync avoids redundant replaceState on boot when browser hash already matches', () => {
    const { target, writes } = createFakeHistoryTarget({
      pathname: '/',
      search: '',
      hash: '#lat=37.423501&lng=-122.086744&heading=90&mode=satellite',
    });

    const sync = createUrlStateSync({
      initialState: {
        lat: 37.423501,
        lng: -122.086744,
        heading: 90,
        mode: 'SATELLITE',
      },
      target,
      now: () => 100,
    });

    sync.flush();
    expect(writes).toHaveLength(0);
    expect(sync.getLastHash()).toBe('#lat=37.423501&lng=-122.086744&heading=90&mode=satellite');
  });

  test('browserUrlHistoryTarget swallows SecurityError from restricted history.replaceState', () => {
    const fakeWin = {
      location: { pathname: '/', search: '', hash: '' },
      history: {
        replaceState() {
          throw new DOMException('Blocked', 'SecurityError');
        },
      },
    } as unknown as Window;

    const target = browserUrlHistoryTarget(fakeWin);
    expect(() => target.replaceHash('/#lat=0.000000&lng=0.000000&heading=0&mode=satellite')).not.toThrow();
  });
});
