import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { AgentInput, CachedDescription, CacheRow } from './types';

const CACHE_TTL_HOURS = 48;

/**
 * Builds a stable, unique cache key.
 * Prefers osm_id (globally unique in OSM) over name+type fallback.
 */
export function buildCacheKey(input: AgentInput): string {
  const raw =
    input.osm_id != null
      ? String(input.osm_id)
      : `${input.name.toLowerCase().trim()}::${input.type.toLowerCase().trim()}`;

  return createHash('sha256').update(raw).digest('hex');
}

export class AiDescriptionCache {
  constructor(private readonly pool: Pool) {}

  /** Returns a valid (non-expired) cached entry, or null. */
  async get(cacheKey: string): Promise<CachedDescription | null> {
    const result = await this.pool.query<CacheRow>(
      `SELECT description, sources, generated_at, expires_at
       FROM ai_description_cache
       WHERE cache_key = $1
         AND expires_at > NOW()`,
      [cacheKey]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      description: row.description,
      sources: Array.isArray(row.sources) ? row.sources : [],
      generatedAt: new Date(row.generated_at),
      expiresAt: new Date(row.expires_at),
    };
  }

  /** Inserts or overwrites a cache entry with a fresh 48h TTL. Returns the stored expiry date. */
  async set(
    cacheKey: string,
    poiName: string,
    poiType: string,
    description: string,
    sources: string[]
  ): Promise<Date> {
    const result = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO ai_description_cache
         (cache_key, poi_name, poi_type, description, sources, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6 * INTERVAL '1 hour'))
       ON CONFLICT (cache_key) DO UPDATE SET
         poi_name     = EXCLUDED.poi_name,
         poi_type     = EXCLUDED.poi_type,
         description  = EXCLUDED.description,
         sources      = EXCLUDED.sources,
         generated_at = NOW(),
         expires_at   = NOW() + ($6 * INTERVAL '1 hour')
       RETURNING expires_at`,
      [cacheKey, poiName, poiType, description, JSON.stringify(sources), CACHE_TTL_HOURS]
    );
    return new Date(result.rows[0].expires_at);
  }

  /** Hard-deletes a cache entry so the next request regenerates it. */
  async invalidate(cacheKey: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM ai_description_cache WHERE cache_key = $1',
      [cacheKey]
    );
  }
}
