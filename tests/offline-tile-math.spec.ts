import { describe, it, expect } from 'vitest';
// @ts-expect-error — .ts extension import requires allowImportingTsExtensions; resolved by Vitest at runtime.
import { tilesInBboxAtZoom, tileCountForRange, enumerateTiles } from '../src/tile-math.ts';

// Val Masino-ish bbox (~25 km × 25 km in northern Lombardy).
const VAL_MASINO_BBOX: [number, number, number, number] = [9.55, 46.16, 9.83, 46.36];

describe('tilesInBboxAtZoom', () => {
  it('returns a single tile at zoom 0', () => {
    const r = tilesInBboxAtZoom([-179, -85, 179, 85], 0);
    expect(r).toEqual({ z: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  it('flips the Y axis (north < south)', () => {
    const r = tilesInBboxAtZoom(VAL_MASINO_BBOX, 12);
    expect(r.minY).toBeLessThanOrEqual(r.maxY);
    // Sanity: numbers are within 2^12.
    expect(r.maxX).toBeLessThan(4096);
    expect(r.maxY).toBeLessThan(4096);
  });

  it('produces consistent counts at zoom 12 for a small Italy bbox', () => {
    const r = tilesInBboxAtZoom(VAL_MASINO_BBOX, 12);
    const count = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(20);
  });
});

describe('tileCountForRange', () => {
  it('matches the sum of single-zoom counts', () => {
    let manual = 0;
    for (let z = 12; z <= 16; z++) {
      const r = tilesInBboxAtZoom(VAL_MASINO_BBOX, z);
      manual += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
    }
    expect(tileCountForRange(VAL_MASINO_BBOX, 12, 16)).toBe(manual);
  });

  it('grows roughly 4× per added zoom level', () => {
    const z12 = tileCountForRange(VAL_MASINO_BBOX, 12, 12);
    const z13 = tileCountForRange(VAL_MASINO_BBOX, 13, 13);
    expect(z13).toBeGreaterThanOrEqual(z12 * 2);
    expect(z13).toBeLessThanOrEqual(z12 * 6);
  });

  it('returns positive count for the planned default range', () => {
    const total = tileCountForRange(VAL_MASINO_BBOX, 12, 16);
    expect(total).toBeGreaterThan(50);
    expect(total).toBeLessThan(5000);
  });

  it('handles single-zoom range', () => {
    const single = tileCountForRange(VAL_MASINO_BBOX, 14, 14);
    expect(single).toBeGreaterThan(0);
  });
});

describe('enumerateTiles', () => {
  it('yields exactly tileCountForRange items', () => {
    const total = tileCountForRange(VAL_MASINO_BBOX, 12, 14);
    let count = 0;
    for (const _ of enumerateTiles(VAL_MASINO_BBOX, 12, 14)) count++;
    expect(count).toBe(total);
  });

  it('yields tiles across all zoom levels in range', () => {
    const seen = new Set<number>();
    for (const t of enumerateTiles(VAL_MASINO_BBOX, 12, 14)) {
      seen.add(t.z);
    }
    expect(seen).toEqual(new Set([12, 13, 14]));
  });
});
