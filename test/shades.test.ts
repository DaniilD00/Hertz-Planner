import { describe, expect, it } from 'vitest';
import { assignShades, cellsOf, mix, shadeColors } from '../src/shades';
import { PROVIDERS } from '../src/providers';
import type { Corridor, ProviderId } from '../src/types';

type LonLat = [number, number];

// Only id, provider and the line matter for shading
const route = (id: string, line: LonLat[], provider: ProviderId = 'hertz') => ({ id, provider, line }) as unknown as Corridor & { line: LonLat[] };
const lineOf = (c: Corridor) => (c as Corridor & { line: LonLat[] }).line;

// Along the E4 from Stockholm towards Jönköping, and pieces of it
const E4: LonLat[] = [
  [18.06, 59.33],
  [17.0, 58.75],
  [16.2, 58.59],
  [15.63, 58.41],
  [14.6, 57.95],
  [14.18, 57.78],
];

describe('shades for overlapping routes', () => {
  it('gives routes that share a stretch of road different shades', () => {
    const a = route('a', E4);
    const b = route('b', E4.slice(1)); // Nyköping → Jönköping: rides on top of a
    const c = route('c', E4.slice(0, 4)); // Stockholm → Linköping: also on top of a
    const shades = assignShades([a, b, c], lineOf);
    expect(new Set([shades.get('a'), shades.get('b'), shades.get('c')]).size).toBe(3);
  });

  it('keeps the main colour for a route that overlaps nothing', () => {
    const lonely = route('north', [
      [20.25, 63.81],
      [22.15, 65.58],
    ]);
    const shades = assignShades([route('a', E4), route('b', E4.slice(1)), lonely], lineOf);
    expect(shades.get('north')).toBe(0);
  });

  it('does not count two routes that only leave the same station', () => {
    const west = route('west', [
      [18.06, 59.33],
      [15.0, 59.3],
    ]);
    const north = route('north', [
      [18.06, 59.33],
      [17.9, 61.0],
    ]);
    const shades = assignShades([west, north], lineOf);
    expect(shades.get('west')).toBe(0);
    expect(shades.get('north')).toBe(0);
  });

  it('only shades within a site: a DriveBack trip on the same road keeps its own main colour', () => {
    const shades = assignShades([route('h', E4), route('d', E4, 'driveback')], lineOf);
    expect(shades.get('h')).toBe(0);
    expect(shades.get('d')).toBe(0);
  });

  it('keeps earlier shades when another, unrelated route turns up', () => {
    const a = route('a', E4);
    const b = route('b', E4.slice(1));
    const first = assignShades([a, b], lineOf);
    const lonely = route('n', [
      [20.25, 63.81],
      [22.15, 65.58],
    ]);
    const second = assignShades([lonely, b, a], lineOf, first);
    expect(second.get('a')).toBe(first.get('a'));
    expect(second.get('b')).toBe(first.get('b'));
  });

  it('is the same every time for the same routes', () => {
    const list = [route('x', E4), route('y', E4.slice(2)), route('z', E4.slice(0, 3))];
    expect([...assignShades(list, lineOf)]).toEqual([...assignShades([...list].reverse(), lineOf)]);
  });
});

describe('shade colours', () => {
  it('mixes colours', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#ffb547', '#ffb547', 0.7)).toBe('#ffb547');
  });

  it('derives lighter (dashed) and greyer (dotted) versions of each shade, all in the site family', () => {
    const c = shadeColors('hertz', 0);
    expect(c.now).toBe(PROVIDERS.hertz.colors.now);
    expect(c.soon).not.toBe(c.now);
    expect(c.later).not.toBe(c.now);
    expect(shadeColors('hertz', PROVIDERS.hertz.shades.length).now).toBe(c.now); // wraps round
  });

  it('marks the grid squares a line passes through', () => {
    const cells = cellsOf([
      [18.06, 59.33],
      [17.0, 58.75],
    ]);
    expect(cells.size).toBeGreaterThan(10); // ~84 km in 6 km squares
    expect(cellsOf([[18.06, 59.33]]).size).toBe(1);
  });
});
