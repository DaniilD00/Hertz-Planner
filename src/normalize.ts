import { describeCar } from './carinfo';
import { PROVIDER_ORDER } from './providers';
import type { CarOffer, Corridor, Model, ProviderId, RoutesResponse, Station, Status, Totals, WireOffer, WireStation } from './types';

const SOON_MS = 24 * 3600 * 1000;
const EXPIRING_MS = 12 * 3600 * 1000;
const RANK: Record<Status, number> = { now: 0, soon: 1, later: 2 };

/** "Göteborg Landvetter Flygplats / Self Service Kiosk" → "Göteborg Landvetter Flygplats" */
export function shortName(name: string): string {
  let s = (name || '').replace(/\s*[/&]?\s*self[\s-]?service[\s-]?kiosk\s*/gi, ' ').replace(/\s*[/&]\s*SSK\b/g, ' ');
  s = s.replace(/\s*\/\s*$/, '').replace(/^\s*\/\s*/, '').replace(/\s{2,}/g, ' ').trim();
  return titleIfShouting(s || name);
}

/** "OSLO LUFTHAVN" → "Oslo Lufthavn"; mixed-case names are left alone. */
export function titleIfShouting(s: string): string {
  if (!s || s !== s.toUpperCase() || !/[A-ZÅÄÖÆØ]{3}/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

const AIRPORT = /^(.*?)\s+(?:flygplats|lufthavn|airport|AP)\b/i;

/**
 * The place name used in titles: "Jönköping", "Arlanda Airport", "Bergen Airport".
 * Hertz's `city` is often a suburb or airport locality (Asarum, Blomsterdalen), so it's derived from the station name.
 */
export function placeName(name: string, city: string | null | undefined): string {
  const short = shortName(name);
  const airport = AIRPORT.exec(short);
  if (airport) {
    const words = airport[1].trim().split(/\s+/);
    return `${titleIfShouting(words[words.length - 1])} Airport`;
  }
  const c = titleIfShouting((city || '').trim());
  if (c && short.toLowerCase().startsWith(c.toLowerCase())) return c;
  const first = short.split(/[\s,/(]+|\s-\s/)[0];
  return titleIfShouting(first || c || short);
}

function toStation(w: WireStation): Station {
  const hertz = w.provider === 'hertz';
  const address = titleIfShouting((w.address || '').trim());
  // Address-based providers: "Maskingatan 7, 19560 Arlandastad" → short "Maskingatan 7"
  const short = hertz ? shortName(w.name) : (address || w.name).split(',')[0].trim() || w.name;
  const place = w.place ? titleIfShouting(w.place) : placeName(w.name, w.city);
  return {
    code: w.id,
    provider: w.provider,
    name: w.name,
    short,
    place,
    city: titleIfShouting((w.city || '').trim()) || place,
    country: (w.country || 'se').toLowerCase(),
    lat: w.lat,
    lon: w.lon,
    address,
    phone: (w.phone || '').trim(),
    kiosk: !!w.kiosk,
    precision: w.precision || 'exact',
    hours: Array.isArray(w.hours) ? w.hours : null,
    info: w.info || {},
    outCars: 0,
    inCars: 0,
    hasNow: false,
  };
}

/** How to name a pick-up point in a sentence. Hertz stations have names; the other sites only give addresses, so the
 * town goes first: "Malmö, Lokgatan 9C". */
export function stationLabel(s: Pick<Station, 'provider' | 'short' | 'place'>): string {
  return s.provider === 'hertz' || s.short === s.place ? s.short : `${s.place}, ${s.short}`;
}

/** Heading and address line for a pick-up point (no repeats when only the town is known). */
export function stationHeading(s: Pick<Station, 'provider' | 'short' | 'place' | 'address' | 'city'>): { title: string; sub: string } {
  if (s.provider === 'hertz') return { title: s.short, sub: [s.address, s.city].filter(Boolean).join(', ') };
  return { title: s.place, sub: s.address && s.address !== s.place ? s.address : '' };
}

export function statusOf(availableFrom: Date, now: Date): Status {
  const t = availableFrom.getTime() - now.getTime();
  if (t <= 0) return 'now';
  return t <= SOON_MS ? 'soon' : 'later';
}

const date = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function toCar(o: WireOffer, now: Date): CarOffer | null {
  const availableFrom = date(o.availableFrom);
  const offerExpires = date(o.offerExpires);
  if (!availableFrom || !offerExpires || offerExpires.getTime() <= now.getTime()) return null; // expired or broken
  const info = describeCar(o.model, o.notes, { transmission: o.transmission, carType: o.carType });
  return {
    provider: o.provider,
    routeId: o.id,
    offerId: o.offerId,
    model: o.model,
    ...info,
    carType: o.carType,
    terms: o.terms || [],
    bookUrl: o.bookUrl,
    availableFrom,
    offerExpires,
    returnBy: date(o.returnBy),
    maxKm: o.maxKm ?? null,
    estKm: o.estKm ?? null,
    maxMin: o.maxMin ?? null,
    estMin: o.estMin ?? null,
    status: statusOf(availableFrom, now),
    alsoOfferedTo: [],
  };
}

/** Common feed from the local server → routes (pickup→drop-off pairs) with their cars, ready for the map. */
export function normalize(feed: Pick<RoutesResponse, 'stations' | 'offers'>, now: Date = new Date()): Model {
  const stations = new Map<string, Station>();
  const station = (id: string) => {
    let s = stations.get(id);
    if (!s) {
      const w = feed.stations?.[id];
      if (!w || !Number.isFinite(w.lat) || !Number.isFinite(w.lon)) return null;
      stations.set(id, (s = toStation(w)));
    }
    return s;
  };

  const byId = new Map<string, Corridor>();
  const offerDestinations = new Map<string, Set<string>>();
  const seen = new Set<string>();

  for (const o of feed.offers || []) {
    if (!o?.id || seen.has(o.id)) continue;
    seen.add(o.id);
    const car = toCar(o, now);
    if (!car) continue;
    const from = station(o.from);
    const to = station(o.to);
    if (!from || !to) continue;

    const id = `${from.code}>${to.code}`;
    let c = byId.get(id);
    if (!c) {
      c = {
        id,
        provider: o.provider,
        from,
        to,
        cars: [],
        carCount: 0,
        status: 'later',
        rank: 2,
        earliestFrom: car.availableFrom,
        soonestExpiry: car.offerExpires,
        expiresSoon: false,
        estKm: null,
        estMin: null,
        kinds: [],
        routeIds: [],
      };
      byId.set(id, c);
    }
    c.cars.push(car);
    c.routeIds.push(o.id);
    if (!offerDestinations.has(car.offerId)) offerDestinations.set(car.offerId, new Set());
    offerDestinations.get(car.offerId)!.add(to.code);
  }

  const corridors = [...byId.values()];
  for (const c of corridors) {
    c.cars.sort((a, b) => a.availableFrom.getTime() - b.availableFrom.getTime() || a.offerExpires.getTime() - b.offerExpires.getTime());
    for (const car of c.cars) {
      const dests = offerDestinations.get(car.offerId)!;
      car.alsoOfferedTo = [...dests].filter((code) => code !== c.to.code).map((code) => stations.get(code)!);
    }
    c.carCount = new Set(c.cars.map((x) => x.offerId)).size;
    c.rank = Math.min(...c.cars.map((x) => RANK[x.status]));
    c.status = (['now', 'soon', 'later'] as Status[])[c.rank];
    c.earliestFrom = new Date(Math.min(...c.cars.map((x) => x.availableFrom.getTime())));
    c.soonestExpiry = new Date(Math.min(...c.cars.map((x) => x.offerExpires.getTime())));
    c.expiresSoon = c.cars.some((x) => x.status === 'now' && x.offerExpires.getTime() - now.getTime() < EXPIRING_MS);
    const est = c.cars.find((x) => x.estKm != null);
    c.estKm = est?.estKm ?? null;
    c.estMin = est?.estMin ?? null;
    c.kinds = [...new Set(c.cars.map((x) => x.kind))];
  }

  // Station counters (distinct cars leaving / arriving)
  const outOffers = new Map<string, Set<string>>();
  const inOffers = new Map<string, Set<string>>();
  for (const c of corridors) {
    for (const car of c.cars) {
      if (!outOffers.has(c.from.code)) outOffers.set(c.from.code, new Set());
      outOffers.get(c.from.code)!.add(car.offerId);
      if (!inOffers.has(c.to.code)) inOffers.set(c.to.code, new Set());
      inOffers.get(c.to.code)!.add(car.offerId);
      if (car.status === 'now') c.from.hasNow = true;
    }
  }
  for (const s of stations.values()) {
    s.outCars = outOffers.get(s.code)?.size ?? 0;
    s.inCars = inOffers.get(s.code)?.size ?? 0;
  }
  for (const [code, s] of stations) if (!s.outCars && !s.inCars) stations.delete(code);

  return {
    stations,
    corridors,
    totals: { ...countCars(corridors), stations: stations.size },
    byProvider: Object.fromEntries(PROVIDER_ORDER.map((p) => [p, countCars(corridors.filter((c) => c.provider === p))])) as Record<ProviderId, Totals>,
  };
}

/** Distinct cars (a car offered to several destinations counts once), cars available now, and routes. */
export function countCars(corridors: Corridor[]): Totals {
  const all = new Set<string>();
  const now = new Set<string>();
  for (const c of corridors)
    for (const car of c.cars) {
      all.add(car.offerId);
      if (car.status === 'now') now.add(car.offerId);
    }
  return { cars: all.size, carsNow: now.size, routes: corridors.length };
}
