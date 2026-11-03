import type { Corridor } from './types';

export type Shapes = Record<string, [number, number][]>;

/**
 * Curved stand-in line used until the real road shape has been looked up.
 * Bends to the right of the direction of travel, so A→B and B→A don't sit on top of each other.
 */
export function arc(from: [number, number], to: [number, number], segments = 32): [number, number][] {
  const [x1, y1] = from;
  const [x2, y2] = to;
  // Work in a roughly equal-area space (longitude shrinks with latitude)
  const k = Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
  const dx = (x2 - x1) * k;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1e-9;
  const bend = 0.12 * len;
  const cx = (x1 + x2) / 2 + (dy / len) * bend / k;
  const cy = (y1 + y2) / 2 - (dx / len) * bend;
  const pts: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
  }
  return pts;
}

/** Decode a Google "encoded polyline" (precision 5) into [lon, lat] pairs. */
export function decodePolyline(str: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20); // past the end, charCodeAt gives NaN, which stops the loop
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

/** Key of a road shape between two points. Must match geoKey() in server/geo.mjs. */
export function geoKey(a: { lat: number; lon: number }, b: { lat: number; lon: number }): string {
  return `${a.lat.toFixed(4)}/${a.lon.toFixed(4)}>${b.lat.toFixed(4)}/${b.lon.toFixed(4)}`;
}

export function lineFor(c: Corridor, shapes: Shapes): [number, number][] {
  return shapes[geoKey(c.from, c.to)] ?? arc([c.from.lon, c.from.lat], [c.to.lon, c.to.lat]);
}

export function boundsOf(points: [number, number][]): [[number, number], [number, number]] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}
