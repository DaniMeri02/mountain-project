/**
 * Targeted import of highway=track for a specific bbox.
 * Run with: npx tsx scripts/patch-tracks-area.ts
 * Used to add mountain access tracks missing from the main trails table.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { createPool } from '../db';

const pool = createPool();

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Add bboxes here (south_lat, west_lng, north_lat, east_lng) where routing fails
// due to missing track connections between trail segments.
const PATCH_BBOXES = [
  '(45.95, 9.95, 46.15, 10.15)',  // Göi del Cà / Antonio Curò area
];

async function fetchAndInsertTracks(bboxStr: string) {
  const query = `
    [out:json][timeout:120];
    way["highway"="track"]${bboxStr};
    out body;
    >;
    out skel qt;
  `;

  console.log(`Fetching tracks for ${bboxStr}...`);
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'MountainPortal/1.0 (+https://github.com/DaniMeri02/mountain-project)',
    },
    body: `data=${encodeURIComponent(query)}`
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();

  const nodeMap = new Map<number, [number, number]>();
  const ways: any[] = [];
  for (const el of data.elements) {
    if (el.type === 'node') nodeMap.set(el.id, [el.lon, el.lat]);
    else if (el.type === 'way') ways.push(el);
  }

  let inserted = 0, skipped = 0;
  for (const way of ways) {
    if (!way.nodes || way.nodes.length < 2) continue;
    const coords: [number, number][] = [];
    let valid = true;
    for (const nid of way.nodes) {
      const c = nodeMap.get(nid);
      if (!c) { valid = false; break; }
      coords.push(c);
    }
    if (!valid || coords.length < 2) continue;
    if (way.tags?.tracktype === 'grade5') continue;

    const geojson = JSON.stringify({ type: 'LineString', coordinates: coords });
    try {
      const result = await pool.query(
        `INSERT INTO trails (osm_id, name, sac_scale, geom)
         VALUES ($1, $2, $3, ST_GeomFromGeoJSON($4))
         ON CONFLICT (osm_id) DO NOTHING`,
        [way.id, way.tags?.name || '', 'track', geojson]
      );
      if (result.rowCount && result.rowCount > 0) inserted++;
      else skipped++;
    } catch (e) {
      console.error(`Failed to insert way ${way.id}:`, e);
    }
  }
  console.log(`  → ${inserted} inserted, ${skipped} already existed (${ways.length} total ways)`);
}

async function main() {
  for (const bbox of PATCH_BBOXES) {
    await fetchAndInsertTracks(bbox);
  }
  await pool.end();
  console.log('Done.');
}

main().catch(console.error);
