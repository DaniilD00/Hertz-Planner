import { describe, expect, it } from 'vitest';
// @ts-ignore plain JS server modules
import { geoKey } from '../server/geo.mjs';
// @ts-ignore
import { parseDrive4Free, townFromAddress } from '../server/providers/drive4free.mjs';
// @ts-ignore
import { parseDriveBack } from '../server/providers/driveback.mjs';
// @ts-ignore
import { parseHertz } from '../server/providers/hertz.mjs';
// @ts-ignore
import { tidyCase, wallTimeAsStockholm } from '../server/util.mjs';

import drive4freeRaw from './fixtures/drive4free.json?raw';
import drivebackRaw from './fixtures/driveback.json?raw';

const FIXTURES: Record<string, string> = { 'drive4free.json': drive4freeRaw, 'driveback.json': drivebackRaw };
const fixture = (name: string) => JSON.parse(FIXTURES[name]);

// Stand-in for the address lookup: known towns get fixed coordinates, everything else is "not found".
const TOWNS: Record<string, [number, number]> = {
  kareby: [57.93, 11.92],
  västerås: [59.61, 16.55],
  halmstad: [56.67, 12.86],
  malmö: [55.6, 13.0],
  göteborg: [57.7, 11.97],
  stockholm: [59.33, 18.07],
  karlstad: [59.38, 13.5],
  lund: [55.7, 13.19],
  helsingborg: [56.05, 12.69],
  arlandastad: [59.6, 17.89],
  falkenberg: [56.9, 12.49],
  svalöv: [55.91, 13.1],
  luleå: [65.58, 22.15],
  umeå: [63.83, 20.26],
};
function makeLocate() {
  const calls: { text: string; town: string | null; near: { lat: number; lon: number } | null }[] = [];
  const locate = async ({ text, town = null, near = null }: { text: string; town?: string | null; near?: { lat: number; lon: number } | null }) => {
    calls.push({ text, town, near });
    const t = (town || text).toLowerCase();
    const hit = TOWNS[t] ?? Object.entries(TOWNS).find(([k]) => text.toLowerCase().includes(k))?.[1];
    if (hit) return { lat: hit[0], lon: hit[1], precision: town && TOWNS[t] ? 'address' : 'town', city: town };
    return near ? { lat: near.lat, lon: near.lon, precision: 'town', city: town } : null;
  };
  return { locate, calls };
}

describe('time conventions', () => {
  it('reads DriveBack times as Swedish wall-clock time, across the switch to winter time', () => {
    expect(wallTimeAsStockholm('2026-10-19T13:00:00.000Z')).toBe('2026-10-19T11:00:00.000Z'); // CEST, UTC+2
    expect(wallTimeAsStockholm('2026-10-29T00:00:00.000Z')).toBe('2026-10-28T23:00:00.000Z'); // CET, UTC+1
    expect(wallTimeAsStockholm('nonsense')).toBeNull();
  });
  it('tidies shouting text only', () => {
    expect(tidyCase('THOMSONS VÄG 1')).toBe('Thomsons Väg 1');
    expect(tidyCase('MALMÖ')).toBe('Malmö');
    expect(tidyCase('Lokgatan 9C')).toBe('Lokgatan 9C');
  });
  it('road keys contain no commas (they travel in a comma-separated list)', () => {
    expect(geoKey({ lat: 57.77801, lon: 14.1855 }, { lat: 57.66829, lon: 12.29707 })).toBe('57.7780/14.1855>57.6683/12.2971');
  });
});

describe('Hertz Freerider adapter', () => {
  const loc = (tracCode: string, lat: number, lon: number) => ({
    name: `${tracCode} / Self Service Kiosk`,
    tracCode,
    country: 'se',
    city: 'X',
    geoLat: lat,
    geoLon: lon,
    kiosk: true,
    regularOpeningHours: { 1: { openingTime: '1970-01-01T07:00:00', closingTime: '1970-01-01T15:00:00' }, 6: { openingTime: null, closingTime: null } },
    infoTextLocationEnglish: 'By the entrance',
    infoTextParkingNative: 'Parkera här',
  });
  const route = (id: number, offer: number, a: ReturnType<typeof loc>, b: ReturnType<typeof loc>) => ({
    id,
    transportOfferId: offer,
    pickupLocation: a,
    returnLocation: b,
    distance: 180,
    originalDistance: 149.6,
    travelTime: 150,
    originalTravelTime: 118,
    availableAt: '2026-10-19T10:00:00',
    latestReturn: '2026-10-22T21:59:00',
    expireTime: '2026-10-22T17:50:00',
    carModel: 'VOLVO XC40 B3 FWD AUT PLUS DAR',
    publicDescription: '***SOMMARDÄCK***',
    publicInformation: '',
  });
  const A = loc('SWJKG61', 57.778, 14.1855);
  const B = loc('SWGOT50', 57.668, 12.297);
  const out = parseHertz([{ routes: [route(1, 10, A, B), route(2, 10, A, B), route(1, 10, A, B)] }, { routes: [{ id: 3, pickupLocation: { tracCode: 'X' } }] }]);

  it('converts trips to the common format with UTC times', () => {
    expect(out.offers).toHaveLength(2); // duplicate id 1 and the broken route are dropped
    const o = out.offers[0];
    expect(o).toMatchObject({ provider: 'hertz', id: 'hertz:1', offerId: 'hertz:10', from: 'hertz:SWJKG61', to: 'hertz:SWGOT50', maxKm: 180, estKm: 150, maxMin: 150, estMin: 118 });
    expect(o.availableFrom).toBe('2026-10-19T10:00:00.000Z');
    expect(o.returnBy).toBe('2026-10-22T21:59:00.000Z');
    expect(o.notes).toEqual(['***SOMMARDÄCK***']);
  });

  it('keeps exact station positions, opening hours as Hertz shows them and the old road key', () => {
    const s = out.stations['hertz:SWJKG61'];
    expect(s).toMatchObject({ precision: 'exact', legacy: 'SWJKG61', lat: 57.778, kiosk: true });
    expect(s.hours[0]).toEqual(['08:00', '16:00']); // stored 07:00 shows as 08:00, like hertzfreerider.se
    expect(s.hours[5]).toBeNull();
    expect(s.info).toMatchObject({ location: 'By the entrance', parking: 'Parkera här' });
  });
});

describe('Drive4Free adapter (real feed, 22 Oct 2026)', () => {
  it('guesses the town in free-text addresses', () => {
    expect(townFromAddress('Prästvägen 105, 44293 Kareby,')).toBe('Kareby');
    expect(townFromAddress('Knuts väg 14 Skepplanda 446 41 Göteborg')).toBe('Göteborg');
    expect(townFromAddress('Krukmakargatan 9 Södermalm Stockholm')).toBe('Stockholm');
    expect(townFromAddress('Västerås')).toBe('Västerås');
  });

  it('places every trip and keeps the pickup window', async () => {
    const { locate } = makeLocate();
    const out = await parseDrive4Free(fixture('drive4free.json'), locate);
    expect(out.offers).toHaveLength(3);
    expect(out.unplaced).toBe(0);
    const yaris = out.offers.find((o: { model: string }) => o.model.startsWith('Toyota Yaris'));
    expect(yaris).toMatchObject({ provider: 'drive4free', transmission: 'Manual', availableFrom: '2026-10-22T10:00:00.000Z', offerExpires: '2026-10-25T14:00:00.000Z', returnBy: null, bookUrl: 'https://app.drive4free.io/login' });
    const raw4 = out.offers.find((o: { model: string }) => o.model === 'RAW4 Toyota');
    expect(raw4.transmission).toBe('Automatic');
    const from = out.stations[raw4.from];
    expect(from).toMatchObject({ place: 'Göteborg', address: 'Knuts väg 14 Skepplanda 446 41 Göteborg' });
  });

  it('counts trips it cannot place instead of guessing', async () => {
    const out = await parseDrive4Free(fixture('drive4free.json'), async () => null);
    expect(out.offers).toHaveLength(0);
    expect(out.unplaced).toBe(3);
  });
});

describe('DriveBack adapter (real feed, 22 Oct 2026)', () => {
  it('makes one offer per destination, sharing the car between them', async () => {
    const { locate } = makeLocate();
    const out = await parseDriveBack(fixture('driveback.json'), locate);
    expect(out.offers).toHaveLength(13); // same as the 13 bookable rows on driveback.se/resor
    const sprinter = out.offers.filter((o: { offerId: string }) => o.offerId === 'driveback:9656');
    expect(sprinter).toHaveLength(4);
    expect(sprinter.map((o: { bookUrl: string }) => o.bookUrl)).toContain('https://www.driveback.se/resor/9656/boka/794');
    expect(sprinter[0]).toMatchObject({ carType: 'Lätt lastbil', model: 'Mercedes Sprinter', transmission: 'Automatic' });
    expect(sprinter[0].terms).toEqual([
      { label: 'Licence', value: 'B, held at least 1 year' },
      { label: 'Minimum age', value: '24' },
      { label: 'Deductible', value: '10\u00a0500\u00a0kr' },
      { label: 'Deposit', value: '3\u00a0000\u00a0kr' },
    ]);
  });

  it('shows the same times as driveback.se (Swedish time)', async () => {
    const { locate } = makeLocate();
    const out = await parseDriveBack(fixture('driveback.json'), locate);
    const v60 = out.offers.find((o: { id: string }) => o.id === 'driveback:9663>823');
    expect(v60.availableFrom).toBe('2026-10-19T11:00:00.000Z'); // "Hämtas tidigast 2026-10-19 13:00"
    expect(v60.offerExpires).toBe('2026-10-22T14:00:00.000Z'); // "Hämtas senast 2026-10-22 16:00"
    expect(v60.returnBy).toBeNull();
  });

  it('looks up street addresses near the town DriveBack gives, and reuses stations', async () => {
    const { locate, calls } = makeLocate();
    const out = await parseDriveBack(fixture('driveback.json'), locate);
    const arlanda = out.stations['driveback:823'];
    expect(arlanda).toMatchObject({ place: 'Arlandastad', address: 'Maskingatan 7, 19560 Arlandastad', precision: 'address' });
    expect(calls.find((c) => c.text.startsWith('Maskingatan'))?.near).toEqual({ lat: 59.32893000000001, lon: 18.06491 });
    // each station is looked up once even though several trips use it
    expect(calls.filter((c) => c.text.startsWith('Maskingatan'))).toHaveLength(1);
    expect(out.stations['driveback:1491']).toMatchObject({ address: 'Thomsons Väg 1, 213 73 Malmö', place: 'Malmö' });
  });
});
