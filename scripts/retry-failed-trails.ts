import { Pool } from 'pg';

const pool = new Pool({
  user: process.env.DB_USER ?? 'mountain_worker',
  password: process.env.DB_PASSWORD ?? 'mountain_secret_123',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5433),
  database: process.env.DB_NAME ?? 'mountain_db'
});

// The exact bounding boxes that failed based on your screenshots
const FAILED_BBOXES = [
  "(45.750, 9.400, 45.900, 9.700)",   // Chunk 33
  "(45.750, 10.300, 45.900, 10.600)",  // Chunk 36
  "(46.050, 10.600, 46.200, 10.900)",  // Chunk 57
  "(46.050, 10.900, 46.200, 11.200)",  // Chunk 58
  "(46.050, 11.200, 46.200, 11.500)",  // Chunk 59
  "(46.050, 11.500, 46.200, 11.800)",  // Chunk 60
  "(46.200, 8.800, 46.350, 9.100)",   // Chunk 61
  "(46.200, 9.400, 46.350, 9.700)"    // Chunk 63
];

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type OverpassPoint = {
  lon: number;
  lat: number;
};

async function retryFailedTrails() {
  console.log(`🔄 Retrying ${FAILED_BBOXES.length} previously failed chunks...`);

  for (let i = 0; i < FAILED_BBOXES.length; i++) {
    const bbox = FAILED_BBOXES[i];
    console.log(`\n⏳ Fetching Failed Chunk ${i + 1}/${FAILED_BBOXES.length} for extent: ${bbox}...`);
    
    // Hardcore backoff: starting at 30s to let the API breathe
    console.log("⏳ Waiting 30 seconds before requesting to avoid Rate Limiting...");
    await delay(30000);

    const query = `
      [out:json][timeout:90];
      way["highway"="path"]${bbox};
      out geom;
    `;

    let success = false;
    let retries = 5;

    while (!success && retries > 0) {
      try {
        const response = await fetch(OVERPASS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`
        });

        if (!response.ok) {
          const waitTime = response.status === 429 ? 120000 : 90000;
          console.warn(`⚠️ Got HTTP ${response.status}. Retrying in ${waitTime/1000} seconds... (${retries - 1} retries left)`);
          await delay(waitTime);
          retries--;
          continue;
        }

        const data = await response.json();
        
        let inserted = 0;
        for (const element of data.elements) {
          if (element.type === 'way' && element.geometry) {
            const coordinates = (element.geometry as OverpassPoint[]).map((pt) => `[${pt.lon}, ${pt.lat}]`).join(', ');
            const geojsonGeom = `{"type": "LineString", "coordinates": [${coordinates}]}`;
            
            const sacScale = element.tags && element.tags['sac_scale'] ? element.tags['sac_scale'] : 'unknown';
            const name = element.tags && element.tags['name'] ? element.tags['name'] : null;

            await pool.query(
              `INSERT INTO trails (osm_id, name, sac_scale, geom) 
               VALUES ($1, $2, $3, ST_Multi(ST_GeomFromGeoJSON($4)))
               ON CONFLICT (osm_id) DO NOTHING`,
              [element.id, name, sacScale, geojsonGeom]
            );
            inserted++;
          }
        }
        
        console.log(`✅ Success! Inserted ${inserted} trails into DB for this chunk.`);
        success = true;

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`❌ Network/Timeout error. Retrying in 90s... (${retries - 1} left)`);
        console.error(`   Reason: ${errorMessage}`);
        await delay(90000);
        retries--;
      }
    }

    if (!success) {
      console.error(`🚨 Chunk completed failed again: ${bbox}.`);
    }
  }

  console.log('\n🎉 Finished retrying failed chunks!');
  await pool.end();
}

retryFailedTrails();
