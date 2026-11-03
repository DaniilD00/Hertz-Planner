// The "how far from my route" area: everything within R km of the planned road, as a real polygon.
//
// It used to be drawn as a translucent line hundreds of pixels wide. MapLibre can't draw lines that wide along a
// winding road: the joins overlap and break into bright shards. A polygon is drawn once, with no overlaps, and its
// width is right in kilometres at every latitude and zoom.

import polygonClipping, { type MultiPolygon, type Pair, type Polygon, type Ring } from 'polygon-clipping';

type LonLat = [number, number];

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

function segmentDistance(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker with the tolerance in km (flat projection around the line's middle latitude). */
export function simplifyKm(coords: LonLat[], tolKm: number): LonLat[] {
  const n = coords.length;
  if (n <= 2) return coords.slice();
  const lat0 = coords[Math.floor(n / 2)][1];
  const kx = kmPerDegLon(lat0);
  const pts = coords.map(([lon, lat]) => [lon * kx, lat * KM_PER_DEG_LAT]);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let max = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(pts[i], pts[a], pts[b]);
      if (d > max) {
        max = d;
        at = i;
      }
    }
    if (at >= 0 && max > tolKm) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/**
 * A rounded "capsule" around one segment: two half circles joined by straight sides. Built in a flat projection at
 * the segment's own latitude, so a trip from Skåne to Lapland gets the same width in km all the way.
 */
export function capsule(a: LonLat, b: LonLat, km: number, steps = 12): Ring {
  const kx = kmPerDegLon((a[1] + b[1]) / 2);
  const ky = KM_PER_DEG_LAT;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * ky;
  const heading = Math.hypot(bx, by) > 1e-9 ? Math.atan2(by, bx) : 0;
  const at = (cx: number, cy: number, t: number): Pair => [a[0] + (cx + km * Math.cos(t)) / kx, a[1] + (cy + km * Math.sin(t)) / ky];
  const ring: Ring = [];
  // round the far end, then the near end (counter-clockwise)
  for (let i = 0; i <= steps; i++) ring.push(at(bx, by, heading - Math.PI / 2 + (i / steps) * Math.PI));
  for (let i = 0; i <= steps; i++) ring.push(at(0, 0, heading + Math.PI / 2 + (i / steps) * Math.PI));
  ring.push(ring[0]);
  return ring;
}

/**
 * Everything within `km` of the line, as MultiPolygon coordinates ([lon, lat]): the union of one capsule per segment
 * of a simplified copy of the line. The simplification never moves the line by more than about 8% of `km` (at most
 * 3 km), which is invisible at this scale and keeps the work to a few dozen milliseconds.
 */
export function bufferLine(coords: LonLat[], km: number): MultiPolygon {
  if (!coords.length || !(km > 0)) return [];
  let tol = Math.min(km * 0.08, 3);
  let pts = simplifyKm(coords, tol);
  for (let i = 0; pts.length > 180 && i < 8; i++) {
    tol *= 1.6;
    pts = simplifyKm(coords, tol);
  }
  const parts: Polygon[] = pts.length === 1 ? [[capsule(pts[0], pts[0], km)]] : [];
  for (let i = 1; i < pts.length; i++) parts.push([capsule(pts[i - 1], pts[i], km)]);
  try {
    return polygonClipping.union(parts[0], ...parts.slice(1));
  } catch {
    // Very rarely the union fails on awkward geometry: overlapping capsules still show the area
    return parts;
  }
}
