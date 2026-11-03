// Shades for overlapping routes. Each site keeps its colour family (Hertz amber to yellow, DriveBack violet,
// Drive4Free teal), and routes that run over the same stretch of map get different shades of it, so a bundle of
// Hertz trips along the E4 reads as several lines instead of one orange band. A route that overlaps nothing keeps
// the site's main colour.

import { PROVIDERS } from './providers';
import type { Corridor, ProviderId } from './types';

type LonLat = [number, number];

const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (v: number[]) => `#${v.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`;

/** Blend colour `a` towards `b` by `t` (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

export interface ShadeColors {
  now: string; // solid line
  soon: string; // dashed: lighter
  later: string; // dotted: deeper and greyer
}

const colorCache = new Map<string, ShadeColors>();

/** The three line colours for shade number `shade` of a site. */
export function shadeColors(provider: ProviderId, shade = 0): ShadeColors {
  const key = `${provider}:${shade}`;
  let c = colorCache.get(key);
  if (!c) {
    const list = PROVIDERS[provider].shades;
    const now = list[((shade % list.length) + list.length) % list.length];
    c = { now, soon: mix(now, '#ffffff', 0.35), later: mix(now, '#5c6270', 0.3) };
    colorCache.set(key, c);
  }
  return c;
}

/** Small stable hash (FNV-1a), so ties are broken the same way on every refresh. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const CELL_KM = 6; // routes passing through the same 6 km squares overlap on the map
const STEP_KM = 2;
const MIN_SHARED = 3; // ignore routes that only touch (e.g. leave the same station in different directions)

/** The grid squares a line passes through (sinusoidal projection, so squares line up across the whole map). */
export function cellsOf(line: LonLat[]): Set<string> {
  const out = new Set<string>();
  const proj = ([lon, lat]: LonLat) => [lon * 111.32 * Math.cos((lat * Math.PI) / 180), lat * 110.574];
  for (let i = 0; i < line.length; i++) {
    const [ax, ay] = proj(line[i]);
    out.add(`${Math.floor(ax / CELL_KM)},${Math.floor(ay / CELL_KM)}`);
    if (i + 1 >= line.length) break;
    const [bx, by] = proj(line[i + 1]);
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / STEP_KM);
    for (let k = 1; k < n; k++) out.add(`${Math.floor((ax + ((bx - ax) * k) / n) / CELL_KM)},${Math.floor((ay + ((by - ay) * k) / n) / CELL_KM)}`);
  }
  return out;
}

/**
 * Picks a shade for every route. Routes of the same site that share at least a few squares count as overlapping,
 * weighted by how much they share; each route takes the shade that clashes least with the overlapping routes already
 * shaded, the most tangled routes first. Ties keep the route's previous shade, so colours stay put across refreshes,
 * then fall back to the site's main colour.
 */
export function assignShades(corridors: Corridor[], lineOf: (c: Corridor) => LonLat[], previous: Map<string, number> = new Map()): Map<string, number> {
  const out = new Map<string, number>();
  const bySite = new Map<ProviderId, Corridor[]>();
  for (const c of corridors) {
    if (!bySite.has(c.provider)) bySite.set(c.provider, []);
    bySite.get(c.provider)!.push(c);
  }
  for (const [site, group] of bySite) {
    const n = PROVIDERS[site].shades.length;
    const inCell = new Map<string, number[]>();
    group.forEach((c, i) => {
      for (const key of cellsOf(lineOf(c))) {
        if (!inCell.has(key)) inCell.set(key, []);
        inCell.get(key)!.push(i);
      }
    });
    const shared = group.map(() => new Map<number, number>());
    for (const list of inCell.values()) {
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          const i = list[a];
          const j = list[b];
          shared[i].set(j, (shared[i].get(j) ?? 0) + 1);
          shared[j].set(i, (shared[j].get(i) ?? 0) + 1);
        }
    }
    const weight = shared.map((m) => {
      let total = 0;
      for (const [j, w] of m) {
        if (w < MIN_SHARED) m.delete(j);
        else total += w;
      }
      return total;
    });
    const order = group.map((_, i) => i).sort((x, y) => weight[y] - weight[x] || hash(group[x].id) - hash(group[y].id));
    const shade = new Array<number>(group.length).fill(-1);
    for (const i of order) {
      const clash = new Array<number>(n).fill(0);
      for (const [j, w] of shared[i]) if (shade[j] >= 0) clash[shade[j]] += w;
      const prev = previous.get(group[i].id);
      let best = prev !== undefined && prev < n ? prev : 0;
      for (let s = 0; s < n; s++) if (clash[s] < clash[best]) best = s;
      shade[i] = best;
      out.set(group[i].id, best);
    }
  }
  return out;
}

/** Let CSS draw an element in a route's own line colours (list stripes, chooser swatches): --line, --line-soon, --line-later. */
export function setLineVars<T extends HTMLElement>(el: T, provider: ProviderId, shade = 0): T {
  const c = shadeColors(provider, shade);
  el.style.setProperty('--line', c.now);
  el.style.setProperty('--line-soon', c.soon);
  el.style.setProperty('--line-later', c.later);
  return el;
}
