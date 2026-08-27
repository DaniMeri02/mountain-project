import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { GooglePlaceCache, usagePeriods } from '../agent/google-place-cache';

/** A pool whose query() returns each queued result in turn. */
function makeMockPool(...results: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce({ rows: r.rows ?? [], rowCount: r.rowCount ?? 0 });
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  return { pool: { query } as unknown as Pool, query };
}

describe('usagePeriods', () => {
  it('derives UTC day and month keys', () => {
    expect(usagePeriods(new Date('2026-08-27T22:15:00Z'))).toEqual({ day: '2026-08-27', month: '2026-08' });
  });

  it('uses UTC, so a local-time zone shift cannot double-spend the allowance', () => {
    expect(usagePeriods(new Date('2026-08-31T23:30:00Z')).month).toBe('2026-08');
    expect(usagePeriods(new Date('2026-09-01T00:30:00Z')).month).toBe('2026-09');
  });
});

describe('GooglePlaceCache.get', () => {
  it('returns a stored place id', async () => {
    const { pool } = makeMockPool({ rows: [{ place_id: 'ChIJcuro', poi_name: 'Rifugio Antonio Curò' }] });
    const result = await new GooglePlaceCache(pool).get('key');
    expect(result).toEqual({ placeId: 'ChIJcuro', poiName: 'Rifugio Antonio Curò' });
  });

  it('returns a recorded absence as a null place id, not as a miss', async () => {
    const { pool } = makeMockPool({ rows: [{ place_id: null, poi_name: 'Bivacco Resnati' }] });
    const result = await new GooglePlaceCache(pool).get('key');
    expect(result).toEqual({ placeId: null, poiName: 'Bivacco Resnati' });
  });

  it('returns null when nothing is stored', async () => {
    const { pool } = makeMockPool({ rows: [] });
    expect(await new GooglePlaceCache(pool).get('key')).toBeNull();
  });

  it('keeps hits forever but expires absences after 7 days', async () => {
    const { pool, query } = makeMockPool({ rows: [] });
    await new GooglePlaceCache(pool).get('key');

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('place_id IS NOT NULL');
    expect(sql).toContain("INTERVAL '1 day'");
    expect(params[1]).toBe(7);
  });
});

describe('GooglePlaceCache.save', () => {
  it('upserts a found place and refreshes checked_at', async () => {
    const { pool, query } = makeMockPool({});
    await new GooglePlaceCache(pool).save('key', 'Rifugio Mirtillo', 'ChIJmirt');

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (cache_key) DO UPDATE');
    expect(sql).toContain('checked_at = NOW()');
    expect(params).toEqual(['key', 'ChIJmirt', 'Rifugio Mirtillo']);
  });

  it('stores a null place id for a verified absence', async () => {
    const { pool, query } = makeMockPool({});
    await new GooglePlaceCache(pool).save('key', 'Bivacco Resnati', null);
    expect(query.mock.calls[0][1]).toEqual(['key', null, 'Bivacco Resnati']);
  });
});

describe('GooglePlaceCache.reserveCall', () => {
  beforeEach(() => vi.clearAllMocks());

  it('permits the call when both counters moved', async () => {
    // first query seeds the rows, second is the conditional increment
    const { pool } = makeMockPool({}, { rowCount: 2 });
    expect(await new GooglePlaceCache(pool).reserveCall()).toBe(true);
  });

  it('refuses when a ceiling is reached — the UPDATE matches nothing', async () => {
    const { pool } = makeMockPool({}, { rowCount: 0 });
    expect(await new GooglePlaceCache(pool).reserveCall()).toBe(false);
  });

  it('checks and increments in one statement, so a refused call is never counted', async () => {
    const { pool, query } = makeMockPool({}, { rowCount: 2 });
    await new GooglePlaceCache(pool).reserveCall(new Date('2026-08-27T10:00:00Z'));

    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('SET calls = calls + 1');
    expect(sql).toContain('WHERE period IN ($1, $2)');
    expect(sql).toMatch(/AND \(SELECT calls .+ < \$3/s);
    expect(params).toEqual(['2026-08-27', '2026-08', 150, 4500]);
  });

  it('caps the month below the 5,000 free allowance', async () => {
    const { pool, query } = makeMockPool({}, { rowCount: 2 });
    await new GooglePlaceCache(pool).reserveCall();
    const [, params] = query.mock.calls[1];
    expect(params[3]).toBeLessThan(5000);
    expect(params[2] * 31).toBeLessThan(5000);
  });
});
