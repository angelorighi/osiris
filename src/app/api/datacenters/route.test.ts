import { describe, it, expect, vi, afterEach } from 'vitest';

const FIXTURE = {
  count: 2,
  results: [
    {
      name: 'NAP de las Americas Madrid',
      company: 'Terremark',
      city: 'Madrid',
      state: '',
      country: 'Spain',
      address: 'Calle de Yecora, 4 28009 Madrid Spain',
      city_coords: [40.4168, -3.7038],
    },
    // No coordinates — the parser drops it rather than inventing a position.
    { name: 'Qatar National Bank', company: 'QNB', city: 'Doha', country: 'Qatar', address: 'Arab League St Doha Qatar' },
  ],
};

/**
 * The route caches for an hour, so each call here gets a fresh module —
 * otherwise a test would assert against the previous test's cached payload.
 */
async function get(body: unknown) {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));
  const { GET } = await import('./route');
  return (await GET()).json();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GET /api/datacenters', () => {
  it('reports one facility per geolocated record', async () => {
    const body = await get(FIXTURE);

    expect(body.total).toBe(1);
    expect(body.facilities).toHaveLength(1);
    expect(body.facilities[0]).toMatchObject({
      name: 'NAP de las Americas Madrid',
      operator: 'Terremark',
      city: 'Madrid',
      country: 'Spain',
      lat: 40.4168,
      lng: -3.7038,
      precision: 'city',
    });
    expect(body.source).toBe('ATLAS Data Center Map');
    expect(body.source_url).toBe('https://data-center-map.com/');
    expect(body.stale).toBeUndefined();
  });

  it('timestamps when OSIRIS polled, not an observation', async () => {
    const body = await get(FIXTURE);

    expect(body.fetched_at).toEqual(expect.any(String));
    expect(body.facilities[0]).not.toHaveProperty('fetched_at');
  });

  it('returns an empty list rather than filler when the provider fails', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => [] })));
    const { GET } = await import('./route');
    const body = await (await GET()).json();

    expect(body).toMatchObject({ facilities: [], total: 0, error: 'ATLAS unavailable' });
  });

  it('serves the last good list, not an empty one, after the provider starts failing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    let ok = true;
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => (ok
      ? { ok: true, json: async () => FIXTURE }
      : { ok: false, json: async () => [] })));
    const { GET } = await import('./route');

    expect((await (await GET()).json()).total).toBe(1);

    // Past the fresh-cache window the provider is unreachable.
    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
    ok = false;
    const body = await (await GET()).json();

    expect(body.total).toBe(1);
    expect(body.facilities).toHaveLength(1);
    expect(body.stale).toBe(true);
  });
});
