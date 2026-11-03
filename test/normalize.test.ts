import { describe, expect, it } from 'vitest';
import drivebackRaw from './fixtures/driveback.json?raw';
// @ts-ignore plain JS server modules
import { parseDriveBack } from '../server/providers/driveback.mjs';
// @ts-ignore
import { parseHertz } from '../server/providers/hertz.mjs';
import { describeCar } from '../src/carinfo';
import { applyFilters, defaultFilters, whenWindow } from '../src/filters';
import { fmtHours, fmtWhen, parseUtc, startOfDay } from '../src/format';
import { normalize, placeName, shortName, stationHeading, stationLabel } from '../src/normalize';
import type { RoutesResponse } from '../src/types';

// Hertz-shaped raw data, run through the real server adapter so these tests cover adapter + browser model together
const hours = { openingTime: '1970-01-01T07:00:00', closingTime: '1970-01-01T15:00:00' };
const loc = (tracCode: string, name: string, lat: number, lon: number, country = 'se') => ({
  name,
  tracCode,
  country,
  city: name.split(' ')[0],
  geoLat: lat,
  geoLon: lon,
  kiosk: true,
  regularOpeningHours: { 1: hours, 2: hours, 3: hours, 4: hours, 5: hours, 6: { openingTime: null, closingTime: null }, 7: { openingTime: null, closingTime: null } },
});
type Loc = ReturnType<typeof loc>;

const JKG = loc('SWJKG61', 'Jönköping NybergsBil / Self Service Kiosk', 57.778, 14.1855);
const GOT = loc('SWGOT50', 'Göteborg Landvetter Flygplats / Self Service Kiosk', 57.668, 12.297);
const ARN = loc('SWSTO50', 'Stockholm Arlanda Flygplats / Self Service Kiosk', 59.638, 17.94);
const OSL = loc('NOGEN51', 'OSLO LUFTHAVN', 60.193, 11.099, 'no');

let nextId = 1;
const route = (from: Loc, to: Loc, over: Record<string, unknown> = {}) => ({
  id: nextId++,
  transportOfferId: 100 + nextId,
  pickupLocation: from,
  returnLocation: to,
  priorityOrder: 1,
  distance: 180,
  originalDistance: 149.6,
  travelTime: 150,
  originalTravelTime: 118,
  availableAt: '2026-10-19T08:00:00',
  latestReturn: '2026-10-22T21:59:00',
  expireTime: '2026-10-22T17:50:00',
  carModel: 'VOLVO XC40 B3 FWD AUT PLUS DAR',
  publicDescription: '',
  publicInformation: '',
  ...over,
});
const group = (routes: ReturnType<typeof route>[]) => ({ routes });

// "now" = Mon 19 Oct 2026 11:45 Swedish time = 09:45 UTC
const NOW = new Date('2026-10-19T09:45:00Z');

describe('parseUtc', () => {
  it('treats timestamps without a zone as UTC, like hertzfreerider.se does', () => {
    const d = parseUtc('2026-10-19T10:00:00');
    expect(d.toISOString()).toBe('2026-10-19T10:00:00.000Z');
    // The official site shows this as 12:00 (CEST)
    expect(fmtWhen(d, NOW)).toBe('Today 12:00');
  });
  it('keeps explicit zones', () => {
    expect(parseUtc('2026-10-19T10:00:00+02:00').toISOString()).toBe('2026-10-19T08:00:00.000Z');
  });
  it('shows opening hours as given', () => {
    expect(fmtHours(['08:00', '16:00'])).toBe('08:00–16:00');
    expect(fmtHours(null)).toBe('Closed');
  });
});

describe('normalize (Hertz)', () => {
  const sharedOffer = 555;
  const feed: RoutesResponse = {
    fetchedAt: NOW.toISOString(),
    providers: [],
    ...parseHertz([
      group([
        route(JKG, GOT, { transportOfferId: 1 }),
        route(JKG, GOT, { transportOfferId: 2, carModel: 'Personbil', publicDescription: '***SOMMARDÄCK***' }),
        route(JKG, GOT, { transportOfferId: 2 }), // same car listed twice → still one car
      ]),
      group([route(JKG, ARN, { transportOfferId: sharedOffer, availableAt: '2026-10-19T10:00:00' })]), // opens 12:00, i.e. in 15 min
      group([route(JKG, OSL, { transportOfferId: sharedOffer, availableAt: '2026-10-19T10:00:00' })]),
      group([route(GOT, ARN, { availableAt: '2026-10-22T06:00:00', expireTime: '2026-10-24T12:00:00', latestReturn: '2026-10-25T21:59:00' })]),
      group([route(ARN, GOT, { expireTime: '2026-10-19T09:00:00' })]), // already expired
      group([route(GOT, JKG, { expireTime: '2026-10-19T15:00:00' })]), // expires within 12 h
    ]),
  };
  const model = normalize(feed, NOW);
  const byId = (id: string) => model.corridors.find((c) => c.id === id)!;
  const H = (a: string, b: string) => `hertz:${a}>hertz:${b}`;

  it('groups trips into pickup→return corridors and drops expired ones', () => {
    expect(model.corridors.map((c) => c.id).sort()).toEqual(
      [H('SWGOT50', 'SWJKG61'), H('SWGOT50', 'SWSTO50'), H('SWJKG61', 'NOGEN51'), H('SWJKG61', 'SWGOT50'), H('SWJKG61', 'SWSTO50')].sort(),
    );
    expect(byId(H('SWSTO50', 'SWGOT50'))).toBeUndefined();
    expect(model.corridors.every((c) => c.provider === 'hertz')).toBe(true);
  });

  it('counts distinct cars, not listings', () => {
    expect(byId(H('SWJKG61', 'SWGOT50')).carCount).toBe(2);
    expect(byId(H('SWJKG61', 'SWGOT50')).cars).toHaveLength(3);
    // shared offer counts once overall
    expect(model.totals.cars).toBe(5);
    expect(model.byProvider.hertz.cars).toBe(5);
    expect(model.byProvider.driveback.cars).toBe(0);
  });

  it('classifies availability', () => {
    expect(byId(H('SWJKG61', 'SWGOT50')).status).toBe('now');
    expect(byId(H('SWJKG61', 'SWSTO50')).status).toBe('soon');
    expect(byId(H('SWGOT50', 'SWSTO50')).status).toBe('later');
    expect(byId(H('SWGOT50', 'SWJKG61')).expiresSoon).toBe(true);
    expect(byId(H('SWJKG61', 'SWGOT50')).expiresSoon).toBe(false);
    expect(model.totals.carsNow).toBe(3);
  });

  it('flags a car offered to several destinations', () => {
    const car = byId(H('SWJKG61', 'SWSTO50')).cars[0];
    expect(car.alsoOfferedTo.map((s) => s.code)).toEqual(['hertz:NOGEN51']);
    expect(byId(H('SWJKG61', 'SWGOT50')).cars[0].alsoOfferedTo).toEqual([]);
  });

  it('builds station info and counters', () => {
    const jkg = model.stations.get('hertz:SWJKG61')!;
    expect(jkg.short).toBe('Jönköping NybergsBil');
    expect(jkg.place).toBe('Jönköping');
    expect(jkg.outCars).toBe(3);
    expect(jkg.hasNow).toBe(true);
    expect(jkg.hours![0]).toEqual(['08:00', '16:00']);
    expect(model.stations.get('hertz:NOGEN51')!.short).toBe('Oslo Lufthavn');
  });

  it('reads car details from model text and notes', () => {
    const cars = byId(H('SWJKG61', 'SWGOT50')).cars;
    const generic = cars.find((c) => c.model === 'Personbil')!;
    expect(generic.modelLabel).toBe('Car model not specified');
    expect(generic.tags.map((t) => t.label)).toContain('Summer tyres');
    expect(generic.notes).toEqual(['SOMMARDÄCK']);
    expect(generic.bookUrl).toBe('https://www.hertzfreerider.se/sv-se/');
  });
});

describe('normalize (DriveBack, real feed of 22 Oct 2026)', async () => {
  const raw = JSON.parse(drivebackRaw);
  // every address "found" at the provider's town position
  const parsed = await parseDriveBack(raw, async ({ near }: { near: { lat: number; lon: number } | null }) => (near ? { ...near, precision: 'town', city: null } : null));
  // 22 Oct 2026 12:00 Swedish time
  const now = new Date('2026-10-22T10:00:00Z');
  const model = normalize(parsed, now);

  it('drops trips whose pickup window has closed and keeps the rest', () => {
    // 9656 (until 15:00 today) is still open; nothing has closed yet at noon
    expect(model.byProvider.driveback.cars).toBe(7);
    const later = normalize(parsed, new Date('2026-10-22T13:30:00Z')); // 15:30: the Sprinter's window closed at 15:00
    expect(later.byProvider.driveback.cars).toBe(6);
  });

  it('shares one car between its destinations', () => {
    const sprinter = model.corridors.filter((c) => c.cars.some((x) => x.offerId === 'driveback:9656'));
    expect(sprinter.length).toBe(4);
    expect(sprinter[0].cars[0].alsoOfferedTo).toHaveLength(3);
    expect(sprinter[0].cars[0].tags.map((t) => t.label)).toContain('Light van');
    expect(sprinter[0].cars[0].transmission).toBe('Automatic');
  });

  it('treats a car that opens on Monday as upcoming, inside a route that is available now', () => {
    const c = model.corridors.find((x) => x.cars.some((car) => car.offerId === 'driveback:9674'))!;
    const monday = c.cars.find((car) => car.offerId === 'driveback:9674')!;
    expect(monday.status).toBe('later');
    expect(c.status).toBe('now'); // the same route also has cars from 21 Oct
    expect(monday.returnBy).toBeNull();
    expect(monday.terms.find((t) => t.label === 'Minimum age')?.value).toBe('19');
  });

  it('filters by provider and by when you can leave', () => {
    const f = defaultFilters();
    const all = applyFilters(model.corridors, f, { focusStation: null, matcher: null, now }).list.length;
    expect(applyFilters(model.corridors, { ...f, providers: { ...f.providers, driveback: false } }, { focusStation: null, matcher: null, now }).list).toHaveLength(0);
    // Thursday noon: "today" keeps the Falkenberg V60 (until 16:00) but "this weekend" doesn't
    const v60 = (list: { id: string }[]) => list.some((c) => c.id === 'driveback:1125>driveback:823');
    expect(v60(applyFilters(model.corridors, { ...f, when: 'today' }, { focusStation: null, matcher: null, now }).list)).toBe(true);
    expect(v60(applyFilters(model.corridors, { ...f, when: 'weekend' }, { focusStation: null, matcher: null, now }).list)).toBe(false);
    const nowOnly = applyFilters(model.corridors, { ...f, when: 'now' }, { focusStation: null, matcher: null, now }).list;
    expect(nowOnly).toHaveLength(all);
    expect(nowOnly.flatMap((c) => c.cars).some((car) => car.offerId === 'driveback:9674')).toBe(false); // Monday's car is gone
  });
});

describe('when windows (Swedish days)', () => {
  it('knows today, tomorrow and the weekend', () => {
    const thu = new Date('2026-10-22T10:00:00Z'); // Thursday 12:00 in Sweden
    expect(startOfDay(thu, 1).toISOString()).toBe('2026-10-22T22:00:00.000Z'); // Friday 00:00 CEST
    const weekend = whenWindow('weekend', thu)!;
    expect(weekend.start.toISOString()).toBe('2026-10-23T22:00:00.000Z'); // Saturday 00:00 CEST
    expect(weekend.end.toISOString()).toBe('2026-10-25T23:00:00.000Z'); // Monday 00:00 CET (clocks went back on Sunday)
    const sat = new Date('2026-10-24T12:00:00Z');
    expect(whenWindow('weekend', sat)!.start).toEqual(sat);
    expect(whenWindow('any', thu)).toBeNull();
  });
});

describe('shortName', () => {
  it.each([
    ['Göteborg Landvetter Flygplats / Self Service Kiosk', 'Göteborg Landvetter Flygplats'],
    ['Umeå Bilbolaget/Self Service Kiosk', 'Umeå Bilbolaget'],
    ['Skövde DT & Self Service Kiosk Brandt', 'Skövde DT Brandt'],
    ['Linköping (Tage Rejmes)/ Self Service Kiosk', 'Linköping (Tage Rejmes)'],
    ['Nyköping & Self Service Kiosk', 'Nyköping'],
    ['Arvidsjaur/Volvo / Self Service Kiosk', 'Arvidsjaur/Volvo'],
    ['OSLO SENTRALSTASJON', 'Oslo Sentralstasjon'],
    ['Karlstad', 'Karlstad'],
  ])('%s', (input, expected) => expect(shortName(input)).toBe(expected));
});

describe('describeCar', () => {
  it.each([
    ['XPENG G6 AUT AWD 87,5 KWH PERF', 'electric', 'Automatic', true],
    ['VW ID4 AUT BEV 77KWH', 'electric', 'Automatic', false],
    ['POLESTAR 4 LRDM 100KWH AUT BE', 'electric', 'Automatic', false],
    ['VOLVO EX40 AUT SMER 82KWH ULTR', 'electric', 'Automatic', false],
    ['LYNK&CO 01 AUT LADDHYBRID', 'plugin', 'Automatic', false],
    ['KIA SPORTAGE AUT PHEV ADVANCE', 'plugin', 'Automatic', false],
    ['VOLVO V60 T6 AUT AWD NE PLUS D', 'plugin', 'Automatic', true],
    ['VOLVO XC40 B3 FWD AUT PLUS DAR', 'fuel', 'Automatic', false],
    ['RENAULT CLIO TCE90 MAN BENSIN', 'fuel', 'Manual', false],
    ['SKODA KODIAQ 1,5TSI AUT', 'fuel', 'Automatic', false],
    ['Personbil', 'unknown', null, false],
  ] as const)('%s', (model, kind, transmission, awd) => {
    const info = describeCar(model);
    expect(info.kind).toBe(kind);
    expect(info.transmission).toBe(transmission);
    expect(info.awd).toBe(awd);
  });

  it('uses notes from Hertz too', () => {
    expect(describeCar('Personbil', ['', 'EL-BIL']).kind).toBe('electric');
    expect(describeCar('RENAULT KANGOO 1,5DCI 3M3 MAN').tags.map((t) => t.label)).toContain('Van');
    expect(describeCar('LYNK&CO 01 AUT LADDHYBRID').modelLabel).toBe('Lynk & Co 01 AUT LADDHYBRID');
  });
});

describe('real strings from the live feed (19 Oct 2026)', () => {
  it.each([
    ['Göteborg Landvetter Flygplats / Self Service Kiosk', 'Landvetter', 'Landvetter Airport'],
    ['Stockholm Arlanda Flygplats / Self Service Kiosk', 'Stockholm (Arlanda)', 'Arlanda Airport'],
    ['BERGEN LUFTHAVN', 'BLOMSTERDALEN', 'Bergen Airport'],
    ['OSLO LUFTHAVN', 'GARDERMOEN', 'Oslo Airport'],
    ['Kiruna AP', 'Kiruna', 'Kiruna Airport'],
    ['Karlshamn Ahlberg Bil / Self Service Kiosk', 'Asarum', 'Karlshamn'],
    ['Borås, Borås Bil / Self Service Kiosk', 'Borås', 'Borås'],
    ['Stockholm Solna Bilia & SSK', 'Solna', 'Stockholm'],
    ['Stockholm Centralstation / Self Service Kiosk', 'STOCKHOLM', 'Stockholm'],
    ['Norrköping - Rejmes/ Self Service Kiosk', 'Norrköping', 'Norrköping'],
    ['Arvidsjaur/Volvo / Self Service Kiosk', 'Arvidsjaur', 'Arvidsjaur'],
    ['KARLSBORG PICK UP', 'Karlsborg', 'Karlsborg'],
    ['ÅLESUND SENTRUM', 'ÅLESUND', 'Ålesund'],
    ['Sandviken DT/VOLVO', 'Sandviken', 'Sandviken'],
  ])('place for %s', (name, city, expected) => expect(placeName(name, city)).toBe(expected));

  it('short names drop kiosk wording', () => {
    expect(shortName('Stockholm Solna Bilia & SSK')).toBe('Stockholm Solna Bilia');
    expect(shortName('Ljungby DT Self Service Kiosk')).toBe('Ljungby DT');
    expect(shortName('Olofström Self Service Kiosk')).toBe('Olofström');
  });

  it.each([
    ['HYUNDAI IONIQ6 74KWH AUT ELECT', '', 'sommerdekk', 'electric', ['Summer tyres']],
    ['VW CRAFTER 14M3 4MOTION TDI VA', '', '', 'fuel', ['Van']],
    ['TOYOTA YARIS 5D 1,5 HYBRID AUT', '', '', 'hybrid', []],
    ['VOLVO V90 T6 RECH AUT NE PLUS', '', '', 'plugin', []],
    ['VOLVO XC60 T6RECH AUT AWD PLD', '', '', 'plugin', []],
    ['TOYOTA RAV4 SUV AUT 4X4 PLUGIN', '', '', 'plugin', []],
    ['FORD TRANSIT 6M3 TDCI VARE', '', '', 'fuel', ['Van']],
    ['PEUGEOT 5008 HDI AUT 7-SEATS', 'PEUGEOT 5008', '', 'fuel', ['7 seats']],
    ['FORD TOURNEO AUT PHEV 9PAX', '', '', 'plugin', ['9 seats']],
    ['MERCEDES VITO AUT 6M3', '***SOMMARDÄCK***', '', 'unknown', ['Summer tyres', 'Van']],
    ['VW ID4 AUT BEV 77KWH', '', 'BIL PÅ SOMMERDEKK/CAR ON SUMMER TIER.', 'electric', ['Summer tyres']],
    ['VOLVO EX40 AUT SMER 82KWH ULTR', "'** ELBIL '** sommardäck", '', 'electric', ['Summer tyres']],
  ] as const)('%s', (model, desc, info, kind, tags) => {
    const car = describeCar(model, [desc, info]);
    expect(car.kind).toBe(kind);
    expect(car.tags.map((t) => t.label)).toEqual(tags);
  });

  it('drops notes that only repeat the model and cleans stray quotes', () => {
    expect(describeCar('PEUGEOT 5008 HDI AUT 7-SEATS', ['PEUGEOT 5008', '']).notes).toEqual([]);
    expect(describeCar('VOLVO EX40 AUT SMER 82KWH ULTR', ["'** ELBIL '** sommardäck", '']).notes).toEqual(['ELBIL sommardäck']);
  });
});

describe('road shapes', () => {
  it('survive the encode → decode round trip used between server and browser', async () => {
    const { encodePolyline, simplify } = await import('../server/api.mjs');
    const { decodePolyline } = await import('../src/geometry');
    const line: [number, number][] = [
      [14.1855, 57.77801],
      [14.17, 57.769],
      [13.5512, 57.70011],
      [12.29707, 57.66829],
      [-0.5, -12.25],
    ];
    const back = decodePolyline(encodePolyline(line));
    expect(back).toHaveLength(line.length);
    back.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(line[i][0], 5);
      expect(y).toBeCloseTo(line[i][1], 5);
    });
    // a straight run of points collapses to its end points
    expect(simplify([[0, 0], [1, 0.00001], [2, 0]], 0.0001)).toEqual([[0, 0], [2, 0]]);
  });
});

describe('naming pick-up points', () => {
  it('uses Hertz station names, and town plus street for address-only sites', () => {
    expect(stationLabel({ provider: 'hertz', short: 'Göteborg Landvetter Flygplats', place: 'Landvetter Airport' })).toBe('Göteborg Landvetter Flygplats');
    expect(stationLabel({ provider: 'driveback', short: 'Lokgatan 9C', place: 'Malmö' })).toBe('Malmö, Lokgatan 9C');
    expect(stationLabel({ provider: 'drive4free', short: 'Västerås', place: 'Västerås' })).toBe('Västerås');
  });

  it('never repeats the town as the address line', () => {
    expect(stationHeading({ provider: 'drive4free', short: 'Västerås', place: 'Västerås', address: 'Västerås', city: 'Västerås' })).toEqual({ title: 'Västerås', sub: '' });
    expect(stationHeading({ provider: 'driveback', short: 'Säterivägen 24', place: 'Karlstad', address: 'Säterivägen 24, 653 41 Karlstad', city: 'Karlstad' })).toEqual({
      title: 'Karlstad',
      sub: 'Säterivägen 24, 653 41 Karlstad',
    });
    expect(stationHeading({ provider: 'hertz', short: 'Jönköping NybergsBil', place: 'Jönköping', address: 'Kålgårdsgatan 28', city: 'Jönköping' })).toEqual({
      title: 'Jönköping NybergsBil',
      sub: 'Kålgårdsgatan 28, Jönköping',
    });
  });
});
