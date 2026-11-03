// Trip planning: which Freerider trips help you, given where you are, where you're going and how far you'll travel.
//
//  - Start only:        trips you can pick up within R km of you.
//  - Destination only:  trips that drop off within R km of your destination.
//  - Start + destination: trips along your way. You go part of the way by train or bus, drive the car, then
//                       continue. Both stations must be within R km of your route, the car must take you forward
//                       and point the way your road goes (not sideways or back), and trips are ranked by how many
//                       km of your journey the car covers.

import type { Corridor, Station } from './types';

export interface Place {
  label: string;
  detail?: string;
  lat: number;
  lon: number;
}

export type PlanMode = 'near' | 'arrive' | 'route';

export interface PlanRoute {
  coords: [number, number][]; // [lon, lat]
  cum: number[]; // km from the start at each point
  totalKm: number;
  driveMin: number | null;
  byRoad: boolean; // false = straight-line stand-in while the road route loads
}

export interface PlanMatch {
  mode: PlanMode;
  /** near: km from you to the pick-up. route: km the pick-up lies off your route. */
  pickupKm: number;
  /** route: how far into your trip the pick-up is. */
  pickupAlongKm?: number;
  /** arrive/route: straight-line km from the drop-off to your destination. */
  dropoffToDestKm?: number;
  /** route: km the drop-off lies off your route. */
  dropoffOffKm?: number;
  /** route: km of your journey the car covers. */
  carKm?: number;
  /** higher is better */
  score: number;
}

export interface PlanContext {
  from: Place | null;
  to: Place | null;
  radiusKm: number;
  route: PlanRoute | null;
}

export function planMode(from: Place | null, to: Place | null): PlanMode | null {
  if (from && to) return 'route';
  if (from) return 'near';
  if (to) return 'arrive';
  return null;
}

const R_EARTH = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function buildRoute(coords: [number, number][], driveMin: number | null = null, byRoad = true): PlanRoute {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  return { coords, cum, totalKm: cum[cum.length - 1] ?? 0, driveMin, byRoad };
}

/** How far a point is from the route, and how far along the route its closest point is. */
export function locateOnRoute(route: PlanRoute, lat: number, lon: number): { offKm: number; alongKm: number } {
  const { coords, cum } = route;
  if (coords.length === 1) return { offKm: haversineKm(lat, lon, coords[0][1], coords[0][0]), alongKm: 0 };
  // Local flat projection around the point (km), accurate enough for distances of a few hundred km.
  const kx = 111.32 * Math.cos(rad(lat));
  const ky = 110.574;
  let best = Infinity;
  let bestAlong = 0;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - lon) * kx;
    const ay = (coords[i - 1][1] - lat) * ky;
    const bx = (coords[i][0] - lon) * kx;
    const by = (coords[i][1] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d2 = px * px + py * py;
    if (d2 < best) {
      best = d2;
      bestAlong = cum[i - 1] + t * (cum[i] - cum[i - 1]);
    }
  }
  return { offKm: Math.sqrt(best), alongKm: bestAlong };
}

/** Point `km` along the route, as [lon, lat]. */
export function pointAlong(route: PlanRoute, km: number): [number, number] {
  const { coords, cum } = route;
  if (coords.length === 1 || km <= 0) return coords[0];
  let lo = 1;
  let hi = coords.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < km) lo = mid + 1;
    else hi = mid;
  }
  const seg = cum[lo] - cum[lo - 1] || 1;
  const t = Math.min(1, (km - cum[lo - 1]) / seg);
  return [coords[lo - 1][0] + t * (coords[lo][0] - coords[lo - 1][0]), coords[lo - 1][1] + t * (coords[lo][1] - coords[lo - 1][1])];
}

/**
 * How far (in degrees, 0–180) a trip's own direction, pick-up → drop-off, turns away from the direction your road
 * takes over the same stretch. 0 means the car heads exactly your way, 90 sideways, 180 back.
 */
export function headingGap(route: PlanRoute, fromAlongKm: number, toAlongKm: number, from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const a = pointAlong(route, fromAlongKm);
  const b = pointAlong(route, toAlongKm);
  const kx = Math.cos(rad((a[1] + b[1]) / 2));
  const rx = (b[0] - a[0]) * kx;
  const ry = b[1] - a[1];
  const tx = (to.lon - from.lon) * kx;
  const ty = to.lat - from.lat;
  const len = Math.hypot(rx, ry) * Math.hypot(tx, ty);
  if (!len) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (rx * tx + ry * ty) / len))) * 180) / Math.PI;
}

/** A trip whose own direction turns further than this from your road's is going somewhere else. */
export const MAX_HEADING_GAP = 65;

/** The car has to move you forward by at least this much to count as "on your way". */
export function minCarKm(totalKm: number): number {
  return Math.max(15, totalKm * 0.08);
}

/** Returns a function that tells whether (and how well) a route corridor fits the plan. */
export function makeMatcher(ctx: PlanContext): ((c: Corridor) => PlanMatch | null) | null {
  const mode = planMode(ctx.from, ctx.to);
  if (!mode) return null;
  const R = ctx.radiusKm;
  const memo = new Map<string, { dFrom: number; dTo: number; off: number; along: number }>();
  const route = mode === 'route' ? (ctx.route ?? buildRoute([[ctx.from!.lon, ctx.from!.lat], [ctx.to!.lon, ctx.to!.lat]], null, false)) : null;
  const metrics = (s: Station) => {
    let m = memo.get(s.code);
    if (!m) {
      const loc = route ? locateOnRoute(route, s.lat, s.lon) : { offKm: NaN, alongKm: NaN };
      m = {
        dFrom: ctx.from ? haversineKm(ctx.from.lat, ctx.from.lon, s.lat, s.lon) : NaN,
        dTo: ctx.to ? haversineKm(ctx.to.lat, ctx.to.lon, s.lat, s.lon) : NaN,
        off: loc.offKm,
        along: loc.alongKm,
      };
      memo.set(s.code, m);
    }
    return m;
  };

  return (c: Corridor) => {
    const p = metrics(c.from);
    const q = metrics(c.to);
    if (mode === 'near') {
      if (p.dFrom > R) return null;
      return { mode, pickupKm: p.dFrom, score: -p.dFrom };
    }
    if (mode === 'arrive') {
      if (q.dTo > R) return null;
      return { mode, pickupKm: NaN, dropoffToDestKm: q.dTo, score: -q.dTo };
    }
    // route
    if (p.off > R || q.off > R) return null;
    const carKm = q.along - p.along;
    if (carKm < minCarKm(route!.totalKm)) return null;
    // forward along your road isn't enough: the car itself must head your way, not sideways or back
    if (headingGap(route!, p.along, q.along, c.from, c.to) > MAX_HEADING_GAP) return null;
    return {
      mode,
      pickupKm: p.off,
      pickupAlongKm: p.along,
      dropoffOffKm: q.off,
      dropoffToDestKm: q.dTo,
      carKm,
      score: carKm - 0.5 * (p.off + q.off),
    };
  };
}

/** Polygon ring approximating a circle of `km` around a point (for the "how far I can travel" area). */
export function circlePolygon(lat: number, lon: number, km: number, steps = 72): [number, number][] {
  const ring: [number, number][] = [];
  const d = km / R_EARTH;
  const la = rad(lat);
  const lo = rad(lon);
  for (let i = 0; i <= steps; i++) {
    const b = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lon2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat2));
    ring.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}

/** Google Maps directions by public transport (works for Swedish and Norwegian trains and buses). */
export function transitLink(from: { lat: number; lon: number }, to: { lat: number; lon: number }): string {
  const f = `${from.lat.toFixed(5)},${from.lon.toFixed(5)}`;
  const t = `${to.lat.toFixed(5)},${to.lon.toFixed(5)}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${f}&destination=${t}&travelmode=transit`;
}
