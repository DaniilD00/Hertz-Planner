// Place search, address lookup and fastest-road routing (all OpenStreetMap-based, cached on disk).

import path from 'node:path';
import {
  NOMINATIM_URL,
  PHOTON_URL,
  ROUTER_URLS,
  haversineKm,
  nominatimSearchUrl,
  osrmRouteUrl,
  parseNominatim,
  parseOsrm,
  parsePhoton,
  photonSearchUrl,
  planEntry,
} from './geo-core.mjs';
import { fetchJson, jsonStore, sleep, trimStore } from './util.mjs';

// The pure helpers live in geo-core.mjs so the browser can use them too; re-exported here for the server.
export { encodePolyline, geoKey, haversineKm, simplify } from './geo-core.mjs';

const PHOTON = (process.env.PHOTON_URL || PHOTON_URL).replace(/\/$/, '');
const NOMINATIM = (process.env.NOMINATIM_URL || NOMINATIM_URL).replace(/\/$/, '');
// Fastest-route servers (same OSRM API). The first that answers wins; the rest are fallbacks.
const ROUTERS = (process.env.OSRM_URL ? process.env.OSRM_URL.split(',') : ROUTER_URLS).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
// Search hits that are a whole place rather than a street or building
const TOWNISH = /^(city|town|village|hamlet|suburb|quarter|neighbourhood|borough|municipality|county|state|region|administrative|locality|isolated_dwelling|island|postcode|district)$/;

export function createGeo({ cacheDir = 'cache', log = console } = {}) {
  const places = jsonStore(path.join(cacheDir, 'places.json'), log); // what people type in From / To
  const addresses = jsonStore(path.join(cacheDir, 'addresses.json'), log); // where provider addresses are
  const plans = jsonStore(path.join(cacheDir, 'plan-routes.json'), log);
  // Both public search services ask for at most about one request per second.
  let photonChain = Promise.resolve();
  let nominatimChain = Promise.resolve();
  const throttled = (which, fn) => {
    const chain = which === 'photon' ? photonChain : nominatimChain;
    const run = chain.then(fn);
    const next = run.catch(() => {}).then(() => sleep(which === 'photon' ? 350 : 1100));
    if (which === 'photon') photonChain = next;
    else nominatimChain = next;
    return run;
  };

  async function search(q) {
    let results = [];
    try {
      results = await throttled('photon', () => photonSearch(q));
    } catch (err) {
      log.warn?.('[trip-map] place search (Photon) failed:', err.message);
    }
    if (!results.length) {
      try {
        results = await throttled('nominatim', () => nominatimSearch(q));
      } catch (err) {
        log.warn?.('[trip-map] place search (Nominatim) failed:', err.message);
        throw new Error('the place search services did not answer');
      }
    }
    return results;
  }

  /** Place search for the From / To boxes. */
  async function geocode(q) {
    const key = q.trim().toLowerCase().replace(/\s+/g, ' ');
    const cache = await places.load();
    if (cache[key]) return cache[key].results;
    const results = await search(q);
    cache[key] = { results, at: Date.now() };
    trimStore(cache, 500);
    places.save();
    return results;
  }

  /**
   * Find a provider's pickup/drop-off address on the map.
   *  - `text`: full address, e.g. "Sanddynevägen 40, 311 32 Falkenberg"
   *  - `town`: fallback place name if the street can't be found
   *  - `near` + `maxKm`: reject matches far from where the provider says the place is
   * Returns { lat, lon, precision: 'address' | 'town', city } or null. Results (and misses) are saved for good.
   */
  async function locateAddress({ text, town = null, near = null, maxKm = 60 }) {
    const key = `${text}|${town || ''}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ''}`.toLowerCase();
    const cache = await addresses.load();
    const hit = cache[key];
    if (hit && (hit.result || Date.now() - hit.at < 24 * 3600e3)) return hit.result;
    let result = null;
    try {
      // Without coordinates from the provider, find the town first, so that a street with the same name
      // somewhere else in the country can't win. Town lookups share the place-search cache.
      let anchor = near;
      let townHit = null;
      if (!anchor && town) {
        townHit = (await geocode(town))[0] || null;
        if (townHit) anchor = { lat: townHit.lat, lon: townHit.lon };
      }
      const ok = (r) => !anchor || haversineKm(anchor.lat, anchor.lon, r.lat, r.lon) <= maxKm;
      const byAddress = (await search(text)).find(ok);
      // A hit on a town or area (not a street or building) is only as precise as the town
      if (byAddress) result = { lat: byAddress.lat, lon: byAddress.lon, precision: TOWNISH.test(byAddress.kind || '') ? 'town' : 'address', city: byAddress.city || null };
      if (!result && town) {
        const byTown = townHit || (await geocode(town)).find(ok);
        if (byTown) result = { lat: byTown.lat, lon: byTown.lon, precision: 'town', city: byTown.city || town };
      }
    } catch (err) {
      log.warn?.(`[trip-map] couldn't look up "${text}": ${err.message}`);
      if (!near) return null; // try again next time
    }
    if (!result && near) result = { lat: near.lat, lon: near.lon, precision: 'town', city: town };
    cache[key] = { result, at: Date.now() };
    addresses.save();
    return result;
  }

  async function photonSearch(q) {
    return parsePhoton(await fetchJson(photonSearchUrl(q, PHOTON), { timeoutMs: 10000, label: 'Photon' }));
  }

  async function nominatimSearch(q) {
    return parseNominatim(await fetchJson(nominatimSearchUrl(q, NOMINATIM), { headers: { 'accept-language': 'en' }, timeoutMs: 10000, label: 'Nominatim' }));
  }

  /** Fastest car route between two [lon, lat] points; tries each routing server in turn. */
  async function osrmRoute(from, to) {
    let lastError = null;
    for (const base of ROUTERS) {
      try {
        const route = parseOsrm(await fetchJson(osrmRouteUrl(base, from, to), { timeoutMs: 25000, label: new URL(base).host }));
        return { ...route, src: new URL(base).host };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('no routing server configured');
  }

  /** Road route between your start and destination (trip planning), cached. */
  async function planRoute(from, to) {
    const key = `${from.map((n) => n.toFixed(3)).join(',')};${to.map((n) => n.toFixed(3)).join(',')}`;
    const cache = await plans.load();
    if (cache[key]) return cache[key];
    const route = await osrmRoute(from, to);
    const entry = { ...planEntry(from, to, route), at: Date.now() };
    cache[key] = entry;
    trimStore(cache, 300);
    plans.save();
    return entry;
  }

  return { geocode, locateAddress, osrmRoute, planRoute };
}

export function parsePoint(v) {
  const m = /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v || '');
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
}
