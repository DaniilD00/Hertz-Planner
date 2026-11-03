// Small shared helpers for the local server (no dependencies).

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const USER_AGENT = 'free-car-trips-map/0.5 (personal trip map: Hertz Freerider, DriveBack, Drive4Free)';
export const TZ = 'Europe/Stockholm';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a URL and parse JSON, with a timeout and a clear error message. */
export async function fetchJson(url, { headers = {}, timeoutMs = 20000, label = new URL(url).host } = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${label} answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${label} sent something that isn't JSON`);
  }
}

/** A JSON object kept in memory and saved to disk (debounced). */
const pendingStores = new Set();

/** Write every cache file that has unsaved changes, right now (on shutdown or restart). */
export function flushStores() {
  for (const store of pendingStores) store.flush();
}

export function jsonStore(file, log = console) {
  let data = null;
  let loading = null;
  let timer = null;
  const store = {
    /** Synchronous write of unsaved changes, for when the process is about to stop. */
    flush() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      pendingStores.delete(store);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify(data));
        renameSync(file + '.tmp', file);
      } catch (err) {
        log.warn?.(`[trip-map] could not save ${path.basename(file)}:`, err.message);
      }
    },
    load() {
      if (data) return Promise.resolve(data);
      loading ??= readFile(file, 'utf8')
        .then((t) => (data = JSON.parse(t)))
        .catch(() => (data = {}));
      return loading;
    },
    save() {
      clearTimeout(timer);
      pendingStores.add(store);
      timer = setTimeout(async () => {
        timer = null;
        pendingStores.delete(store);
        try {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file + '.tmp', JSON.stringify(data));
          await rename(file + '.tmp', file);
        } catch (err) {
          log.warn?.(`[trip-map] could not save ${path.basename(file)}:`, err.message);
        }
      }, 1500);
    },
  };
  return store;
}

/** Keep only the newest `max` entries (by `at`). */
export function trimStore(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  keys.sort((a, b) => (obj[a].at || 0) - (obj[b].at || 0));
  for (const k of keys.slice(0, keys.length - max)) delete obj[k];
}

// ---------- time zones ----------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Swedish wall-clock parts (year, month 1-12, day, hour, minute, second) of an instant. */
export function stockholmParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** The instant at which Swedish clocks show the given wall time (handles summer/winter time). */
export function stockholmWallToUtcMs(y, mo, d, h = 0, mi = 0, s = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = stockholmParts(t);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const next = t - (shown - wall);
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Some sites store Swedish wall-clock time with a "Z" on the end (DriveBack shows "…T13:00:00.000Z" as 13:00).
 * Read the digits as Swedish local time and return the real instant as an ISO string.
 */
export function wallTimeAsStockholm(isoLike) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(isoLike || ''));
  if (!m) return null;
  return new Date(stockholmWallToUtcMs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString();
}

/** Hertz sends UTC without the "Z". */
export function utcFromNaive(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** End of the Swedish calendar day that contains the given instant (23:59). */
export function endOfStockholmDay(iso) {
  const p = stockholmParts(Date.parse(iso));
  return new Date(stockholmWallToUtcMs(p.y, p.mo, p.d, 23, 59, 0)).toISOString();
}

/** "HH:MM" in Swedish time for a stored opening time like "1970-01-01T07:00:00" (stored as UTC, like hertzfreerider.se reads it). */
export function hhmmStockholm(naiveUtc) {
  const iso = utcFromNaive(naiveUtc);
  if (!iso) return null;
  const p = stockholmParts(Date.parse(iso));
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

// ---------- text ----------

export function slug(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** "MALMÖ" → "Malmö", "THOMSONS VÄG 1" → "Thomsons Väg 1"; mixed-case text is left alone. */
export function tidyCase(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (!t || t !== t.toUpperCase() || !/[A-ZÅÄÖÆØ]{3}/.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}
