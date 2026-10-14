/**
 * OSIRIS — data center facilities from ATLAS (data-center-map.com).
 *
 * ATLAS publishes one row per known facility. Many rows name a facility and an
 * address but carry no coordinates at all; the site places those at a state or
 * country centroid with a random spread. OSIRIS does not do that — a marker
 * goes only where the source itself put a coordinate. So a row without a real
 * fix is dropped, and what is drawn is the facility's city-level position, the
 * most precise thing ATLAS actually reports.
 *
 * The dataset is maintained by ringmast4r under
 * https://github.com/Ringmast4r/Global-Data-Center-Map and served from
 * https://data-center-map.com/api/all as `{ count, results: [...] }`.
 */

/** One row of ATLAS's `/api/all` response, as published. */
export interface AtlasRecord {
  name?: string | null;
  company?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  address?: string | null;
  /** `[latitude, longitude]`, present only when the row has a real fix. */
  city_coords?: unknown;
}

/** A facility as the map consumes it. Every field traces to the source row. */
export interface DatacenterFacility {
  id: number;
  name: string;
  /** Operating company, or null when the row names none. */
  operator: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  zip: string | null;
  /** Latitude/longitude of the facility's city, the source's own fix. */
  lat: number;
  lng: number;
  /** The precision the source reports for this fix. */
  precision: 'city';
}

export const ATLAS_SOURCE = 'ATLAS Data Center Map';
export const ATLAS_SOURCE_URL = 'https://data-center-map.com/';
export const ATLAS_DATA_URL = 'https://data-center-map.com/api/all';

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Reads `[latitude, longitude]`; null when absent, malformed or out of range. */
function coords(pair: unknown): { lat: number; lng: number } | null {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [lat, lng] = pair as unknown[];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Builds one facility, or null when the row carries no name or real fix. */
export function toFacility(record: AtlasRecord, id: number): DatacenterFacility | null {
  const name = text(record.name);
  const fix = coords(record.city_coords);
  if (!name || !fix) return null;

  return {
    id,
    name,
    operator: text(record.company),
    city: text(record.city),
    state: text(record.state),
    country: text(record.country),
    address: text(record.address),
    zip: text(record.zip),
    lat: fix.lat,
    lng: fix.lng,
    precision: 'city',
  };
}

/**
 * Parses an ATLAS `/api/all` payload into de-duplicated facilities.
 *
 * Accepts either the `{ results }` envelope or a bare array. Duplicates — the
 * same name, city, country and address listed twice — collapse to one site;
 * order follows the source so identical input yields identical output.
 */
export function parseFacilities(raw: unknown): DatacenterFacility[] {
  const results = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { results?: unknown }).results
    : raw;
  if (!Array.isArray(results)) return [];

  const seen = new Set<string>();
  const facilities: DatacenterFacility[] = [];

  results.forEach((record, index) => {
    if (!record || typeof record !== 'object') return;
    const facility = toFacility(record as AtlasRecord, index);
    if (!facility) return;

    const key = [facility.name, facility.city, facility.country, facility.address]
      .map(part => (part ?? '').toLowerCase())
      .join('|');
    if (seen.has(key)) return;
    seen.add(key);
    facilities.push(facility);
  });

  return facilities;
}
