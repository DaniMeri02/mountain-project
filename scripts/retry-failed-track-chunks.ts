import { Pool } from 'pg';

const pool = new Pool({
  user: 'mountain_worker',
  password: 'mountain_secret_123',
  host: 'localhost',
  port: 5433,
  database: 'mountain_db'
});

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type OverpassPoint = {
  lon: number;
  lat: number;
};

type OverpassWay = {
  type: 'way';
  id: number;
  geometry?: OverpassPoint[];
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OverpassWay[];
};

// Chunks that likely exhausted retries based on import logs/screenshots.
const FAILED_CHUNK_IDS = [41, 42, 43, 46, 60, 83, 100];

function buildBBoxes() {
  const boxes: Array<{ id: number; minLat: number; minLon: number; maxLat: number; maxLon: number }> = [];
  let id = 1;
  for (let lat = 45.3; lat < 46.8; lat += 0.15) {
    for (let lon = 8.8; lon < 11.8; lon += 0.3) {
      boxes.push({
        id,
        minLat: Number(lat.toFixed(3)),
        minLon: Number(lon.toFixed(3)),
        maxLat: Number(Math.min(lat + 0.15, 46.8).toFixed(3)),
        maxLon: Number(Math.min(lon + 0.3, 11.8).toFixed(3))
      });
      id++;
    }
  }
  return boxes;
}

function splitIntoMicro(box: { minLat: number; minLon: number; maxLat: number; maxLon: number }) {
  const midLat = Number(((box.minLat + box.maxLat) / 2).toFixed(3));
  const midLon = Number(((box.minLon + box.maxLon) / 2).toFixed(3));
  return [
    { minLat: box.minLat, minLon: box.minLon, maxLat: midLat, maxLon: midLon },
    { minLat: box.minLat, minLon: midLon, maxLat: midLat, maxLon: box.maxLon },
    { minLat: midLat, minLon: box.minLon, maxLat: box.maxLat, maxLon: midLon },
    { minLat: midLat, minLon: midLon, maxLat: box.maxLat, maxLon: box.maxLon }
  ];
}

function bboxString(b: { minLat: number; minLon: number; maxLat: number; maxLon: number }) {
  return `(${b.minLat.toFixed(3)},${b.minLon.toFixed(3)},${b.maxLat.toFixed(3)},${b.maxLon.toFixed(3)})`;
}

async function importMicroChunk(chunkId: number, microIdx: number, bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }) {
  const box = bboxString(bbox);
  const query = `
    [out:json][timeout:90];
    (
      way["highway"="track"]${box};
      way["highway"="footway"]${box};
      way["highway"="bridleway"]${box};
      way["highway"="steps"]${box};
      way["highway"="cycleway"]${box};
    );
    out geom;
  `;

  let retries = 6;
  while (retries > 0) {
    try {
      const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`
      });

      if (response.status === 429 || response.status === 504) {
        const waitMs = response.status === 429 ? 30000 : 15000;
        console.log(`  [chunk ${chunkId}.${microIdx}] HTTP ${response.status}, retrying in ${waitMs / 1000}s... (${retries - 1} left)`);
        retries--;
        await delay(waitMs);
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as OverpassResponse;
      let inserted = 0;
      for (const element of data.elements || []) {
        if (element.type !== 'way' || !element.geometry) continue;
        const coordinates = element.geometry.map((pt) => `[${pt.lon}, ${pt.lat}]`).join(', ');
        const geojsonGeom = `{"type":"LineString","coordinates":[${coordinates}]}`;
        const sacScale = element.tags?.sac_scale || 'unknown';
        const highway = element.tags?.highway || 'unknown';
        const finalScale = String(sacScale === 'unknown' ? highway : sacScale).slice(0, 50);
        const name = element.tags?.name || null;

        await pool.query(
          `INSERT INTO trails (osm_id, name, sac_scale, geom)
           VALUES ($1, $2, $3, ST_Multi(ST_GeomFromGeoJSON($4)))
           ON CONFLICT (osm_id) DO NOTHING`,
          [element.id, name, finalScale, geojsonGeom]
        );
        inserted++;
      }

      console.log(`  [chunk ${chunkId}.${microIdx}] success, inserted ${inserted}`);
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      retries--;
      if (retries <= 0) {
        console.error(`  [chunk ${chunkId}.${microIdx}] failed permanently: ${errorMessage}`);
        return false;
      }
      console.log(`  [chunk ${chunkId}.${microIdx}] error: ${errorMessage}, retrying in 10s... (${retries} left)`);
      await delay(10000);
    }
  }

  return false;
}

async function run() {
  const allBoxes = buildBBoxes();
  const targets = allBoxes.filter(b => FAILED_CHUNK_IDS.includes(b.id));

  console.log(`Retrying ${targets.length} failed chunks: ${FAILED_CHUNK_IDS.join(', ')}`);

  const failedMicros: string[] = [];
  for (const target of targets) {
    console.log(`\nChunk ${target.id} bbox ${bboxString(target)}`);
    const micros = splitIntoMicro(target);
    for (let i = 0; i < micros.length; i++) {
      const ok = await importMicroChunk(target.id, i + 1, micros[i]);
      if (!ok) failedMicros.push(`${target.id}.${i + 1}`);
      await delay(5000);
    }
  }

  if (failedMicros.length > 0) {
    console.log(`\nStill failed micro-chunks: ${failedMicros.join(', ')}`);
  } else {
    console.log('\nAll targeted failed chunks recovered successfully.');
  }

  const total = await pool.query('SELECT COUNT(*) AS c FROM trails');
  console.log(`Total trails now: ${total.rows[0].c}`);

  await pool.end();
}

run().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
