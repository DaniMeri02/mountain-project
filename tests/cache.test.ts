import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCacheKey, AiDescriptionCache } from '../agent/cache';
import type { Pool } from 'pg';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function makeMockPool(rows: unknown[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

describe('buildCacheKey', () => {
  it('uses osm_id when present', () => {
    const key = buildCacheKey({ name: 'Rifugio Albani', type: 'hut', osm_id: 42 });
    expect(key).toBe(sha256('42'));
  });

  it('same name different case produces same key', () => {
    const a = buildCacheKey({ name: 'Rifugio Albani', type: 'hut' });
    const b = buildCacheKey({ name: 'RIFUGIO ALBANI', type: 'HUT' });
    expect(a).toBe(b);
  });

  it('falls back to name::type sha256 without osm_id', () => {
    const key = buildCacheKey({ name: 'Monte Albano', type: 'peak' });
    expect(key).toBe(sha256('monte albano::peak'));
  });
});

describe('AiDescriptionCache', () => {
  let pool: Pool;
  let cache: AiDescriptionCache;

  beforeEach(() => {
    pool = makeMockPool();
    cache = new AiDescriptionCache(pool);
  });

  it('get() returns null when no rows', async () => {
    const result = await cache.get('somekey');
    expect(result).toBeNull();
  });

  it('get() returns CachedDescription for a valid row', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    pool = makeMockPool([{
      description: 'Test description',
      sources: ['Wikidata', 'Komoot'],
      generated_at: now,
      expires_at: later,
    }]);
    cache = new AiDescriptionCache(pool);

    const result = await cache.get('somekey');
    expect(result).not.toBeNull();
    expect(result!.description).toBe('Test description');
    expect(result!.sources).toEqual(['Wikidata', 'Komoot']);
    expect(result!.generatedAt).toEqual(now);
    expect(result!.expiresAt).toEqual(later);
  });

  it('get() SQL includes expires_at > NOW() filter', async () => {
    await cache.get('mykey');
    const sql: string = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('expires_at > NOW()');
  });

  it('set() calls pool.query with ON CONFLICT DO UPDATE', async () => {
    await cache.set('key1', 'Rifugio Test', 'hut', 'A description.', ['Wikidata']);
    const sql: string = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO UPDATE');
  });

  it('set() serializes sources array as JSON string', async () => {
    const sources = ['Wikidata', 'Komoot', 'YouTube'];
    await cache.set('key1', 'Test', 'peak', 'Desc', sources);
    const params: unknown[] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(params[4]).toBe(JSON.stringify(sources));
  });

  it('invalidate() calls DELETE with correct key', async () => {
    await cache.invalidate('key-to-delete');
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('DELETE');
    expect(params[0]).toBe('key-to-delete');
  });

  it('sources survive JSON.stringify round-trip in set()', async () => {
    const sources = ['Wikidata', 'Rifugi', 'Reddit'];
    await cache.set('k', 'N', 't', 'd', sources);
    const params: unknown[] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(JSON.parse(params[4] as string)).toEqual(sources);
  });
});
