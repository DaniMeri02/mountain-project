import fs from 'fs/promises';
import path from 'path';

// We chunk the massive Alpine bounding box into 4 smaller areas to prevent 
// Overpass API timeouts (HTTP 504) and Node.js memory crashes.
const BBOXES = [
  '(45.3, 8.8, 46.05, 10.3)',  // Southwest
  '(45.3, 10.3, 46.05, 11.8)', // Southeast
  '(46.05, 8.8, 46.8, 10.3)',  // Northwest
  '(46.05, 10.3, 46.8, 11.8)', // Northeast
];

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

async function fetchTrails() {
  console.log('��� Downloading trail data from OpenStreetMap in 4 chunks (Overpass API)...');      
  
  const allFeatures = [];

  for (let i = 0; i < BBOXES.length; i++) {
    const bbox = BBOXES[i];
    console.log(`\n⏳ Fetching Chunk ${i + 1}/4 for extent: ${bbox}...`);
    
    // We only fetch paths that are actively rated on the Alpine scale to filter out flat fields/cities
    const query = `
      [out:json][timeout:180];
      (
        way["highway"="path"]["sac_scale"]${bbox};
        way["highway"="footway"]["sac_scale"]${bbox};
      );
      out body;
      >;
      out skel qt;
    `;

    try {
      const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`
      });

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
            sac_scale: tags.sac_scale || 'unknown',
            trail_visibility: tags.trail_visibility || 'unknown'
          },
          geometry: {
            type: 'LineString',
            coordinates: coordinates
          }
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`   ❌ Failed fetching chunk ${i + 1}:`, errorMessage);
    }
  }

  const outputPath = path.join(process.cwd(), 'public/data/trails.geojson');    
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  
  // Convert incrementally to avoid V8 string limit errors on huge files
  await fs.writeFile(outputPath, '{"type":"FeatureCollection","features":[');
  for (let i = 0; i < allFeatures.length; i++) {
    await fs.appendFile(outputPath, JSON.stringify(allFeatures[i]) + (i === allFeatures.length - 1 ? '' : ','));
  }
  await fs.appendFile(outputPath, ']}');

  console.log(`\n��� Mastery completed! Saved ${allFeatures.length} Alpine Trails to ${outputPath}`);
}

fetchTrails();
