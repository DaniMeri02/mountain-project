import 'dotenv/config';
import { Pool } from 'pg';

// Free, stable GeoJSON of Italian administrative boundaries (EPSG:4326), names in Italian.
// Source: openpolis/geojson-italy. Override via env if you mirror them locally.
const REGIONS_URL =
  process.env.AREAS_REGIONS_URL ??
  'https://raw.githubusercontent.com/openpolis/geojson-italy/master/geojson/limits_IT_regions.geojson';
const PROVINCES_URL =
  process.env.AREAS_PROVINCES_URL ??
  'https://raw.githubusercontent.com/openpolis/geojson-italy/master/geojson/limits_IT_provinces.geojson';

interface GeoFeature {
  properties: Record<string, unknown>;
  geometry: unknown;
}
interface GeoFeatureCollection {
  features: GeoFeature[];
}

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  database: process.env.DB_NAME,
});

async function fetchCollection(url: string): Promise<GeoFeature[]> {
  const res = await fetch(url, { headers: { 'User-Agent': 'mountain-portal/1.0 (personal project)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const data = (await res.json()) as GeoFeatureCollection;
  return Array.isArray(data.features) ? data.features : [];
}

/** Pick the human name from a feature's properties for the given admin kind. */
function pickName(props: Record<string, unknown>, kind: 'region' | 'province'): string | null {
  const keys = kind === 'region' ? ['reg_name', 'name'] : ['prov_name', 'name'];
  for (const k of keys) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function importKind(
  client: import('pg').PoolClient,
  url: string,
  kind: 'region' | 'province',
): Promise<number> {
  const features = await fetchCollection(url);
  let inserted = 0;
  for (const feat of features) {
    const name = pickName(feat.properties, kind);
    if (!name || !feat.geometry) continue;
    await client.query(
      `INSERT INTO admin_areas (kind, name, geom)
       VALUES ($1, $2, ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($3)), 4326))`,
      [kind, name, JSON.stringify(feat.geometry)],
    );
    inserted += 1;
  }
  return inserted;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  console.log('Importing administrative boundaries...');
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM admin_areas'); // full refresh — idempotent re-runs
    const regions = await importKind(client, REGIONS_URL, 'region');
    console.log(`  ✓ ${regions} regions`);
    const provinces = await importKind(client, PROVINCES_URL, 'province');
    console.log(`  ✓ ${provinces} provinces`);
    await client.query('COMMIT');
    console.log(`\nDone. ${regions + provinces} areas imported.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Area import failed:', err);
  process.exit(1);
});
