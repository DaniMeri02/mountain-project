import 'dotenv/config';
import { createPool } from '../db';

const pool = createPool();

async function migrate(): Promise<void> {
  const client = await pool.connect();
  console.log('Connected to database. Running migration...');

  try {
    // One row per POI ever looked up on Google Places. A NULL place_id is a *verified absence*,
    // not a missing lookup — the difference is what lets us print "no link" honestly.
    // Only the place ID is stored: Google's caching policy exempts place IDs from its storage
    // restrictions, and the Maps URL is rebuilt from the ID on every read.
    await client.query(`
      CREATE TABLE IF NOT EXISTS google_place_cache (
        cache_key  TEXT         PRIMARY KEY,
        place_id   TEXT,
        poi_name   TEXT         NOT NULL,
        checked_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    console.log('  ✓ Table google_place_cache created (or already exists)');

    // Absences are re-checked after a while, so the sweep for stale NULL rows is indexed.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_google_place_cache_recheck
        ON google_place_cache (checked_at)
        WHERE place_id IS NULL
    `);
    console.log('  ✓ Index idx_google_place_cache_recheck created (or already exists)');

    // Spend guard. Google exposes no adjustable cap for SearchTextRequest (75,000/day, marked
    // non-adjustable), which is 15x the monthly free allowance — so the ceiling lives here.
    // One row per calendar day and one per month; both are checked before every API call.
    await client.query(`
      CREATE TABLE IF NOT EXISTS google_places_usage (
        period TEXT     PRIMARY KEY,
        calls  INTEGER  NOT NULL DEFAULT 0
      )
    `);
    console.log('  ✓ Table google_places_usage created (or already exists)');

    console.log('\nMigration completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
