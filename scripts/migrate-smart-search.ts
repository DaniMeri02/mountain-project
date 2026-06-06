import 'dotenv/config';
import { createPool } from '../db';

const pool = createPool();

async function migrate(): Promise<void> {
  const client = await pool.connect();
  console.log('Connected to database. Running smart-search migration...');

  try {
    // 1. Administrative boundaries (ISTAT/OSM provinces + regions) for area filters.
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_areas (
        id   BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL,            -- 'province' | 'region'
        name TEXT NOT NULL,            -- canonical name, e.g. 'Bergamo', 'Lombardia'
        geom geometry NOT NULL         -- (Multi)Polygon, SRID 4326
      )
    `);
    console.log('  ✓ Table admin_areas created (or already exists)');

    await client.query(`CREATE INDEX IF NOT EXISTS admin_areas_geom_gix ON admin_areas USING GIST (geom)`);
    console.log('  ✓ GIST index on admin_areas.geom');

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS admin_areas_kind_name_uidx ON admin_areas (kind, lower(name))`);
    console.log('  ✓ Unique index on admin_areas (kind, lower(name))');

    // 2. Elevation: stop conflating "unknown" with sea level. Make it nullable, then
    //    convert the 0 sentinels to NULL (no Alpine peak/hut/bivouac sits at 0 m), so
    //    "sopra i N metri" filters exclude unknowns honestly. Best-effort: this needs
    //    ownership of `pois`; if the app role lacks it, the feature still works because
    //    backfill:elevation fills both NULL *and* 0 rows with real DEM elevations.
    try {
      await client.query(`ALTER TABLE pois ALTER COLUMN elevation DROP NOT NULL`);
      const updated = await client.query(`UPDATE pois SET elevation = NULL WHERE elevation = 0`);
      console.log(`  ✓ pois.elevation is now nullable; ${updated.rowCount ?? 0} zero-sentinels set to NULL`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ! Skipped pois.elevation nullability change (${msg}).`);
      console.warn(`    Run it once as the table owner: ALTER TABLE pois ALTER COLUMN elevation DROP NOT NULL;`);
      console.warn(`    Not required for the feature — backfill:elevation still fixes 0/NULL elevations.`);
    }

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
