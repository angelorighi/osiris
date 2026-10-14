import { NextResponse } from 'next/server';
import * as h3 from 'h3-js';

/**
 * OSIRIS — GPS Jamming API
 *
 * Daily GNSS/GPS interference heatmap from GPSJAM (gpsjam.org), built from
 * ADS-B navigation-accuracy reports over 24 h and published as an H3 res-4
 * grid. The source exposes plain files, so no scraping is involved:
 *
 *   GET /data/merged/manifest.csv            → date,suspect,num_bad_aircraft_hexes,source
 *   GET /data/merged/<YYYY-MM-DD>-h3_4.csv   → hex,count_good_aircraft,count_bad_aircraft
 *
 * `merged` unions the two feeder networks (ADS-B Exchange + airplanes.live),
 * so it carries the widest coverage. Attribution is required in the UI:
 * GPSJAM — data from airplanes.live and ADS-B Exchange.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DATA_BASE = 'https://gpsjam.org/data/merged';
const UA = 'OSIRIS/4.2';

/* GPSJAM's own formula, including its denoising term: subtracting one bad
   aircraft limits false positives in hexes only a handful of aircraft crossed.
   https://gpsjam.org/faq — "How is the percentage of bad aircraft calculated?" */
const severityOf = (good: number, bad: number) =>
  good + bad > 0 ? Math.max(0, Math.round((100 * (bad - 1)) / (good + bad))) : 0;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const p2 = (n: number) => String(n).padStart(2, '0');
const dateStr = (d: Date) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;

/** Newest non-suspect day in the manifest. Falls back to walking back from
    today when the manifest itself is unreachable. */
async function latestDate(): Promise<string | null> {
  try {
    const csv = await fetchText(`${DATA_BASE}/manifest.csv`);
    let best: string | null = null;
    for (const line of csv.split('\n').slice(1)) {
      const [date, suspect] = line.split(',');
      if (!date || suspect === 'true') continue;
      if (!best || date > best) best = date;
    }
    if (best) return best;
  } catch {
    // manifest down — fall through to date probing
  }
  for (let back = 1; back <= 4; back++) {
    const d = dateStr(new Date(Date.now() - back * 86400000));
    try {
      await fetchText(`${DATA_BASE}/${d}-h3_4.csv`, 8000);
      return d;
    } catch {
      // no file for this day
    }
  }
  return null;
}

type JamCell = { vertices: [number, number][]; severity: number; low: number; total: number };
type JamPayload = {
  date: string | null;
  cells: JamCell[];
  source: string;
  attribution: string;
  total: number;
  timestamp: string;
};

let cached: JamPayload | null = null;
let cachedAt = 0;
const CACHE_TTL = 3 * 60 * 60 * 1000; // the source is a daily snapshot

export async function GET() {
  if (cached && Date.now() - cachedAt < CACHE_TTL) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=1800' },
    });
  }

  const date = await latestDate();
  if (!date) {
    return NextResponse.json(
      { date: null, cells: [], source: 'GPSJAM (gpsjam.org)', total: 0, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=600' } },
    );
  }

  const csv = await fetchText(`${DATA_BASE}/${date}-h3_4.csv`);

  const cells: JamCell[] = [];
  const lines = csv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [hex, goodRaw, badRaw] = line.split(',');
    if (!hex) continue;
    const good = Number(goodRaw) || 0;
    const bad = Number(badRaw) || 0;
    /* bad <= 1 is the denoiser's floor. A cell that rounds to 0% reports no
       interference, so it is left off the overlay rather than painted amber. */
    if (bad < 2) continue;
    const severity = severityOf(good, bad);
    if (severity <= 0) continue;
    let boundary: [number, number][];
    try {
      /* formatAsGeoJson=true already yields [lng, lat] pairs — do not swap. */
      boundary = h3.cellToBoundary(hex, true) as [number, number][];
    } catch {
      continue; // unknown/invalid index — skip rather than fail the day
    }
    const ring: [number, number][] = boundary.map(([lng, lat]) => [round4(lng), round4(lat)]);
    if (ring.length > 2) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    }
    cells.push({ vertices: ring, severity, low: bad, total: good + bad });
  }

  cached = {
    date,
    cells,
    source: 'GPSJAM (gpsjam.org)',
    attribution: 'GPSJAM — data from airplanes.live and ADS-B Exchange',
    total: cells.length,
    timestamp: new Date().toISOString(),
  };
  cachedAt = Date.now();

  return NextResponse.json(cached, {
    headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=1800' },
  });
}
