import 'dotenv/config';
import { createPool } from '../db';

const pool = createPool();

async function migrate(): Promise<void> {
  const client = await pool.connect();
  console.log('Connected to database. Running migration...');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_description_cache (
        id           BIGSERIAL    PRIMARY KEY,
        cache_key    TEXT         NOT NULL,
        poi_name     TEXT         NOT NULL,
        poi_type     TEXT         NOT NULL,
        description  TEXT         NOT NULL,
        sources      JSONB        NOT NULL DEFAULT '[]'::jsonb,
        generated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ  NOT NULL,
        CONSTRAINT uq_ai_cache_key UNIQUE (cache_key)
      )
    `);
    console.log('  ✓ Table ai_description_cache created (or already exists)');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_cache_expires
        ON ai_description_cache (expires_at)
    `);
    console.log('  ✓ Index idx_ai_cache_expires created (or already exists)');

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
