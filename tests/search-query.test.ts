import { describe, it, expect } from 'vitest';
import { buildSearchQuery } from '../agent/search-query';
import type { SearchFilter } from '../agent/types';

function mk(partial: Partial<SearchFilter>): SearchFilter {
  return { types: [], sort: 'elevation_desc', limit: 50, offset: 0, ...partial };
}

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('buildSearchQuery', () => {
  it('filters by requested POI types via type = ANY', () => {
    const { sql, params } = buildSearchQuery(mk({ types: ['hut'] }));
    expect(flat(sql)).toContain('type = ANY($1)');
    expect(params[0]).toEqual(['hut']);
  });

  it('defaults to all four types (incl. ferrata) when none are specified', () => {
    const f = flat(buildSearchQuery(mk({})).sql);
    expect(f).toContain('FROM pois');
    expect(f).toContain('ferrata_matches');
  });

  it('applies an elevation floor and excludes ferrata when elevation is set', () => {
    const { sql, params } = buildSearchQuery(mk({ elevation: { min: 3000 } }));
    const f = flat(sql);
    expect(f).toContain('elevation >= $2'); // $1 = poi types
    expect(f).not.toContain('ferrata_matches');
    expect(params[0]).toEqual(['peak', 'hut', 'bivouac']);
    expect(params).toContain(3000);
  });

  it('bivacchi sopra 3000 → bivouac + elevation >= 3000', () => {
    const { sql, params } = buildSearchQuery(mk({ types: ['bivouac'], elevation: { min: 3000 } }));
    const f = flat(sql);
    expect(f).toContain('type = ANY($1)');
    expect(f).toContain('elevation >= $2');
    expect(params[0]).toEqual(['bivouac']);
    expect(params[1]).toBe(3000);
  });

  it('applies an elevation ceiling with <=', () => {
    const { sql, params } = buildSearchQuery(mk({ types: ['hut'], elevation: { max: 1500 } }));
    expect(flat(sql)).toContain('elevation <= $2');
    expect(params).toContain(1500);
  });

  it('resolves a province area via ST_Intersects against admin_areas', () => {
    const { sql, params } = buildSearchQuery(
      mk({ types: ['hut'], elevation: { min: 2000 }, area: { kind: 'province', name: 'Bergamo' } }),
    );
    const f = flat(sql);
    expect(f).toContain('ST_Intersects(geom, (SELECT geom FROM admin_areas WHERE kind = $');
    expect(f).toContain('lower(name) = lower($');
    expect(params).toContain('province');
    expect(params).toContain('Bergamo');
  });

  it('resolves a viewport area via ST_MakeEnvelope with the bbox', () => {
    const bbox: [number, number, number, number] = [9.5, 45.8, 9.9, 46.1];
    const { sql, params } = buildSearchQuery(mk({ types: ['peak'], area: { kind: 'viewport', bbox } }));
    expect(flat(sql)).toContain('ST_MakeEnvelope(');
    for (const value of bbox) expect(params).toContain(value);
  });

  it('applies a sac_scale difficulty filter', () => {
    const { sql, params } = buildSearchQuery(
      mk({ types: ['ferrata'], difficulty: { sacScale: ['alpine_hiking'] } }),
    );
    expect(flat(sql)).toContain('sac_scale = ANY($');
    expect(params.some((p) => Array.isArray(p) && (p as string[]).includes('alpine_hiking'))).toBe(true);
  });

  it('applies a name ILIKE filter wrapped in %', () => {
    const { sql, params } = buildSearchQuery(mk({ types: ['hut'], nameContains: 'Curò' }));
    expect(flat(sql)).toContain('name ILIKE $');
    expect(params).toContain('%Curò%');
  });

  it('adds COUNT(*) OVER() total, ordering, limit and offset', () => {
    const { sql, params } = buildSearchQuery(mk({ types: ['peak'], sort: 'elevation_desc', limit: 50, offset: 50 }));
    const f = flat(sql);
    expect(f).toContain('COUNT(*) OVER() AS total');
    expect(f).toContain('ORDER BY elevation DESC NULLS LAST');
    expect(f).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(params).toContain(50);
  });

  it('orders by name when sort=name', () => {
    expect(flat(buildSearchQuery(mk({ sort: 'name' })).sql)).toContain('ORDER BY name ASC');
  });

  it('produces a ferrata-only query with no pois branch', () => {
    const f = flat(buildSearchQuery(mk({ types: ['ferrata'] })).sql);
    expect(f).toContain('ferrata_matches');
    expect(f).not.toContain('FROM pois');
  });

  it('returns a zero-row query when only ferrata is requested with an elevation filter', () => {
    const { sql, params } = buildSearchQuery(mk({ types: ['ferrata'], elevation: { min: 2000 } }));
    expect(flat(sql)).toContain('WHERE false');
    expect(params).toEqual([]);
  });

  it('expands a via ferrata grade range to letter + numeric tokens and drops the trails arm', () => {
    const { sql, params } = buildSearchQuery(
      mk({ types: ['ferrata'], difficulty: { viaFerrataScale: { min: 'D', max: 'F' } } }),
    );
    const f = flat(sql);
    expect(f).toContain('via_ferrata_scale = ANY($');
    const tokens = params.find((p) => Array.isArray(p)) as string[];
    expect(tokens).toEqual(expect.arrayContaining(['D', 'E', 'F', '4', '5', '6']));
    expect(tokens).not.toContain('A');
    // a via_ferrata_scale filter has no meaning for name-matched trails → that arm is dropped
    expect(f).not.toContain('FROM trails');
  });

  it('treats a min-only grade as "that grade and harder"', () => {
    const { params } = buildSearchQuery(
      mk({ types: ['ferrata'], difficulty: { viaFerrataScale: { min: 'D' } } }),
    );
    const tokens = params.find((p) => Array.isArray(p)) as string[];
    expect(tokens).toContain('D');
    expect(tokens).toContain('F');
    expect(tokens).not.toContain('A');
  });
});
