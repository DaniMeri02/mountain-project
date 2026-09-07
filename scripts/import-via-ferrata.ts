import fs from 'fs/promises';
import path from 'path';
import { Pool, PoolClient } from 'pg';

type SnapshotViaFerrataRow = {
  osm_id: number;
  name: string | null;
  via_ferrata_scale: string | null;
  sac_scale: string | null;
  source_type: string;
  relation_ids: number[];
  tags: Record<string, string>;
  geometry: unknown;
};

type SnapshotChunkRow = {
  chunk_key: string;
  chunk_index: number;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
  status: 'completed' | 'failed';
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

type ViaFerrataSnapshot = {
  exportedAt: string;
  source: {
    host: string;
    port: number;
    database: string;
  };
  counts: {
    via_ferrata: number;
    via_ferrata_import_chunks: number;
  };
  via_ferrata: SnapshotViaFerrataRow[];
  via_ferrata_import_chunks: SnapshotChunkRow[];
};

const dbHost = process.env.PGHOST || 'localhost';
const dbPort = Number(process.env.PGPORT || '5433');
const dbUser = process.env.PGUSER || 'mountain_worker';
const dbPassword = process.env.PGPASSWORD;
const dbName = process.env.PGDATABASE || 'mountain_db';
const shouldReset = /^(1|true|yes)$/i.test(process.env.FERRATA_IMPORT_RESET || 'false');

if (!Number.isFinite(dbPort)) {
  throw new Error('Invalid PGPORT value');
}

if (!dbPassword) {
  throw new Error('PGPASSWORD is required. This script reads PG* env vars directly, not .env');
}

const snapshotPathArg = process.argv[2];
if (!snapshotPathArg) {
  throw new Error('Missing snapshot file path. Usage: npm run import:ferrata -- "exports/via-ferrata-snapshot-YYYYMMDD-HHMMSS.json"');
}

const snapshotPath = path.resolve(process.cwd(), snapshotPathArg);

const pool = new Pool({
  user: dbUser,
  password: dbPassword,
  host: dbHost,
  port: dbPort,
  database: dbName
});

async function ensureTables(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS via_ferrata (
      id BIGSERIAL PRIMARY KEY,
      osm_id BIGINT UNIQUE NOT NULL,
      name TEXT,
      via_ferrata_scale TEXT,
      sac_scale TEXT,
      source_type TEXT NOT NULL,
      relation_ids BIGINT[] NOT NULL DEFAULT '{}',
      tags JSONB NOT NULL DEFAULT '{}'::jsonb,
      geom geometry(LineString, 4326) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query('CREATE INDEX IF NOT EXISTS via_ferrata_geom_idx ON via_ferrata USING GIST (geom);');

  await client.query(`
    CREATE TABLE IF NOT EXISTS via_ferrata_import_chunks (
      chunk_key TEXT PRIMARY KEY,
      chunk_index INTEGER NOT NULL,
      min_lat DOUBLE PRECISION NOT NULL,
      min_lon DOUBLE PRECISION NOT NULL,
      max_lat DOUBLE PRECISION NOT NULL,
      max_lon DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query('CREATE INDEX IF NOT EXISTS via_ferrata_import_chunks_status_idx ON via_ferrata_import_chunks(status);');
}

function parseSnapshot(content: string): ViaFerrataSnapshot {
  const parsed = JSON.parse(content) as ViaFerrataSnapshot;

  if (!Array.isArray(parsed.via_ferrata) || !Array.isArray(parsed.via_ferrata_import_chunks)) {
    throw new Error('Invalid snapshot format. Missing required arrays.');
  }

  return parsed;
}

async function importViaFerrataRows(client: PoolClient, rows: SnapshotViaFerrataRow[]): Promise<number> {
  let affectedRows = 0;

  const sql = `
    INSERT INTO via_ferrata (
      osm_id,
      name,
      via_ferrata_scale,
      sac_scale,
      source_type,
      relation_ids,
      tags,
      geom,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7::jsonb,
      ST_SetSRID(ST_GeomFromGeoJSON($8), 4326),
      NOW()
    )
    ON CONFLICT (osm_id) DO UPDATE
    SET
      name = EXCLUDED.name,
      via_ferrata_scale = EXCLUDED.via_ferrata_scale,
      sac_scale = EXCLUDED.sac_scale,
      source_type = EXCLUDED.source_type,
      relation_ids = EXCLUDED.relation_ids,
      tags = EXCLUDED.tags,
      geom = EXCLUDED.geom,
      updated_at = NOW();
  `;

  for (const row of rows) {
    const result = await client.query(sql, [
      row.osm_id,
      row.name,
      row.via_ferrata_scale,
      row.sac_scale,
      row.source_type,
      row.relation_ids,
      JSON.stringify(row.tags),
      JSON.stringify(row.geometry)
    ]);

    affectedRows += result.rowCount || 0;
  }

  return affectedRows;
}

async function importChunkRows(client: PoolClient, rows: SnapshotChunkRow[]): Promise<number> {
  let affectedRows = 0;

  const sql = `
    INSERT INTO via_ferrata_import_chunks (
      chunk_key,
      chunk_index,
      min_lat,
      min_lon,
      max_lat,
      max_lon,
      status,
      attempts,
      last_error,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10::timestamptz
    )
    ON CONFLICT (chunk_key) DO UPDATE
    SET
      chunk_index = EXCLUDED.chunk_index,
      min_lat = EXCLUDED.min_lat,
      min_lon = EXCLUDED.min_lon,
      max_lat = EXCLUDED.max_lat,
      max_lon = EXCLUDED.max_lon,
      status = EXCLUDED.status,
      attempts = EXCLUDED.attempts,
      last_error = EXCLUDED.last_error,
      updated_at = EXCLUDED.updated_at;
  `;

  for (const row of rows) {
    const result = await client.query(sql, [
      row.chunk_key,
      row.chunk_index,
      row.min_lat,
      row.min_lon,
      row.max_lat,
      row.max_lon,
      row.status,
      row.attempts,
      row.last_error,
      row.updated_at
    ]);

    affectedRows += result.rowCount || 0;
  }

  return affectedRows;
}

async function run(): Promise<void> {
  const rawContent = await fs.readFile(snapshotPath, 'utf8');
  const snapshot = parseSnapshot(rawContent);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureTables(client);

    if (shouldReset) {
      await client.query('TRUNCATE TABLE via_ferrata_import_chunks;');
      await client.query('TRUNCATE TABLE via_ferrata RESTART IDENTITY;');
    }

    const ferrataAffected = await importViaFerrataRows(client, snapshot.via_ferrata);
    const chunksAffected = await importChunkRows(client, snapshot.via_ferrata_import_chunks);

    await client.query('COMMIT');

    console.log(`[DONE] Imported snapshot: ${snapshotPath}`);
    console.log(`[DONE] via_ferrata records in file: ${snapshot.via_ferrata.length}`);
    console.log(`[DONE] via_ferrata_import_chunks records in file: ${snapshot.via_ferrata_import_chunks.length}`);
    console.log(`[DONE] via_ferrata affected rows: ${ferrataAffected}`);
    console.log(`[DONE] via_ferrata_import_chunks affected rows: ${chunksAffected}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error('[FATAL] Import failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
