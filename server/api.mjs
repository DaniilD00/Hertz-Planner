// Local API used by both `npm run dev` (Vite middleware) and `npm start` (server.mjs).
//
//   GET /api/routes[?fresh=1]       Trips from every provider (Hertz Freerider, DriveBack, Drive4Free) in one common
//                                   format. Each provider is cached for 2.5 minutes (30 s with fresh=1, the refresh
//                                   button); if one is down its last trips are kept.
//   GET /api/geometry?since=&want=  Road shapes per pickup→drop-off pair. Each pair is looked up ONCE (fastest car route,
//                                   from OSRM / OpenStreetMap) and then kept forever in cache/geometry.json.
//   GET /api/geocode?q=             Place search for the From / To boxes (Photon, Nominatim fallback), cached.
//   GET /api/route?from=&to=        Fastest road route between two points (lon,lat), for trip planning; cached.
//
// The provider sites don't let other websites read their data from the browser (no CORS), so this server does it.

import path from 'node:path';
import zlib from 'node:zlib';
import { createGeo, encodePolyline, geoKey, parsePoint, simplify } from './geo.mjs';
import { PROVIDERS } from './providers/index.mjs';
import { jsonStore, sleep } from './util.mjs';

const PROVIDER_TTL_MS = 150 * 1000; // a little under the page's 3-minute refresh, so each refresh gets new trips
const FRESH_MIN_MS = 30 * 1000; // refresh button: ask a site again once its last answer is older than this
const PROVIDER_RETRY_MS = 60 * 1000; // after a failure, wait this long before asking that site again
const ROUTES_WAIT_MS = Number(process.env.ROUTES_WAIT_MS) || 8000; // answer with what's ready after this long at most
const ROUTES_GRACE_MS = 2000; // …or this long after the first site answered (the page asks again for the rest)
const LOOKUP_GAP_MS = Number(process.env.OSRM_GAP_MS) || 1100; // public routing servers allow ~1 request per second
const SIMPLIFY_TOLERANCE = 0.0001; // degrees (~10 m): follows the road at street zoom, ~4x smaller than raw
const SHAPE_VERSION = 2; // bump to re-fetch every cached shape in the background

/**
 * @typedef {{ p?: string, c?: number[][], km?: number, min?: number, v?: number, at?: number,
 *             src?: string, failedAt?: number, fails?: number }} Shape
 */

export function createApi({ cacheDir = 'cache', log = console } = {}) {
  const geo = createGeo({ cacheDir, log });
  const ctx = { locateAddress: geo.locateAddress, log };

  // ---------- providers ----------

  /** @type {Record<string, { data: any, at: number, error: string | null, errorAt: number, inflight: Promise<void> | null }>} */
  const state = Object.fromEntries(PROVIDERS.map((p) => [p.id, { data: null, at: 0, error: null, errorAt: 0, inflight: null }]));

  function refresh(p, maxAge = PROVIDER_TTL_MS) {
    const s = state[p.id];
    if (s.inflight) return s.inflight;
    if (s.data && Date.now() - s.at < maxAge) return Promise.resolve();
    if (s.error && Date.now() - s.errorAt < Math.min(PROVIDER_RETRY_MS, maxAge)) return Promise.resolve();
    s.inflight = (async () => {
      try {
        s.data = await p.fetch(ctx);
        s.at = Date.now();
        s.error = null;
      } catch (err) {
        s.error = err.message || String(err);
        s.errorAt = Date.now();
        log.warn?.(`[trip-map] ${p.name}: ${s.error}`);
      } finally {
        s.inflight = null;
      }
    })();
    return s.inflight;
  }

  /** `waitMs`: wait up to this long for every site (the GitHub snapshot job) instead of answering early. */
  async function allTrips({ fresh = false, waitMs = 0 } = {}) {
    const maxAge = fresh ? FRESH_MIN_MS : PROVIDER_TTL_MS;
    const jobs = PROVIDERS.map((p) => refresh(p, maxAge));
    if (waitMs) await Promise.race([Promise.allSettled(jobs), sleep(waitMs)]);
    // One slow or hanging site shouldn't hold up the others: answer when all are in, or shortly after the first one
    else await Promise.race([Promise.allSettled(jobs), Promise.race(jobs).then(() => sleep(ROUTES_GRACE_MS)), sleep(ROUTES_WAIT_MS)]);
    const stations = {};
    const offers = [];
    const providers = PROVIDERS.map((p) => {
      const s = state[p.id];
      if (s.data) {
        Object.assign(stations, s.data.stations);
        offers.push(...s.data.offers);
      }
      return {
        id: p.id,
        name: p.name,
        site: p.site,
        count: s.data?.offers.length ?? 0,
        unplaced: s.data?.unplaced ?? 0,
        fetchedAt: s.at ? new Date(s.at).toISOString() : null,
        error: s.error,
        stale: !!s.error && !!s.data,
        loading: !s.data && !!s.inflight,
      };
    });
    // "Updated …" in the page means the oldest answer shown
    const ats = PROVIDERS.map((p) => state[p.id]).filter((s) => s.data).map((s) => s.at);
    return { fetchedAt: new Date(ats.length ? Math.min(...ats) : Date.now()).toISOString(), providers, stations, offers };
  }

  // ---------- road shapes ----------

  const geometryStore = jsonStore(path.join(cacheDir, 'geometry.json'), log);
  /** @type {Record<string, Shape>} */
  let geometry = {};
  let geometryReady = null;
  /** @type {{ key: string, from: number[], to: number[] }[]} */
  let queue = [];
  const queued = new Set();
  let working = false;
  let stopAt = Infinity; // the snapshot job stops looking roads up when its time is up

  function loadGeometry() {
    geometryReady ??= geometryStore.load().then((data) => {
      geometry = data;
      // Shapes saved by the first version were plain coordinate lists; keep showing them until re-fetched.
      for (const s of Object.values(geometry)) {
        if (s.c && !s.p) {
          s.p = encodePolyline(s.c);
          delete s.c;
          s.v = 1;
          s.at ??= 0;
        }
      }
    });
    return geometryReady;
  }

  /** Failed lookups are retried after 2, 4, 8 … minutes, at most every 6 hours. */
  function retryDue(s) {
    if (!s?.failedAt) return true;
    const wait = Math.min(6 * 3600e3, 2 ** Math.min(s.fails || 1, 8) * 60e3);
    return Date.now() - s.failedAt >= wait;
  }

  function needsLookup(s) {
    if (!s) return true;
    if (s.p && s.v === SHAPE_VERSION) return false;
    return retryDue(s);
  }

  function enqueueGeometry({ stations, offers }) {
    const now = Date.now();
    const urgent = [];
    const normal = [];
    const upgrades = [];
    let migrated = false;
    for (const o of offers) {
      const a = stations[o.from];
      const b = stations[o.to];
      if (!a || !b) continue;
      const key = geoKey(a, b);
      // Road shapes used to be saved under Hertz station codes ("SWJKG61>SWGOT50"): move them to the new key.
      if (!geometry[key] && a.legacy && b.legacy && geometry[`${a.legacy}>${b.legacy}`]) {
        geometry[key] = geometry[`${a.legacy}>${b.legacy}`];
        delete geometry[`${a.legacy}>${b.legacy}`];
        migrated = true;
      }
      const known = geometry[key];
      if (!needsLookup(known) || queued.has(key)) continue;
      queued.add(key);
      const job = { key, from: [a.lon, a.lat], to: [b.lon, b.lat] };
      if (known?.p) upgrades.push(job); // already drawable; refresh at low priority
      else if (Date.parse(o.availableFrom) <= now) urgent.push(job); // available now: draw these first
      else normal.push(job);
    }
    if (migrated) geometryStore.save();
    queue = [...urgent, ...queue, ...normal, ...upgrades];
    void work();
  }

  /** Move the given pairs to the front of the queue (e.g. the route the user just clicked). */
  function prioritize(keys) {
    if (!keys.length) return;
    const wanted = new Set(keys);
    const front = queue.filter((j) => wanted.has(j.key));
    if (front.length) queue = [...front, ...queue.filter((j) => !wanted.has(j.key))];
  }

  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length && Date.now() < stopAt) {
        const job = queue.shift();
        const before = geometry[job.key];
        try {
          const route = await geo.osrmRoute(job.from, job.to);
          // Join the road line to the station dots (the router snaps the ends to the nearest road).
          geometry[job.key] = {
            p: encodePolyline(simplify([job.from, ...route.coordinates, job.to], SIMPLIFY_TOLERANCE)),
            km: route.km,
            min: route.min,
            v: SHAPE_VERSION,
            at: Date.now(),
            src: route.src,
          };
        } catch (err) {
          // Keep an older shape if there is one; just remember the failure so we back off.
          geometry[job.key] = { ...(before || {}), failedAt: Date.now(), fails: (before?.fails || 0) + 1 };
          log.warn?.(`[trip-map] no road for ${job.key}: ${err.message}`);
        }
        queued.delete(job.key);
        geometryStore.save();
        if (queue.length) await sleep(LOOKUP_GAP_MS);
      }
    } finally {
      working = false;
    }
  }

  // ---------- HTTP ----------

  function send(req, res, status, body) {
    let payload = Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (payload.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      payload = zlib.gzipSync(payload);
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(status, headers);
    res.end(payload);
  }

  /** Road shapes for the routes in `data` that have one: { key: { p, km, min } } (the GitHub Pages version's shapes.json). */
  function shapesFor({ stations, offers }) {
    const out = {};
    for (const o of offers) {
      const a = stations[o.from];
      const b = stations[o.to];
      if (!a || !b) continue;
      const key = geoKey(a, b);
      const s = geometry[key];
      if (s?.p) out[key] = { p: s.p, km: s.km, min: s.min };
    }
    return out;
  }

  /** For the snapshot job: look up missing roads until the queue is empty or `budgetMs` has passed. */
  async function lookUpRoads(data, budgetMs) {
    await loadGeometry();
    stopAt = Date.now() + budgetMs;
    enqueueGeometry(data);
    while (working || (queue.length && Date.now() < stopAt)) await sleep(200);
    const left = queue.length;
    queue = [];
    queued.clear();
    stopAt = Infinity;
    return left;
  }

  /** Node/Connect-style handler. Returns true when it answered the request. */
  async function handle(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) {
      if (next) next();
      return false;
    }
    try {
      if (pathname === '/api/routes') {
        const data = await allTrips({ fresh: url.searchParams.get('fresh') === '1' });
        await loadGeometry();
        enqueueGeometry(data);
        send(req, res, 200, data);
      } else if (pathname === '/api/geometry') {
        await loadGeometry();
        const since = Number(url.searchParams.get('since')) || 0;
        prioritize((url.searchParams.get('want') || '').split(',').filter(Boolean));
        const shapes = {};
        let saved = 0;
        for (const [key, s] of Object.entries(geometry)) {
          if (!s.p || !key.includes('/')) continue; // skip shapes still under old keys
          saved++;
          if ((s.at || 0) > since || since === 0) shapes[key] = { p: s.p, km: s.km, min: s.min };
        }
        send(req, res, 200, { shapes, saved, pending: queue.length + (working ? 1 : 0), serverTime: Date.now() });
      } else if (pathname === '/api/geocode') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) {
          send(req, res, 200, { results: [] });
          return true;
        }
        try {
          send(req, res, 200, { results: await geo.geocode(q.slice(0, 120)) });
        } catch (err) {
          send(req, res, 502, { error: `Place search isn't working right now (${err.message}).` });
        }
      } else if (pathname === '/api/route') {
        const from = parsePoint(url.searchParams.get('from'));
        const to = parsePoint(url.searchParams.get('to'));
        if (!from || !to) {
          send(req, res, 400, { error: 'from and to must be "lon,lat"' });
          return true;
        }
        try {
          send(req, res, 200, await geo.planRoute(from, to));
        } catch (err) {
          send(req, res, 502, { error: `Couldn't find a road route (${err.message}).` });
        }
      } else {
        send(req, res, 404, { error: 'Unknown API path' });
      }
    } catch (err) {
      send(req, res, 500, { error: `Something went wrong in the local server (${err.message}).` });
    }
    return true;
  }

  return Object.assign(handle, { allTrips, lookUpRoads, shapesFor });
}

// Re-exported for tests and older imports
export { encodePolyline, simplify } from './geo.mjs';
