import fs from 'fs/promises';
import path from 'path';

// Monte Rosa massif + surrounding Italian/Swiss valleys (Valsesia, Gressoney, Ayas, Zermatt, Saas-Fee)
// Connects at lng 8.8 with the existing Lombardy dataset (lng 8.8–11.8)
const BBOX = '(45.5, 7.4, 46.2, 8.8)';

const OVERPASS_QUERY = `
[out:json][timeout:60];
// We must search in ways/polygons (nwr = node, way, relation), not just nodes,
// because large huts are often mapped as building polygons!
(
  nwr["tourism"="alpine_hut"]${BBOX};
  nwr["tourism"="wilderness_hut"]${BBOX};
  node["natural"="peak"]${BBOX};
);
out center; // Overpass calculates the centroid (coordinates) even for ways/buildings
`;

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

async function fetchPOIs() {
  console.log('🏔️ Downloading data from OpenStreetMap (Overpass API)...');

  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'mountain-portal/1.0 (personal project)',
      },
      body: `data=${encodeURIComponent(OVERPASS_QUERY)}`
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const data = await response.json();
    console.log(`✅ Found ${data.elements.length} raw elements.`);

    // Transform OSM elements to GeoJSON
    const features = [];

    for (const element of data.elements) {
      const tags = element.tags || {};

      // Determine the type of POI
      let type = 'unknown';
      if (tags.tourism === 'alpine_hut') type = 'hut';
      else if (tags.tourism === 'wilderness_hut') type = 'bivouac';
      else if (tags.natural === 'peak') type = 'peak';

      // Skip unnamed peaks to avoid cluttering the map with useless data
      if (type === 'peak' && !tags.name) {
        continue;
      }

      // Extract coordinates. Ways/relations use "center", nodes use "lat"/"lon" directly.
      const lat = element.lat || element.center?.lat;
      const lon = element.lon || element.center?.lon;

      if (!lat || !lon) continue; // Safety check

      // Default name if missing
      const name = tags.name || `Unknown (${type})`;

      // Store a valid number for elevation whenever possible, to allow sorting
      const parsedEle = parseInt(tags.ele);
      const elevation = isNaN(parsedEle) ? 0 : parsedEle;
      const elevationLabel = isNaN(parsedEle) ? 'N/D' : parsedEle;

      const website = tags.website || tags['contact:website'] || '';

      features.push({
        type: 'Feature',
        properties: {
          id: element.id,
          name: name,
          type: type,
          elevation: elevationLabel, // Used for display
          sort_elevation: elevation, // Used for sorting priorities
          website: website,
          description: tags.description || '',
          osm_id: element.id
        },
        geometry: {
          type: 'Point',
          coordinates: [lon, lat]
        }
      });
    }

    const geojson = {
      type: 'FeatureCollection',
      features: features
    };

    // Save to the public/data folder so Fastify can serve it to the frontend map
    const outputPath = path.join(process.cwd(), 'public/data/pois.geojson');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(geojson, null, 2));

    console.log(`🗺️ Saved ${features.length} Points of Interest to ${outputPath}`);

  } catch (error) {
    console.error('❌ Error during fetch:', error);
  }
}

fetchPOIs();
