import { describe, it, expect, vi, afterEach } from 'vitest';
import * as h3 from 'h3-js';

/* The upstream is two plain files on gpsjam.org. They are faked here so the
   test pins the parts that are actually ours: which day is chosen, how the CSV
   is turned into H3 rings, and GPSJAM's own severity formula. */

const MANIFEST = `date,suspect,num_bad_aircraft_hexes,source
2026-10-11,false,529,merged
2026-10-13,true,513,merged
2026-10-12,false,561,merged`;

/* Two hexes carry interference, two do not: bad<2 is below GPSJAM's denoiser
   floor, and (1000,2) rounds to 0%. */
const HEATMAP = `hex,count_good_aircraft,count_bad_aircraft
84daaa1ffffffff,12,3
84daaa5ffffffff,89,11
8400cd7ffffffff,1000,2
8401227ffffffff,5,1`;

type Reply = { ok: boolean; status?: number; text: () => Promise<string> };
type Cell = { severity: number; low: number; total: number; vertices: [number, number][] };
type Body = { date: string | null; cells: Cell[]; total: number; source: string; attribution: string };

/** Routes manifest and heatmap requests; anything else is a miss. */
function stubFetch(handler: (url: string) => Reply | Promise<Reply>) {
  const fn = vi.fn(async (url: string | URL) => handler(String(url)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const serveFiles = (manifest = MANIFEST, heatmap = HEATMAP) =>
  stubFetch((url) => {
    if (url.endsWith('/manifest.csv')) return { ok: true, status: 200, text: async () => manifest };
    if (url.endsWith('-h3_4.csv')) return { ok: true, status: 200, text: async () => heatmap };
    return { ok: false, status: 404, text: async () => '' };
  });

async function load(): Promise<Body> {
  vi.resetModules();
  const { GET } = await import('./route');
  return (await GET()).json();
}

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/gps-jamming', () => {
  it('picks the newest day that is not flagged suspect', async () => {
    serveFiles();
    const body = await load();

    // 2026-10-13 is newer but suspect, so the 12th is the honest answer.
    expect(body.date).toBe('2026-10-12');
    expect(body.total).toBe(2);
    expect(body.source).toContain('GPSJAM');
  });

  it('reads the merged H3 res-4 file for that day', async () => {
    const fetchMock = serveFiles();
    await load();

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls).toContain('https://gpsjam.org/data/merged/manifest.csv');
    expect(urls).toContain('https://gpsjam.org/data/merged/2026-10-12-h3_4.csv');
    expect(urls.some(u => u.includes('2026-10-13'))).toBe(false);
  });

  it('applies GPSJAM’s denoising formula: 100·(bad−1)/(good+bad)', async () => {
    serveFiles();
    const { cells } = await load();

    // 3 bad of 15 → round(100·2/15) = 13; 11 bad of 100 → round(100·10/100) = 10.
    expect(cells.map(c => c.severity)).toEqual([13, 10]);
    expect(cells[0]).toMatchObject({ severity: 13, low: 3, total: 15 });
  });

  it('leaves out hexes that report no interference', async () => {
    serveFiles();
    const { cells } = await load();

    // (1000,2) rounds to 0%, and (5,1) is below the bad<2 floor.
    expect(cells).toHaveLength(2);
    expect(cells.some(c => c.total === 1002)).toBe(false);
    expect(cells.some(c => c.low === 1)).toBe(false);
  });

  it('draws closed GeoJSON rings in [lng, lat] order', async () => {
    serveFiles();
    const { cells } = await load();

    const ring = cells[0].vertices;
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lng, lat] of ring) {
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
    }
    // h3's GeoJSON form is already [lng, lat]; the ring must not swap it back.
    const [lng, lat] = h3.cellToBoundary('84daaa1ffffffff', true)[0];
    expect(ring[0][0]).toBeCloseTo(lng, 3);
    expect(ring[0][1]).toBeCloseTo(lat, 3);
  });

  it('carries the required attribution', async () => {
    serveFiles();
    const body = await load();

    expect(body.attribution).toContain('airplanes.live');
    expect(body.attribution).toContain('ADS-B Exchange');
  });

  it('walks back from today when the manifest is unreachable', async () => {
    stubFetch((url) =>
      url.endsWith('/manifest.csv')
        ? { ok: false, status: 404, text: async () => '' }
        : { ok: true, status: 200, text: async () => HEATMAP },
    );
    const body = await load();

    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.cells).toHaveLength(2);
  });

  it('answers an empty set rather than failing when nothing is published', async () => {
    stubFetch(() => {
      throw new Error('network down');
    });
    const body = await load();

    expect(body.date).toBeNull();
    expect(body.cells).toEqual([]);
    expect(body.total).toBe(0);
  });
});
