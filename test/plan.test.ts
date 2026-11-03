import { describe, expect, it } from 'vitest';
import { buildRoute, circlePolygon, haversineKm, headingGap, locateOnRoute, makeMatcher, MAX_HEADING_GAP, minCarKm, planMode, pointAlong, transitLink, type Place } from '../src/plan';
import type { Corridor, Station } from '../src/types';

const station = (code: string, lat: number, lon: number): Station => ({
  code,
  provider: 'hertz',
  precision: 'exact',
  name: code,
  short: code,
  place: code,
  city: code,
  country: 'se',
  lat,
  lon,
  address: '',
  phone: '',
  kiosk: true,
  hours: [],
  info: {},
  outCars: 1,
  inCars: 1,
  hasNow: true,
});

const corridor = (from: Station, to: Station): Corridor => ({
  id: `${from.code}>${to.code}`,
  provider: 'hertz',
  from,
  to,
  cars: [],
  carCount: 1,
  status: 'now',
  rank: 0,
  earliestFrom: new Date(),
  soonestExpiry: new Date(),
  expiresSoon: false,
  estKm: null,
  estMin: null,
  kinds: [],
  routeIds: [],
});

// Real coordinates
const STHLM: Place = { label: 'Stockholm', lat: 59.3326, lon: 18.0649 };
const GBG: Place = { label: 'Göteborg', lat: 57.7072, lon: 11.9668 };
const ARN = station('ARN', 59.63826, 17.94025); // Arlanda, 34 km north of Stockholm
const SODER = station('SODER', 59.31, 18.07); // Stockholm city
const LIN = station('LIN', 58.41757, 15.63862); // Linköping, on the E4 towards Jönköping
const JKG = station('JKG', 57.77801, 14.1855); // Jönköping
const GOT = station('GOT', 57.66829, 12.29707); // Landvetter, near Göteborg
const UME = station('UME', 63.81469, 20.24694); // Umeå, the wrong direction
const LUND = station('LUND', 55.70554, 13.186); // far south, off the Stockholm–Göteborg route

// Rough Stockholm → Göteborg road via Linköping and Jönköping (E4 / E20 / Rv40)
const ROAD = buildRoute([
  [18.0649, 59.3326],
  [16.9, 58.75],
  [15.63862, 58.41757],
  [14.1855, 57.77801],
  [12.95, 57.72],
  [11.9668, 57.7072],
]);

describe('distances', () => {
  it('haversine is right for Stockholm–Göteborg (~398 km straight)', () => {
    expect(haversineKm(STHLM.lat, STHLM.lon, GBG.lat, GBG.lon)).toBeGreaterThan(390);
    expect(haversineKm(STHLM.lat, STHLM.lon, GBG.lat, GBG.lon)).toBeLessThan(405);
  });

  it('locates a station on the route', () => {
    const jkg = locateOnRoute(ROAD, JKG.lat, JKG.lon);
    expect(jkg.offKm).toBeLessThan(1);
    expect(jkg.alongKm).toBeGreaterThan(250);
    expect(jkg.alongKm).toBeLessThan(ROAD.totalKm);
    expect(locateOnRoute(ROAD, LUND.lat, LUND.lon).offKm).toBeGreaterThan(150);
  });

  it('builds a closed circle of the right size', () => {
    const ring = circlePolygon(59, 18, 50);
    expect(ring[0][0]).toBeCloseTo(ring[ring.length - 1][0], 6);
    ring.forEach(([lon, lat]) => expect(haversineKm(59, 18, lat, lon)).toBeCloseTo(50, 0));
  });
});

describe('matching trips to a plan', () => {
  const all = [corridor(ARN, GOT), corridor(SODER, LIN), corridor(LIN, GOT), corridor(JKG, GOT), corridor(GOT, JKG), corridor(ARN, UME), corridor(LUND, GOT), corridor(JKG, LIN)];

  it('has no matcher without places', () => {
    expect(planMode(null, null)).toBeNull();
    expect(makeMatcher({ from: null, to: null, radiusKm: 50, route: null })).toBeNull();
  });

  it('start only: trips picked up within the radius of you, nearest first', () => {
    const m = makeMatcher({ from: STHLM, to: null, radiusKm: 40, route: null })!;
    const hits = all.map((c) => [c.id, m(c)] as const).filter(([, x]) => x);
    expect(hits.map(([id]) => id).sort()).toEqual(['ARN>GOT', 'ARN>UME', 'SODER>LIN']);
    expect(m(corridor(SODER, LIN))!.pickupKm).toBeLessThan(5);
    expect(m(corridor(SODER, LIN))!.score).toBeGreaterThan(m(corridor(ARN, GOT))!.score);
  });

  it('destination only: trips dropping off near the destination', () => {
    const m = makeMatcher({ from: null, to: GBG, radiusKm: 30, route: null })!;
    expect(all.filter((c) => m(c)).map((c) => c.id).sort()).toEqual(['ARN>GOT', 'JKG>GOT', 'LIN>GOT', 'LUND>GOT']);
  });

  it('start + destination: trips along the way, ranked by how much of the trip the car covers', () => {
    const m = makeMatcher({ from: STHLM, to: GBG, radiusKm: 50, route: ROAD })!;
    const ids = all.filter((c) => m(c)).map((c) => c.id);
    expect(ids.sort()).toEqual(['ARN>GOT', 'JKG>GOT', 'LIN>GOT', 'SODER>LIN']);
    // backwards (GOT>JKG, JKG>LIN), wrong direction (ARN>UME) and off the route (LUND>GOT) are out
    const arn = m(corridor(ARN, GOT))!;
    const jkg = m(corridor(JKG, GOT))!;
    expect(arn.carKm!).toBeGreaterThan(jkg.carKm!);
    expect(jkg.pickupAlongKm!).toBeGreaterThan(250);
    expect(jkg.dropoffToDestKm!).toBeLessThan(25);
  });

  it('a tight radius drops stations that are too far from the route', () => {
    const m = makeMatcher({ from: STHLM, to: GBG, radiusKm: 20, route: ROAD })!;
    expect(m(corridor(ARN, GOT))).toBeNull(); // Arlanda is ~30 km off the route
    expect(m(corridor(JKG, GOT))).not.toBeNull();
  });

  it('works with a straight-line stand-in before the road route has loaded', () => {
    const m = makeMatcher({ from: STHLM, to: GBG, radiusKm: 60, route: null })!;
    expect(m(corridor(JKG, GOT))).not.toBeNull();
    expect(m(corridor(GOT, JKG))).toBeNull();
  });

  it('drops trips that move you along but head sideways', () => {
    // Along a straight west–east road: a car from 40 km south of it to 40 km north of it, 30 km further east,
    // technically moves you forward but points almost straight across the road
    const road = buildRoute([
      [14, 58],
      [18, 58],
    ]);
    const south = station('S', 58 - 40 / 110.6, 15.5);
    const north = station('N', 58 + 40 / 110.6, 15.5 + 30 / (111.32 * Math.cos((58 * Math.PI) / 180)));
    const east = station('E', 58.05, 16.8);
    const from: Place = { label: 'A', lat: 58, lon: 14 };
    const to: Place = { label: 'B', lat: 58, lon: 18 };
    const m = makeMatcher({ from, to, radiusKm: 50, route: road })!;
    expect(m(corridor(south, north))).toBeNull();
    expect(m(corridor(south, east))).not.toBeNull(); // diagonal but mostly your way
    expect(m(corridor(east, south))).toBeNull(); // backwards
  });

  it('measures how far a trip turns from your road', () => {
    const road = buildRoute([
      [14, 58],
      [16, 58],
      [16, 60], // the road turns north here
    ]);
    expect(pointAlong(road, 0)).toEqual([14, 58]);
    expect(pointAlong(road, road.totalKm)).toEqual([16, 60]);
    const turn = locateOnRoute(road, 58, 16).alongKm;
    // on the northbound stretch, a car heading north follows the road; one heading east is sideways
    expect(headingGap(road, turn + 20, turn + 150, { lat: 58.2, lon: 16 }, { lat: 59.3, lon: 16.05 })).toBeLessThan(10);
    expect(headingGap(road, turn + 20, turn + 150, { lat: 58.2, lon: 16 }, { lat: 58.3, lon: 18 })).toBeGreaterThan(MAX_HEADING_GAP);
    expect(headingGap(road, 10, 100, { lat: 58, lon: 16 }, { lat: 58, lon: 14.5 })).toBeGreaterThan(170);
  });

  it('needs the car to move you a meaningful distance', () => {
    expect(minCarKm(30)).toBe(15);
    expect(minCarKm(500)).toBe(40);
  });
});

it('builds a public-transport directions link', () => {
  expect(transitLink(STHLM, JKG)).toBe('https://www.google.com/maps/dir/?api=1&origin=59.33260,18.06490&destination=57.77801,14.18550&travelmode=transit');
});
