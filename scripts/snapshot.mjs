// Makes the data for the GitHub Pages version of the map, which has no server of its own.
//
// Runs in GitHub Actions every 10 minutes (see .github/workflows/deploy.yml): asks Hertz Freerider, DriveBack and
// Drive4Free for their trips, looks up addresses and road shapes, and writes
//   <out>/trips.json    the same feed the local server sends from /api/routes
//   <out>/shapes.json   road shapes for those trips, { "lat/lon>lat/lon": { p, km, min } }
// Addresses, road shapes and each site's last good answer are kept in cache/, which the workflow saves between runs,
// so each run only looks up what is new. If a site doesn't answer, its trips from the last run are kept (for up to a
// day) and the page says so, just like the local version.
//
//   node scripts/snapshot.mjs [out folder, default dist/data]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.mjs';
import { flushStores } from '../server/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'data'));
const cacheDir = path.resolve(process.env.CACHE_DIR || path.join(root, 'cache'));
const SITES_WAIT_MS = 120e3; // the first run looks up every DriveBack/Drive4Free address, which takes a while
const ROAD_BUDGET_MS = Number(process.env.ROAD_BUDGET_MS) || 4 * 60e3; // the rest are looked up on the next runs
const KEEP_STALE_MS = 24 * 3600e3;
const lastGoodFile = path.join(cacheDir, 'last-good.json');

const t0 = Date.now();
const log = { warn: (...a) => console.warn(...a), info: (...a) => console.log(...a) };
const api = createApi({ cacheDir, log });

let feed = await api.allTrips({ waitMs: SITES_WAIT_MS });
const left = await api.lookUpRoads(feed, ROAD_BUDGET_MS);
// A site that was still busy looking up addresses may have finished while the roads were looked up
feed = await api.allTrips({ waitMs: 1 });

// ---------- keep each site's last good answer ----------

/** @type {Record<string, { at: string, unplaced: number, stations: Record<string, any>, offers: any[] }>} */
let lastGood = {};
try {
  lastGood = JSON.parse(await readFile(lastGoodFile, 'utf8'));
} catch {
  /* first run */
}

const stations = {};
const offers = [];
const providers = feed.providers.map((p) => {
  const own = { stations: {}, offers: feed.offers.filter((o) => o.provider === p.id) };
  for (const [id, s] of Object.entries(feed.stations)) if (s.provider === p.id) own.stations[id] = s;
  const answered = p.fetchedAt && !p.error && !p.loading;
  if (answered) {
    lastGood[p.id] = { at: p.fetchedAt, unplaced: p.unplaced, ...own };
  }
  const old = lastGood[p.id];
  const useOld = !answered && old && Date.now() - Date.parse(old.at) < KEEP_STALE_MS && !own.offers.length;
  const use = useOld ? old : own;
  Object.assign(stations, use.stations);
  offers.push(...use.offers);
  return {
    ...p,
    count: use.offers.length,
    unplaced: useOld ? old.unplaced : p.unplaced,
    fetchedAt: useOld ? old.at : p.fetchedAt,
    error: answered ? null : p.error || (p.loading ? 'did not answer in time' : 'did not answer'),
    stale: !answered && use.offers.length > 0,
    loading: false,
  };
});

if (!offers.length) {
  console.error('No trips from any site, and nothing saved from earlier runs. Keeping the published map as it is.');
  for (const p of providers) console.error(`  ${p.name}: ${p.error}`);
  flushStores();
  process.exit(1);
}

const ats = providers.map((p) => p.fetchedAt).filter(Boolean).map((t) => Date.parse(t));
const now = new Date().toISOString();
const trips = { fetchedAt: new Date(Math.min(...ats)).toISOString(), snapshotAt: now, providers, stations, offers };
const shapes = api.shapesFor(trips);

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'trips.json'), JSON.stringify(trips));
await writeFile(path.join(outDir, 'shapes.json'), JSON.stringify({ snapshotAt: now, shapes }));
await mkdir(cacheDir, { recursive: true });
await writeFile(lastGoodFile, JSON.stringify(lastGood));
flushStores();

for (const p of providers) console.log(`${p.name}: ${p.count} trips${p.error ? ` (${p.stale ? 'kept from ' + p.fetchedAt + ', ' : ''}${p.error})` : ''}`);
console.log(`Road shapes: ${Object.keys(shapes).length} drawn, ${left} still to look up. Took ${Math.round((Date.now() - t0) / 1000)} s.`);
process.exit(0);
