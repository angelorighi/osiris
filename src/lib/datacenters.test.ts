import { describe, it, expect } from 'vitest';
import { parseFacilities, toFacility } from './datacenters';

/** The shape `/api/all` returns for a row that carries a real fix. */
const MADRID = {
  name: 'NAP de las Americas Madrid',
  company: 'Terremark',
  street: 'Calle de Yecora, 4',
  city: 'Madrid',
  state: '',
  zip: '28009',
  country: 'Spain',
  address: 'Calle de Yecora, 4 28009 Madrid Spain',
  city_coords: [40.4168, -3.7038],
};

/** The shape of a row with no coordinates — the majority of the dataset. */
const DOHA_NO_FIX = {
  name: 'Qatar National Bank',
  company: 'Qatar National Bank (QNB)',
  street: 'Arab League St',
  city: 'Doha',
  state: '',
  zip: '',
  country: 'Qatar',
  address: 'Arab League St Doha Qatar',
};

describe('parseFacilities', () => {
  it('maps an ATLAS row to the fields the map reads', () => {
    const [facility] = parseFacilities({ count: 1, results: [MADRID] });

    expect(facility).toEqual({
      id: 0,
      name: 'NAP de las Americas Madrid',
      operator: 'Terremark',
      city: 'Madrid',
      state: null,
      country: 'Spain',
      address: 'Calle de Yecora, 4 28009 Madrid Spain',
      zip: '28009',
      lat: 40.4168,
      lng: -3.7038,
      precision: 'city',
    });
  });

  it('discards rows with no coordinates rather than inventing a position', () => {
    const facilities = parseFacilities({ count: 2, results: [MADRID, DOHA_NO_FIX] });

    expect(facilities.map(f => f.name)).toEqual(['NAP de las Americas Madrid']);
  });

  it('rejects malformed or out-of-range coordinates', () => {
    expect(toFacility({ ...MADRID, city_coords: ['40.4', '-3.7'] }, 0)).toBeNull();
    expect(toFacility({ ...MADRID, city_coords: [40.4] }, 0)).toBeNull();
    expect(toFacility({ ...MADRID, city_coords: [120, -3.7] }, 0)).toBeNull();
    expect(toFacility({ ...MADRID, city_coords: [40.4, 200] }, 0)).toBeNull();
    expect(toFacility({ ...MADRID, city_coords: [NaN, -3.7] }, 0)).toBeNull();
  });

  it('counts a facility listed twice once, keeping source order', () => {
    const facilities = parseFacilities({ results: [MADRID, { ...MADRID }, { ...MADRID, name: 'Second site' }] });

    expect(facilities.map(f => f.name)).toEqual(['NAP de las Americas Madrid', 'Second site']);
  });

  it('accepts a bare array as well as the results envelope', () => {
    expect(parseFacilities([MADRID])).toHaveLength(1);
    expect(parseFacilities({ results: [MADRID] })).toHaveLength(1);
  });

  it('returns nothing for a payload that is not a facility list', () => {
    expect(parseFacilities(null)).toEqual([]);
    expect(parseFacilities({ count: 0 })).toEqual([]);
    expect(parseFacilities('nope')).toEqual([]);
  });
});
