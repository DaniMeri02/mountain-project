import type { Pool } from 'pg';
import type { PlaceStore } from './sources/google-places';

/**
 * A found place is kept forever: place IDs are the one Places field Google's caching policy
 * exempts from its storage restrictions, and a hut does not move.
 *
 * A verified absence is kept for a week. Bivouacs get added to Google Maps over time, so an
 * absence is a fact about today, not a permanent one — but re-asking on every request would spend
 * the free allowance on places that will never be listed.
 */
const ABSENCE_RECHECK_DAYS = 7;

/**
 * Ceilings for the spend guard. Google publishes no adjustable cap for SearchTextRequest
 * (75,000/day, marked non-adjustable), which is fifteen times the monthly free allowance, so the
 * limit has to be enforced here. 150/day caps a runaway loop within hours; 4,500/month keeps the
 * calendar month clear of the 5,000 free calls even if every day ran to its limit.
 */
const MAX_CALLS_PER_DAY = 150;
const MAX_CALLS_PER_MONTH = 4_500;

interface PlaceRow {
  place_id: string | null;
  poi_name: string;
}

/** UTC day and month keys. UTC, not local time, so a restart in a different zone cannot double-spend. */
export function usagePeriods(now: Date = new Date()): { day: string; month: string } {
  const day = now.toISOString().slice(0, 10);   // YYYY-MM-DD
  return { day, month: day.slice(0, 7) };       // YYYY-MM
}

export class GooglePlaceCache implements PlaceStore {
  constructor(private readonly pool: Pool) {}

  /** A previous lookup, or null when this POI is unknown or its recorded absence has gone stale. */
  async get(cacheKey: string): Promise<{ placeId: string | null; poiName: string } | null> {
    const result = await this.pool.query<PlaceRow>(
      `SELECT place_id, poi_name
         FROM google_place_cache
        WHERE cache_key = $1
          AND (place_id IS NOT NULL
               OR checked_at > NOW() - ($2 * INTERVAL '1 day'))`,
      [cacheKey, ABSENCE_RECHECK_DAYS],
    );

    if (result.rows.length === 0) return null;
    return { placeId: result.rows[0].place_id, poiName: result.rows[0].poi_name };
  }

  /** Records a hit (place id) or a verified absence (null). Never called for a failed lookup. */
  async save(cacheKey: string, poiName: string, placeId: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO google_place_cache (cache_key, place_id, poi_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (cache_key) DO UPDATE SET
         place_id   = EXCLUDED.place_id,
         poi_name   = EXCLUDED.poi_name,
         checked_at = NOW()`,
      [cacheKey, placeId, poiName],
    );
  }

  /**
   * Increments the daily and monthly counters together, and reports whether the call may proceed.
   *
   * The check and the increment are one statement: the UPDATE only touches the rows when both
   * counters are still under their ceilings, so a refused call is never counted and a permitted
   * one can never slip past the limit between reading and writing.
   */
  async reserveCall(now: Date = new Date()): Promise<boolean> {
    const { day, month } = usagePeriods(now);

    await this.pool.query(
      `INSERT INTO google_places_usage (period, calls)
       VALUES ($1, 0), ($2, 0)
       ON CONFLICT (period) DO NOTHING`,
      [day, month],
    );

    const result = await this.pool.query(
      `UPDATE google_places_usage
          SET calls = calls + 1
        WHERE period IN ($1, $2)
          AND (SELECT calls FROM google_places_usage WHERE period = $1) < $3
          AND (SELECT calls FROM google_places_usage WHERE period = $2) < $4`,
      [day, month, MAX_CALLS_PER_DAY, MAX_CALLS_PER_MONTH],
    );

    return result.rowCount === 2;
  }
}
