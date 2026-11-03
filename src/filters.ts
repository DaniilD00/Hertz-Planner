import { startOfDay } from './format';
import type { PlanMatch, Place } from './plan';
import { PROVIDER_ORDER } from './providers';
import type { CarKind, CarOffer, Corridor, ProviderId, Status } from './types';

export type KindFilter = 'any' | 'electric' | 'plugin' | 'fuel';
export type SortKey = 'plan' | 'status' | 'expiry' | 'cars' | 'distance';
export type When = 'any' | 'now' | 'today' | 'tomorrow' | 'weekend';

export interface Filters {
  /** text typed in the From / To boxes (only a picked place filters trips) */
  from: string;
  to: string;
  /** picked places switch to distance-based trip planning */
  fromPlace: Place | null;
  toPlace: Place | null;
  radiusKm: number;
  /** when you can pick the car up */
  when: When;
  providers: Record<ProviderId, boolean>;
  kind: KindFilter;
  automatic: boolean;
  hideSummer: boolean;
  countries: { se: boolean; no: boolean };
  leaveFrom: Date | null;
  leaveTo: Date | null;
  sort: SortKey;
}

export const defaultFilters = (): Filters => ({
  from: '',
  to: '',
  fromPlace: null,
  toPlace: null,
  radiusKm: 50,
  when: 'any',
  providers: Object.fromEntries(PROVIDER_ORDER.map((p) => [p, true])) as Record<ProviderId, boolean>,
  kind: 'any',
  automatic: false,
  hideSummer: false,
  countries: { se: true, no: true },
  leaveFrom: null,
  leaveTo: null,
  sort: 'status',
});

/** How many of the "more filters" differ from the defaults (shown as a count on the toggle). */
export function activeExtraFilters(f: Filters): number {
  return (
    (f.kind !== 'any' ? 1 : 0) +
    (f.automatic ? 1 : 0) +
    (f.hideSummer ? 1 : 0) +
    (!f.countries.se || !f.countries.no ? 1 : 0) +
    (f.leaveFrom || f.leaveTo ? 1 : 0)
  );
}

/**
 * The time span a "when" choice stands for, in Swedish days. A car fits if its pickup window overlaps it.
 * "This weekend" on a Saturday or Sunday means from now to Sunday night.
 */
export function whenWindow(when: When, now: Date): { start: Date; end: Date } | null {
  if (when === 'today') return { start: now, end: startOfDay(now, 1) };
  if (when === 'tomorrow') return { start: startOfDay(now, 1), end: startOfDay(now, 2) };
  if (when === 'weekend') {
    const dow = (new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', weekday: 'short' }).format(now) as string).slice(0, 3);
    const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(dow);
    if (idx >= 5) return { start: now, end: startOfDay(now, 7 - idx) };
    return { start: startOfDay(now, 5 - idx), end: startOfDay(now, 7 - idx) };
  }
  return null;
}

const kindMatches = (kind: CarKind, want: KindFilter) => want === 'any' || kind === want || (want === 'plugin' && kind === 'hybrid');

function carPasses(car: CarOffer, f: Filters, window: { start: Date; end: Date } | null): boolean {
  if (f.when === 'now' && car.status !== 'now') return false;
  if (window && (car.availableFrom.getTime() >= window.end.getTime() || car.offerExpires.getTime() <= window.start.getTime())) return false;
  if (!kindMatches(car.kind, f.kind)) return false;
  if (f.automatic && car.transmission !== 'Automatic') return false;
  if (f.hideSummer && car.tags.some((t) => t.label === 'Summer tyres')) return false;
  if (f.leaveTo && car.availableFrom.getTime() > f.leaveTo.getTime()) return false;
  if (f.leaveFrom && car.offerExpires.getTime() < f.leaveFrom.getTime()) return false;
  return true;
}

const RANK: Record<Status, number> = { now: 0, soon: 1, later: 2 };

export interface FilterOptions {
  focusStation: string | null;
  /** trip-planning matcher (from plan.ts); corridors it rejects are hidden */
  matcher: ((c: Corridor) => PlanMatch | null) | null;
  now?: Date;
}

/**
 * Returns corridors that still have at least one matching car (counts recomputed for those cars),
 * plus how each one fits the trip plan, if there is one.
 */
export function applyFilters(corridors: Corridor[], f: Filters, opts: FilterOptions): { list: Corridor[]; matches: Map<string, PlanMatch> } {
  const out: Corridor[] = [];
  const matches = new Map<string, PlanMatch>();
  const window = whenWindow(f.when, opts.now ?? new Date());
  for (const c of corridors) {
    if (!f.providers[c.provider]) continue;
    if (opts.focusStation && c.from.code !== opts.focusStation && c.to.code !== opts.focusStation) continue;
    const country = c.from.country === 'no' ? 'no' : 'se';
    if (!f.countries[country]) continue;
    let match: PlanMatch | null = null;
    if (opts.matcher) {
      match = opts.matcher(c);
      if (!match) continue;
    }
    const cars = c.cars.filter((car) => carPasses(car, f, window));
    if (!cars.length) continue;
    if (match) matches.set(c.id, match);
    if (cars.length === c.cars.length) {
      out.push(c);
      continue;
    }
    const rank = Math.min(...cars.map((x) => RANK[x.status]));
    out.push({
      ...c,
      cars,
      carCount: new Set(cars.map((x) => x.offerId)).size,
      rank,
      status: (['now', 'soon', 'later'] as Status[])[rank],
      earliestFrom: new Date(Math.min(...cars.map((x) => x.availableFrom.getTime()))),
      soonestExpiry: new Date(Math.min(...cars.map((x) => x.offerExpires.getTime()))),
      expiresSoon: c.expiresSoon && cars.some((x) => x.status === 'now'),
      kinds: [...new Set(cars.map((x) => x.kind))],
    });
  }
  return { list: sortCorridors(out, f.sort, matches), matches };
}

export function sortCorridors(list: Corridor[], key: SortKey, matches?: Map<string, PlanMatch>): Corridor[] {
  const score = (c: Corridor) => matches?.get(c.id)?.score ?? -Infinity;
  const byName = (a: Corridor, b: Corridor) => a.from.place.localeCompare(b.from.place, 'sv') || a.to.place.localeCompare(b.to.place, 'sv');
  const cmp: Record<SortKey, (a: Corridor, b: Corridor) => number> = {
    plan: (a, b) => score(b) - score(a) || a.rank - b.rank || byName(a, b),
    status: (a, b) => a.rank - b.rank || (a.rank === 0 ? 0 : a.earliestFrom.getTime() - b.earliestFrom.getTime()) || byName(a, b),
    expiry: (a, b) => a.soonestExpiry.getTime() - b.soonestExpiry.getTime() || byName(a, b),
    cars: (a, b) => b.carCount - a.carCount || a.rank - b.rank || byName(a, b),
    distance: (a, b) => (b.estKm ?? 0) - (a.estKm ?? 0) || byName(a, b),
  };
  return [...list].sort(cmp[key]);
}
