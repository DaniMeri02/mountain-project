import { Pool } from 'pg';

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  database: process.env.DB_NAME,
});

// These boxes gave 504 timeouts because they were too dense with generic paths.
// We will split each of these into 4 smaller quadrants to ensure they succeed!
const failedBoxes = [
  { minLat: 45.750, minLon: 9.400, maxLat: 45.900, maxLon: 9.700 }, // Chunk 33
  { minLat: 45.750, minLon: 10.300, maxLat: 45.900, maxLon: 10.600 }, // Chunk 36
  { minLat: 46.050, minLon: 10.600, maxLat: 46.200, maxLon: 10.900 }, // Chunk 57
  { minLat: 46.050, minLon: 10.900, maxLat: 46.200, maxLon: 11.200 }, // Chunk 58
  { minLat: 46.050, minLon: 11.200, maxLat: 46.200, maxLon: 11.500 }, // Chunk 59
  { minLat: 46.050, minLon: 11.500, maxLat: 46.200, maxLon: 11.800 }, // Chunk 60
  { minLat: 46.200, minLon: 8.800, maxLat: 46.350, maxLon: 9.100 }, // Chunk 61
  { minLat: 46.200, minLon: 9.400, maxLat: 46.350, maxLon: 9.700 }  // Chunk 63
];

const MICRO_BBOXES: string[] = [];

for (const box of failedBoxes) {
  const midLat = (box.minLat + box.maxLat) / 2;
  const midLon = (box.minLon + box.maxLon) / 2;

  // Quadrant 1 (Bottom-Left)
  MICRO_BBOXES.push(`(${box.minLat.toFixed(3)}, ${box.minLon.toFixed(3)}, ${midLat.toFixed(3)}, ${midLon.toFixed(3)})`);
  // Quadrant 2 (Bottom-Right)
  MICRO_BBOXES.push(`(${box.minLat.toFixed(3)}, ${midLon.toFixed(3)}, ${midLat.toFixed(3)}, ${box.maxLon.toFixed(3)})`);
  // Quadrant 3 (Top-Left)
  MICRO_BBOXES.push(`(${midLat.toFixed(3)}, ${box.minLon.toFixed(3)}, ${box.maxLat.toFixed(3)}, ${midLon.toFixed(3)})`);
  // Quadrant 4 (Top-Right)
  MICRO_BBOXES.push(`(${midLat.toFixed(3)}, ${midLon.toFixed(3)}, ${box.maxLat.toFixed(3)}, ${box.maxLon.toFixed(3)})`);
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function recoverTrails() {
  console.log(`\n🛠️ Recovering ${failedBoxes.length} failed chunks by splitting them into ${MICRO_BBOXES.length} micro-chunks...`);
  
  const allFeatures = [];

  for (let i = 0; i < MICRO_BBOXES.length; i++) {
    const bbox = MICRO_BBOXES[i];
    console.log(`\n📦 Fetching Micro-Chunk ${i + 1}/${MICRO_BBOXES.length}: ${bbox}`);

    if (i > 0) {
      await delay(15000); // 15s wait to avoid rate limit
    }

    const query = `
      [out:json][timeout:300];
      (
        way["highway"="path"]${bbox};
        way["highway"="footway"]["sac_scale"]${bbox};
      );
      out body;
      >;
      out skel qt;
    `;

    let retries = 5;
    let success = false;

    while (retries > 0 && !success) {
      try {
        const response = await fetch(OVERPASS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`
        });

        if (response.status === 429 || response.status === 504) {
          const waitTime = response.status === 429 ? 120000 : 30000;
          console.log(`   ⚠️ HTTP ${response.status}. Waiting ${waitTime/1000}s... (${retries - 1} retries left)`);
          await delay(waitTime);
          retries--;
          continue;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        console.log(`   ✅ Found ${data.elements?.length || 0} OpenStreetMap elements.`);
        
        const nodes = new Map();
        const ways = [];

        for (const element of data.elements) {
          if (element.type === 'node') nodes.set(element.id, [element.lon, element.lat]);
          else if (element.type === 'way') ways.push(element);
        }

        for (const way of ways) {
          const tags = way.tags || {};
          if (!way.nodes || way.nodes.length < 2) continue;

          const coordinates = [];
          let valid = true;
          for (const nodeId of way.nodes) {
            const coords = nodes.get(nodeId);
            if (coords) coordinates.push(coords);
            else { valid = false; break; }
          }
          if (!valid || coordinates.length < 2) continue;

          if (tags.highway === 'footway' && !tags.sac_scale) continue;

          allFeatures.push({
            type: 'Feature',
            properties: {
              id: way.id,
              name: tags.name || '',
              sac_scale: tags.sac_scale || 'unknown',
              trail_visibility: tags.trail_visibility || 'unknown'
            },
            geometry: { type: 'LineString', coordinates: coordinates }
          });
        }
        success = true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        retries--;
        if (retries > 0) {
          console.log(`   ⚠️ Network Error. Waiting 30s...`);
          await delay(30000);
        } else {
          console.error(`   ❌ Failed micro-chunk permanently:`, errorMessage);
        }
      }
    }
  }

  console.log(`\n💾 Found ${allFeatures.length} trails in the recovered zones. Inserting into Database...`);
  
  let inserted = 0;
  for (const feature of allFeatures) {
    try {
      await pool.query(`
        INSERT INTO trails (osm_id, name, sac_scale, geom)
        VALUES ($1, $2, $3, ST_GeomFromGeoJSON($4))
        ON CONFLICT (osm_id) DO NOTHING;
      `, [ feature.properties.id, feature.properties.name, feature.properties.sac_scale, JSON.stringify(feature.geometry) ]);
      inserted++;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error(`⚠️ Failed to insert recovered trail ${feature.properties.id}: ${errorMessage}`);
    }
  }

  console.log(`✅ Recovery Complete. Saved ${inserted} paths to the database!`);
  await pool.end();
}

recoverTrails();
