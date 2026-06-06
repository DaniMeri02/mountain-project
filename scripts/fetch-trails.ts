import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { createPool } from '../db';

const pool = createPool();

// Monte Rosa massif + surrounding Italian/Swiss valleys (Valsesia, Gressoney, Ayas, Zermatt, Saas-Fee)
// Chunked into 0.15x0.3 degree tiles to avoid Overpass timeouts.
// Uses ON CONFLICT DO NOTHING — safe to run alongside existing Lombardy data.
const BBOXES: string[] = [];
for (let lat = 45.5; lat < 46.2; lat += 0.15) {
  for (let lon = 7.4; lon < 8.8; lon += 0.3) {
    const nextLat = Math.min(lat + 0.15, 46.2);
    const nextLon = Math.min(lon + 0.3, 8.8);
    BBOXES.push(`(${lat.toFixed(3)}, ${lon.toFixed(3)}, ${nextLat.toFixed(3)}, ${nextLon.toFixed(3)})`);
  }
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTrails() {
  console.log(`🏔️ Downloading trail data from OpenStreetMap in ${BBOXES.length} chunks (Overpass API)...`);
  
  const allFeatures = [];

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

        const nodes = new Map();
        const ways = [];

        for (const element of data.elements) {
          if (element.type === 'node') {
            nodes.set(element.id, [element.lon, element.lat]);
          } else if (element.type === 'way') {
            ways.push(element);
          }
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

          let highwayType = tags.highway || '';
          // Skip basic urban footways to avoid UI clutter
          if (highwayType === 'footway' && !tags.sac_scale) continue;

          allFeatures.push({
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

  console.log(`\n💾 Inserting ${allFeatures.length} trails into PostgreSQL...`);
  
  for (const feature of allFeatures) {
    try {
      await pool.query(`
        INSERT INTO trails (osm_id, name, sac_scale, geom)
        VALUES ($1, $2, $3, ST_GeomFromGeoJSON($4))
        ON CONFLICT (osm_id) DO NOTHING;
      `, [
        feature.properties.id, 
        feature.properties.name, 
        feature.properties.sac_scale, 
        JSON.stringify(feature.geometry)
      ]);
    } catch (dbError) {
      console.error(`Failed to insert trail ${feature.properties.id}:`, dbError);
    }
  }

  console.log('✅ All trails securely saved to database!');
  await pool.end(); // gracefully close the DB connection
}

fetchTrails();
