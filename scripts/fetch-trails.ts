import 'dotenv/config';
import { createPool } from '../db';

const pool = createPool();

// Covers the Monte Rosa massif (lon 7.4–8.8) AND the Lombardy/Bergamo extent
// (lon 8.8–11.8, lat 45.3–46.8) so trails match the POIs dataset. Chunked into
// 0.15x0.3° tiles to avoid Overpass timeouts. ON CONFLICT DO NOTHING dedups by
// osm_id, so the run is safe to repeat and resumes where it left off.
const LAT_MIN = 45.3, LAT_MAX = 46.8;
const LON_MIN = 7.4, LON_MAX = 11.8;
const LAT_STEP = 0.15, LON_STEP = 0.3;

const BBOXES: string[] = [];
for (let lat = LAT_MIN; lat < LAT_MAX; lat += LAT_STEP) {
  for (let lon = LON_MIN; lon < LON_MAX; lon += LON_STEP) {
    const nextLat = Math.min(lat + LAT_STEP, LAT_MAX);
    const nextLon = Math.min(lon + LON_STEP, LON_MAX);
    BBOXES.push(`(${lat.toFixed(3)}, ${lon.toFixed(3)}, ${nextLat.toFixed(3)}, ${nextLon.toFixed(3)})`);
  }
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type TrailFeature = {
  type: 'Feature';
  properties: { id: number; name: string; sac_scale: string; trail_visibility: string };
  geometry: { type: 'LineString'; coordinates: number[][] };
};

// Insert one chunk's trails immediately instead of accumulating every chunk in
// memory — the target box has only 2 GB RAM. ON CONFLICT DO NOTHING dedups by
// osm_id. Returns how many *new* rows landed.
async function insertTrails(features: TrailFeature[]): Promise<number> {
  let inserted = 0;
  for (const feature of features) {
    try {
      const res = await pool.query(`
        INSERT INTO trails (osm_id, name, sac_scale, geom)
        VALUES ($1, $2, $3, ST_GeomFromGeoJSON($4))
        ON CONFLICT (osm_id) DO NOTHING;
      `, [
        feature.properties.id,
        feature.properties.name,
        feature.properties.sac_scale,
        JSON.stringify(feature.geometry)
      ]);
      inserted += res.rowCount || 0;
    } catch (dbError) {
      console.error(`Failed to insert trail ${feature.properties.id}:`, dbError);
    }
  }
  return inserted;
}

async function fetchTrails() {
  console.log(`🏔️ Downloading trail data from OpenStreetMap in ${BBOXES.length} chunks (Overpass API)...`);

  let totalInserted = 0;

  for (let i = 0; i < BBOXES.length; i++) {
    const bbox = BBOXES[i];
    console.log(`\n⏳ Fetching Chunk ${i + 1}/${BBOXES.length} for extent: ${bbox}...`);

    // Throttle requests to avoid Overpass rate limit (HTTP 429)
    if (i > 0) {
      console.log(`   ⏳ Waiting 15 seconds before next request to avoid Rate Limiting...`);
      await delay(15000);
    }

    // Fetch mountain paths, rated footways, and tracks (mountain approach roads)
    const query = `
      [out:json][timeout:300];
      (
        way["highway"="path"]${bbox};
        way["highway"="footway"]["sac_scale"]${bbox};
        way["highway"="track"][~"tracktype"~"^(grade[1-4]|)$"]${bbox};
        way["highway"="track"][!"tracktype"]${bbox};
      );
      out body;
      >;
      out skel qt;
    `;

    let retries = 5; // Increased to 5 retries
    let success = false;

    while (retries > 0 && !success) {
      try {
        const response = await fetch(OVERPASS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': 'mountain-portal/1.0 (personal project)',
          },
          body: `data=${encodeURIComponent(query)}`
        });

        if (response.status === 429 || response.status === 504) {
          // 429 = Too Many Requests (need to cool down). Wait 120s!
          // 504 = Gateway Timeout (chunk is too heavy or server is busy). Wait 60s!
          const waitTime = response.status === 429 ? 120000 : 60000;
          console.log(`   ⚠️ Got HTTP ${response.status}. Retrying in ${waitTime/1000} seconds... (${retries - 1} retries left)`);
          await delay(waitTime);
          retries--;
          continue;
        }

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        console.log(`   ✅ Chunk ${i + 1} downloaded. Parsing ${data.elements.length} elements...`);

        const nodes = new Map<number, number[]>();
        const ways = [];

        for (const element of data.elements) {
          if (element.type === 'node') {
            nodes.set(element.id, [element.lon, element.lat]);
          } else if (element.type === 'way') {
            ways.push(element);
          }
        }

        const chunkFeatures: TrailFeature[] = [];
        for (const way of ways) {
          const tags = way.tags || {};
          if (!way.nodes || way.nodes.length < 2) continue;

          const coordinates: number[][] = [];
          let valid = true;
          for (const nodeId of way.nodes) {
            const coords = nodes.get(nodeId);
            if (coords) coordinates.push(coords);
            else { valid = false; break; }
          }

          if (!valid || coordinates.length < 2) continue;

          const highwayType = tags.highway || '';
          // Skip basic urban footways to avoid UI clutter
          if (highwayType === 'footway' && !tags.sac_scale) continue;

          chunkFeatures.push({
            type: 'Feature',
            properties: {
              id: way.id,
              name: tags.name || '',
              sac_scale: tags.sac_scale || (highwayType === 'track' ? 'track' : 'unknown'),
              trail_visibility: tags.trail_visibility || 'unknown'
            },
            geometry: {
              type: 'LineString',
              coordinates: coordinates
            }
          });
        }

        // Persist this chunk right away, then drop it from memory.
        const inserted = await insertTrails(chunkFeatures);
        totalInserted += inserted;
        console.log(`   💾 Chunk ${i + 1}: ${chunkFeatures.length} trails parsed, ${inserted} new (running total: ${totalInserted}).`);
        success = true;
      } catch (error) {
        retries--;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (retries > 0) {
          console.log(`   ⚠️ Network error (${errorMessage}). Retrying in 45 seconds...`);
          await delay(45000);
        } else {
          console.error(`   ❌ Failed fetching chunk ${i + 1} permanently:`, errorMessage);
        }
      }
    }
  }

  console.log(`\n✅ Done. Inserted ${totalInserted} new trails into the database.`);
  await pool.end(); // gracefully close the DB connection
}

fetchTrails();
