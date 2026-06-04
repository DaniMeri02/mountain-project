import 'dotenv/config';
import { Pool } from 'pg';

// Batch point-elevation API (lat/lng → metres). Open-Elevation is free & keyless;
// override with any compatible endpoint (e.g. a self-hosted OpenTopoData) via env.
const DEM_API_URL = process.env.DEM_API_URL ?? 'https://api.open-elevation.com/api/v1/lookup';
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 1_000; // be polite to the public endpoint

interface PoiRow {
  id: number;
  lat: number;
  lng: number;
}
interface ElevationResult {
  latitude: number;
  longitude: number;
  elevation: number | null;
}
interface ElevationResponse {
  results?: ElevationResult[];
}

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  database: process.env.DB_NAME,
});

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function lookupElevations(batch: PoiRow[]): Promise<Map<number, number>> {
  const res = await fetch(DEM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ locations: batch.map((p) => ({ latitude: p.lat, longitude: p.lng })) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from DEM API`);

  const data = (await res.json()) as ElevationResponse;
  const results = data.results ?? [];
  // The API returns results in the same order as the request.
  const byId = new Map<number, number>();
  batch.forEach((poi, i) => {
    const elevation = results[i]?.elevation;
    if (typeof elevation === 'number' && Number.isFinite(elevation)) {
      byId.set(poi.id, Math.round(elevation));
    }
  });
  return byId;
}

async function main(): Promise<void> {
  console.log('Backfilling missing POI elevations from the DEM API...');
  const { rows } = await pool.query<PoiRow>(
    `SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lng
     FROM pois
     WHERE elevation IS NULL OR elevation = 0`,
  );
  console.log(`  ${rows.length} POIs need an elevation.`);

  const batches = chunk(rows, BATCH_SIZE);
  let filled = 0;
  let failed = 0;

  for (let b = 0; b < batches.length; b += 1) {
    const batch = batches[b];
    try {
      const byId = await lookupElevations(batch);
      for (const [id, elevation] of byId) {
        await pool.query('UPDATE pois SET elevation = $1 WHERE id = $2', [elevation, id]);
        filled += 1;
      }
    } catch (err) {
      failed += batch.length;
      console.error(`  ! batch ${b + 1}/${batches.length} failed:`, err instanceof Error ? err.message : err);
    }
    console.log(`  …batch ${b + 1}/${batches.length} (filled ${filled}, failed ${failed})`);
    if (b < batches.length - 1) await sleep(BATCH_DELAY_MS);
  }

  console.log(`\nDone. Filled ${filled} elevations${failed ? `, ${failed} still missing (re-run to retry)` : ''}.`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error('Elevation backfill failed:', err);
  process.exit(1);
});
