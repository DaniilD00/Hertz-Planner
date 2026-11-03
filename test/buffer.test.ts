import { describe, expect, it } from 'vitest';
import { bufferLine, capsule, simplifyKm } from '../src/buffer';
import { haversineKm } from '../src/plan';

type LonLat = [number, number];

/** Even-odd point-in-polygon over every ring of every polygon (holes count as outside). */
function inside(mp: LonLat[][][], [x, y]: LonLat): boolean {
  let hit = false;
  for (const poly of mp)
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
  return hit;
}

/** Point `km` north (or east, for the east-west direction) of a point. */
const north = ([lon, lat]: LonLat, km: number): LonLat => [lon, lat + km / 110.574];
const east = ([lon, lat]: LonLat, km: number): LonLat => [lon + km / (111.32 * Math.cos((lat * Math.PI) / 180)), lat];

describe('the "within R km of my route" area', () => {
  it('covers points just inside the distance and leaves out points just beyond it', () => {
    const line: LonLat[] = [
      [15, 59],
      [18, 59],
    ];
    const area = bufferLine(line, 20);
    const mid: LonLat = [16.5, 59];
    expect(inside(area, north(mid, 18))).toBe(true);
    expect(inside(area, north(mid, 22))).toBe(false);
    expect(inside(area, north(mid, -18))).toBe(true);
    expect(inside(area, north(mid, -22))).toBe(false);
    // round ends
    expect(inside(area, east([18, 59], 18))).toBe(true);
    expect(inside(area, east([18, 59], 22))).toBe(false);
  });

  it('keeps its width in km far north, where a degree of longitude is short', () => {
    const line: LonLat[] = [
      [20, 66],
      [20, 68],
    ];
    const area = bufferLine(line, 20);
    expect(inside(area, east([20, 67], 19))).toBe(true);
    expect(inside(area, east([20, 67], 21))).toBe(false);
  });

  it('merges the pieces of a winding road into one smooth shape', () => {
    const zigzag: LonLat[] = [];
    for (let i = 0; i <= 40; i++) zigzag.push([14 + i * 0.1, 57 + (i % 2 ? 0.08 : 0)]);
    const area = bufferLine(zigzag, 15);
    expect(area).toHaveLength(1); // one polygon
    expect(area[0]).toHaveLength(1); // and no holes
    for (const p of zigzag) expect(inside(area, p)).toBe(true);
  });

  it('leaves a hole when the road loops round a wide enough area', () => {
    // a square loop 200 km across with a 20 km band: the middle stays outside
    const sq: LonLat[] = [
      [14, 57],
      [17.3, 57],
      [17.3, 58.8],
      [14, 58.8],
      [14, 57],
    ];
    const area = bufferLine(sq, 20);
    expect(inside(area, [15.65, 57.9])).toBe(false);
    expect(inside(area, [14, 57.9])).toBe(true);
  });

  it('handles a single point and a zero radius', () => {
    const dot = bufferLine([[15, 59]], 10);
    expect(inside(dot, north([15, 59], 9))).toBe(true);
    expect(inside(dot, north([15, 59], 11))).toBe(false);
    expect(bufferLine([[15, 59]], 0)).toEqual([]);
    expect(bufferLine([], 10)).toEqual([]);
  });
});

describe('simplifying a road before buffering', () => {
  it('drops points that barely change the shape and keeps the corners', () => {
    const line: LonLat[] = [];
    for (let i = 0; i <= 100; i++) line.push([15 + i * 0.01, 59 + (i === 50 ? 0.2 : 0.0001 * Math.sin(i))]);
    const out = simplifyKm(line, 1);
    expect(out.length).toBeLessThan(10);
    expect(out).toContainEqual(line[50]); // the 22 km spike survives
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[100]);
  });
});

describe('capsule around one segment', () => {
  it('is closed and stays at the radius from the segment', () => {
    const a: LonLat = [15, 59];
    const b: LonLat = [15.5, 59.2];
    const ring = capsule(a, b, 10);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // every corner of the ring is about 10 km from A or B (the round ends) or from the segment (the sides)
    for (const [lon, lat] of ring) {
      const d = Math.min(haversineKm(lat, lon, a[1], a[0]), haversineKm(lat, lon, b[1], b[0]));
      expect(d).toBeGreaterThan(9.5);
    }
  });
});
