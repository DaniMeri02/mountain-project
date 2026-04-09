import { Pool } from 'pg';

const pool = new Pool({
  user: 'mountain_worker',
  password: 'mountain_secret_123',
  host: 'localhost',
  port: 5433,
  database: 'mountain_db'
});

// Same Alpine bounding box used in the previous imports
const BBOXES: string[] = [];
for (let lat = 45.3; lat < 46.8; lat += 0.15) {
  for (let lon = 8.8; lon < 11.8; lon += 0.3) {
    const nextLat = Math.min(lat + 0.15, 46.8);
    const nextLon = Math.min(lon + 0.3, 11.8);
    BBOXES.push(`(${lat.toFixed(3)},${lon.toFixed(3)},${nextLat.toFixed(3)},${nextLon.toFixed(3)})`);
  }
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type OverpassPoint = {
  lon: number;
  lat: number;
};

async function fetchTracks() {
  console.log(`🌐 Downloading trail-like paths (track, footway, bridleway, steps, cycleway) in ${BBOXES.length} chunks...`);
  
  for (let i = 0; i < BBOXES.length; i++) {
    const bbox = BBOXES[i];
    console.log(`\n📦 Fetching Chunk ${i + 1}/${BBOXES.length} for extent: ${bbox}`);
    
    // Add common OSM trail-like highway classes that are often visible in base maps.
    // This helps reduce "missing trail" perception at high zoom.
    const query = `
      [out:json][timeout:30];
      (
        way["highway"="track"]${bbox};
        way["highway"="footway"]${bbox};
        way["highway"="bridleway"]${bbox};
        way["highway"="steps"]${bbox};
        way["highway"="cycleway"]${bbox};
      );
      out geom;
    `;

    let retries = 5;
    let success = false;

    while (retries > 0 && !success) {
      if (i > 0 && retries === 5) {
        await delay(5000); // 5 sec polite delay between chunks
      }

      try {
        const response = await fetch(OVERPASS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`
        });

        if (response.status === 429 || response.status === 504) {
          const waitTime = response.status === 429 ? 30000 : 15000;
          console.log(`   ⚠️ Got HTTP ${response.status}. Retrying in ${waitTime/1000}s...`);
          await delay(waitTime);
          retries--;
          continue;
        }

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        
        const data = await response.json();
        
        let inserted = 0;
        for (const element of data.elements) {
          if (element.type === 'way' && element.geometry) {
            // Using "out geom;" makes Overpass return the line points directly!
            const coordinates = (element.geometry as OverpassPoint[]).map((pt) => `[${pt.lon}, ${pt.lat}]`).join(', ');
            const geojsonGeom = `{"type": "LineString", "coordinates": [${coordinates}]}`;
            
            const sacScale = element.tags?.sac_scale || 'unknown';
            const name = element.tags?.name || null;
            // Preserve source class when sac_scale is missing so frontend can style them explicitly if desired.
            const highway = element.tags?.highway || 'unknown';
            const rawScale = sacScale === 'unknown' ? highway : sacScale;
            const finalScale = String(rawScale).slice(0, 50);

            // Notice we ON CONFLICT DO NOTHING to avoid duplicating anything already in DB
            await pool.query(
              `INSERT INTO trails (osm_id, name, sac_scale, geom) 
               VALUES ($1, $2, $3, ST_Multi(ST_GeomFromGeoJSON($4)))
               ON CONFLICT (osm_id) DO NOTHING`,
              [element.id, name, finalScale, geojsonGeom]
            );
            inserted++;
          }
        }
        
        console.log(`   ✅ Inserted ${inserted} new trail-like ways into DB for chunk ${i+1}.`);
        success = true;

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        retries--;
        if (retries > 0) {
          console.log(`   ⚠️ Network error (${errorMessage}). Retrying in 10s...`);
          await delay(10000);
        } else {
          console.error(`   ❌ Failed Chunk ${i+1} entirely! Extent: ${bbox}`);
        }
      }
    }
  }
  
  console.log(`\n🔎 All chunks processed! Checking total records...`);
  const countRes = await pool.query('SELECT COUNT(*) FROM trails');
  console.log(`Total lines in DB is now: ${countRes.rows[0].count}`);
  
  pool.end();
}

fetchTracks().catch(console.error);
