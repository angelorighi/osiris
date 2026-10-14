import { NextResponse } from 'next/server';
import {
  parseFacilities,
  ATLAS_SOURCE,
  ATLAS_SOURCE_URL,
  ATLAS_DATA_URL,
  type DatacenterFacility,
} from '@/lib/datacenters';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — data center facilities from ATLAS (data-center-map.com).
 *
 * ATLAS publishes ~18k rows but only ~6k carry a coordinate. OSIRIS draws the
 * ones that do, at the city-level fix the source reports; the rest are dropped
 * rather than placed at an invented centroid.
 *
 * The dataset changes on the order of weeks, so it is cached for an hour. The
 * last good list is retained and served if the provider is briefly unreachable.
 */

interface DatacenterPayload {
  facilities: DatacenterFacility[];
  total: number;
  fetched_at: string;
  source: string;
  source_url: string;
  /** True when this is the last good list served during an upstream outage. */
  stale?: boolean;
}

let cached: DatacenterPayload | null = null;
/** Last successful payload. Unlike `cached` it never expires in-process, so a
 *  provider outage is survived by serving it rather than an empty list. */
let lastGood: DatacenterPayload | null = null;
let cacheTime = 0;
const CACHE_TTL = 3_600_000; // 1 h — ATLAS is updated on the order of weeks

const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' };

function empty(error: string, status?: number) {
  const body = { facilities: [], total: 0, error };
  return status
    ? NextResponse.json(body, { status, headers: CACHE_HEADERS })
    : NextResponse.json(body, { headers: CACHE_HEADERS });
}

/** The last good list when we have one, otherwise an empty feed. */
function staleOrEmpty(error: string, status?: number) {
  if (lastGood) return NextResponse.json({ ...lastGood, stale: true }, { headers: CACHE_HEADERS });
  return empty(error, status);
}

export async function GET() {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cached, { headers: CACHE_HEADERS });
  }

  try {
    const res = await fetch(ATLAS_DATA_URL, {
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
      headers: { 'User-Agent': 'OSIRIS/4.3', Accept: 'application/json' },
    });

    if (!res.ok) return staleOrEmpty('ATLAS unavailable');

    const facilities = parseFacilities(await res.json());

    const result: DatacenterPayload = {
      facilities,
      total: facilities.length,
      fetched_at: new Date().toISOString(),
      source: ATLAS_SOURCE,
      source_url: ATLAS_SOURCE_URL,
    };

    cached = result;
    lastGood = result;
    cacheTime = now;

    return NextResponse.json(result, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error('[OSIRIS] Datacenter feed error:', error);
    return staleOrEmpty('Feed unavailable', 500);
  }
}
