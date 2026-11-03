import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-ignore plain JS server module
import { createGeo } from '../server/geo.mjs';
// @ts-ignore Node built-in (types for Node aren't installed for the browser code)
import { tmpdir } from 'node:os';

type Feature = { name: string; lat: number; lon: number; key?: string; value: string; city?: string };
const f = ({ name, lat, lon, key = 'place', value, city }: Feature) => ({
  type: 'Feature',
  properties: { name, osm_key: key, osm_value: value, city, country: 'Sweden' },
  geometry: { type: 'Point', coordinates: [lon, lat] },
});

// What the stand-in place search knows
const PHOTON: Record<string, ReturnType<typeof f>[]> = {
  'göteborg': [f({ name: 'Göteborg', lat: 57.7072, lon: 11.9668, value: 'city' })],
  // a street with the same name far away comes first, as can happen with a real search
  'knuts väg 14 skepplanda 446 41 göteborg': [
    f({ name: 'Knuts väg', lat: 63.82, lon: 20.26, key: 'highway', value: 'residential', city: 'Umeå' }),
    f({ name: 'Knuts väg', lat: 57.97, lon: 12.2, key: 'highway', value: 'residential', city: 'Skepplanda' }),
  ],
  'västerås': [f({ name: 'Västerås', lat: 59.61, lon: 16.55, value: 'city' })],
  karlstad: [f({ name: 'Karlstad', lat: 59.3793, lon: 13.5036, value: 'city' })],
};

const searched: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    const q = (url.searchParams.get('q') || '').toLowerCase();
    searched.push(`${url.host}:${q}`);
    const body = url.host.includes('photon') ? { type: 'FeatureCollection', features: PHOTON[q] ?? [] } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterAll(() => vi.unstubAllGlobals());

describe('finding provider addresses on the map', () => {
  const geo = createGeo({ cacheDir: `${tmpdir()}/trip-map-geo-test-${Date.now()}`, log: { warn() {} } });

  it('finds the town first, so a same-named street elsewhere in the country is skipped', async () => {
    const r = await geo.locateAddress({ text: 'Knuts väg 14 Skepplanda 446 41 Göteborg', town: 'Göteborg' });
    expect(r).toMatchObject({ lat: 57.97, lon: 12.2, precision: 'address', city: 'Skepplanda' });
  });

  it('calls a hit on a whole town "town", not "address"', async () => {
    const r = await geo.locateAddress({ text: 'Västerås' });
    expect(r).toMatchObject({ lat: 59.61, lon: 16.55, precision: 'town' });
  });

  it('falls back to the town when the street isn’t found, and remembers the answer', async () => {
    const near = { lat: 59.3791, lon: 13.5008 };
    const r = await geo.locateAddress({ text: 'Säterivägen 24, 653 41 Karlstad', town: 'Karlstad', near, maxKm: 80 });
    expect(r).toMatchObject({ lat: 59.3793, lon: 13.5036, precision: 'town', city: 'Karlstad' });
    const before = searched.length;
    expect(await geo.locateAddress({ text: 'Säterivägen 24, 653 41 Karlstad', town: 'Karlstad', near, maxKm: 80 })).toEqual(r);
    expect(searched.length).toBe(before);
  });
}, 20000);
