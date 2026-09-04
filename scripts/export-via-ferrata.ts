import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';

type ExportViaFerrataRow = {
  osm_id: number;
  name: string | null;
  via_ferrata_scale: string | null;
  sac_scale: string | null;
  source_type: string;
  relation_ids: number[];
  tags: Record<string, string>;
  geometry: unknown;
};

type ExportChunkRow = {
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
  via_ferrata: ExportViaFerrataRow[];
  via_ferrata_import_chunks: ExportChunkRow[];
};

const dbHost = process.env.PGHOST || 'localhost';
const dbPort = Number(process.env.PGPORT || '5433');
const dbUser = process.env.PGUSER || 'mountain_worker';
const dbPassword = process.env.PGPASSWORD;
const dbName = process.env.PGDATABASE || 'mountain_db';

if (!Number.isFinite(dbPort)) {
  throw new Error('Invalid PGPORT value');
}

if (!dbPassword) {
  throw new Error('PGPASSWORD is required. This script reads PG* env vars directly, not .env');
}

const pool = new Pool({
  user: dbUser,
  password: dbPassword,
  host: dbHost,
  port: dbPort,
  database: dbName
});

function timestampForFile(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());

  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

async function run(): Promise<void> {
  const viaFerrataResult = await pool.query<ExportViaFerrataRow>(`
    SELECT
      osm_id,
      name,
      via_ferrata_scale,
      sac_scale,
      source_type,
      relation_ids,
      tags,
      ST_AsGeoJSON(geom)::json AS geometry
    FROM via_ferrata
    ORDER BY osm_id;
  `);

  const chunkResult = await pool.query<ExportChunkRow>(`
    SELECT
      chunk_key,
      chunk_index,
      min_lat,
      min_lon,
      max_lat,
      max_lon,
      status,
      attempts,
      last_error,
      updated_at::text
    FROM via_ferrata_import_chunks
    ORDER BY chunk_index;
  `);

  const now = new Date();
  const snapshot: ViaFerrataSnapshot = {
    exportedAt: now.toISOString(),
    source: {
      host: dbHost,
      port: dbPort,
      database: dbName
    },
    counts: {
      via_ferrata: viaFerrataResult.rowCount || 0,
      via_ferrata_import_chunks: chunkResult.rowCount || 0
    },
    via_ferrata: viaFerrataResult.rows,
    via_ferrata_import_chunks: chunkResult.rows
  };

  const outputDir = path.join(process.cwd(), 'exports');
  await fs.mkdir(outputDir, { recursive: true });

  const outputFile = path.join(outputDir, `via-ferrata-snapshot-${timestampForFile(now)}.json`);
  await fs.writeFile(outputFile, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log(`[DONE] Snapshot exported: ${outputFile}`);
  console.log(`[DONE] via_ferrata rows: ${snapshot.counts.via_ferrata}`);
  console.log(`[DONE] via_ferrata_import_chunks rows: ${snapshot.counts.via_ferrata_import_chunks}`);
}

run()
  .catch((error) => {
    console.error('[FATAL] Export failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
