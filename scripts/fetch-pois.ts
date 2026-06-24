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

type PoiFeature = {
  type: 'Feature';
  properties: {
    id: number;
    name: string;
    type: string;
    elevation: number | string;
    sort_elevation: number;
    website: string;
    description: string;
    osm_id: number;
  };
  geometry: { type: 'Point'; coordinates: number[] };
};

// Stable identity for dedup: prefer osm_id, fall back to id.
const poiKey = (f: { properties: { osm_id?: number | string; id?: number | string } }): string =>
  String(f.properties.osm_id ?? f.properties.id);

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
    const features: PoiFeature[] = [];

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

    // Merge into any existing pois.geojson instead of overwriting it, so fetching
    // one region (this script's BBOX) never wipes POIs from other regions. Dedup by
    // osm_id — freshly-fetched features replace stale ones with the same id.
    const outputPath = path.join(process.cwd(), 'public/data/pois.geojson');
    const byId = new Map<string, PoiFeature>();

    try {
      const existingRaw = await fs.readFile(outputPath, 'utf8');
      const existing = JSON.parse(existingRaw) as { features?: PoiFeature[] };
      for (const f of existing.features ?? []) byId.set(poiKey(f), f);
      console.log(`📂 Merging into ${byId.size} existing POIs...`);
    } catch {
      console.log('📂 No existing pois.geojson — writing a fresh file.');
    }

    let added = 0;
    let refreshed = 0;
    for (const f of features) {
      if (byId.has(poiKey(f))) refreshed++;
      else added++;
      byId.set(poiKey(f), f);
    }

    const geojson = {
      type: 'FeatureCollection',
      features: [...byId.values()]
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(geojson, null, 2));

    console.log(`🗺️ Saved ${geojson.features.length} POIs to ${outputPath} (${added} new, ${refreshed} refreshed, deduped by osm_id).`);

  } catch (error) {
    console.error('❌ Error during fetch:', error);
  }
}

fetchPOIs();
