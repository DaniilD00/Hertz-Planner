import type { Place } from './plan';
import type { GeometryResponse, RoutesResponse } from './types';
import {
  ROUTER_URLS,
  nominatimSearchUrl,
  osrmRouteUrl,
  parseNominatim,
  parseOsrm,
  parsePhoton,
  photonSearchUrl,
  planEntry,
} from '../server/geo-core.mjs';

/**
 * Two ways to run the map:
 *  - local (start.bat / npm start / npm run dev): a small server on your computer answers /api/…
 *  - GitHub Pages (`npm run build:pages`, Vite mode "pages"): no server. A scheduled GitHub Action publishes
 *    data/trips.json and data/shapes.json every ~10 minutes, and place search and your trip's road are asked
 *    straight from the browser (Photon, Nominatim and OSRM all allow that; the trip sites don't).
 */
export const STATIC = import.meta.env.MODE === 'pages';
const DATA = `${import.meta.env.BASE_URL}data/`;

async function getJson<T>(url: string, who = STATIC ? 'The map data' : 'The local server'): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: STATIC ? 'no-cache' : 'default' });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error;
    throw new Error(msg || `${who} answered ${res.status}.`);
  }
  return body as T;
}

// ---------- trips ----------

let snapshot = ''; // which published snapshot the page has (GitHub Pages)
let shapesFor = '';

/** `fresh`: the refresh button, so the server asks the sites again unless it just did */
export function fetchRoutes(fresh = false): Promise<RoutesResponse> {
  if (!STATIC) return getJson<RoutesResponse>(`/api/routes${fresh ? '?fresh=1' : ''}`);
  // GitHub Pages files are cached for up to 10 minutes; a new query string at most once a minute gets the latest
  const v = fresh ? Date.now() : Math.floor(Date.now() / 60000);
  return getJson<RoutesResponse>(`${DATA}trips.json?v=${v}`).then((r) => {
    snapshot = r.snapshotAt ?? r.fetchedAt;
    return r;
  });
}

export async function fetchGeometry(since = 0, want: string[] = []): Promise<GeometryResponse> {
  if (!STATIC) return getJson<GeometryResponse>(`/api/geometry?since=${since}${want.length ? `&want=${encodeURIComponent(want.join(','))}` : ''}`);
  // Road shapes are published with each snapshot: only fetch them when the trips changed
  if (!snapshot || snapshot === shapesFor) return { shapes: {}, saved: 0, pending: 0, serverTime: since };
  const want_ = snapshot;
  const r = await getJson<{ shapes: GeometryResponse['shapes'] }>(`${DATA}shapes.json?v=${encodeURIComponent(want_)}`);
  shapesFor = want_;
  return { shapes: r.shapes, saved: Object.keys(r.shapes).length, pending: 0, serverTime: Date.now() };
}

// ---------- place search ----------

const placeCache = new Map<string, Place[]>();

export async function fetchPlaces(q: string): Promise<Place[]> {
  if (!STATIC) return getJson<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(q)}`).then((r) => r.results);
  const key = q.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = placeCache.get(key);
  if (hit) return hit;
  let results: Place[] = [];
  try {
    results = parsePhoton(await getJson(photonSearchUrl(q), 'Photon'));
  } catch {
    /* try Nominatim */
  }
  if (!results.length) {
    try {
      results = parseNominatim(await getJson(`${nominatimSearchUrl(q)}&accept-language=en`, 'Nominatim'));
    } catch (err) {
      throw new Error(`Place search isn't working right now (${err instanceof Error ? err.message : err}).`);
    }
  }
  placeCache.set(key, results);
  return results;
}

// ---------- your trip's road ----------

type PlanRoad = { p: string; km: number; min: number };
const roadCache = new Map<string, PlanRoad>();

/** Fastest road route between two places (encoded polyline), for trip planning. */
export async function fetchPlanRoute(from: Place, to: Place): Promise<PlanRoad> {
  const a: [number, number] = [Number(from.lon.toFixed(5)), Number(from.lat.toFixed(5))];
  const b: [number, number] = [Number(to.lon.toFixed(5)), Number(to.lat.toFixed(5))];
  if (!STATIC) return getJson<PlanRoad>(`/api/route?from=${a[0]},${a[1]}&to=${b[0]},${b[1]}`);
  const key = `${a.map((n) => n.toFixed(3))};${b.map((n) => n.toFixed(3))}`;
  const hit = roadCache.get(key);
  if (hit) return hit;
  let last: unknown = null;
  for (const base of ROUTER_URLS) {
    try {
      const road = planEntry(a, b, parseOsrm(await getJson(osrmRouteUrl(base, a, b), new URL(base).host)));
      roadCache.set(key, road);
      return road;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`Couldn't find a road route (${last instanceof Error ? last.message : 'no routing server answered'}).`);
}
