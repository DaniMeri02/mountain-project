import fs from 'fs/promises';
import path from 'path';

// Coordinate Bounding Box for roughly all of Lombardy Alps and Trentino
const BBOX = '(45.3, 8.8, 46.8, 11.8)';

const OVERPASS_QUERY = `
[out:json][timeout:60];
// Dobbiamo cercare anche nelle vie/poligoni (nwr = node, way, relation), non solo nei nodi,
// perché rifugi grandi come il Curò sono spesso mappati come poligoni degli edifici!
(
  nwr["tourism"="alpine_hut"]${BBOX};
  nwr["tourism"="wilderness_hut"]${BBOX};
  node["natural"="peak"]["ele"~"^[2-4][0-9]{3}$"]${BBOX};
);
out center; // Così Overpass calcola il centroide (coordinate) anche per le vie/edifici
`;

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

async function fetchPOIs() {
  console.log('🏔️ ScScaricando i dati da OpenStreetMap (Overpass API)...');
  
  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(OVERPASS_QUERY)}`
    });

    if (!response.ok) {
      throw new Error(`Errore HTTP: ${response.status}`);
    }

    const data = await response.json();
    console.log(`✅ Trovati ${data.elements.length} elementi grezzi.`);

    // Transform OSM nodes to GeoJSON
    const features = [];

    for (const element of data.elements) {
      const tags = element.tags || {};
      
      // Determine the type of POI
      let type = 'unknown';
      if (tags.tourism === 'alpine_hut') type = 'hut';
      else if (tags.tourism === 'wilderness_hut') type = 'bivouac';
      else if (tags.natural === 'peak') type = 'peak';

      // Skip unnamed peaks or low peaks to avoid cluttering the map too much
      if (type === 'peak') {
        const ele = parseInt(tags.ele) || 0;
        if (!tags.name || ele < 2200) {
          continue; 
        }
      }

      // We extract coordinates. Ways/relations use "center", nodes use "lat"/"lon" directly.
      const lat = element.lat || element.center?.lat;
      const lon = element.lon || element.center?.lon;

      if (!lat || !lon) continue; // safety check

      // Default name if missing
      const name = tags.name || `Sconosciuto (${type})`;

      const elevation = tags.ele ? parseInt(tags.ele) : 'N/D';
      const website = tags.website || tags['contact:website'] || '';

      features.push({
        type: 'Feature',
        properties: {
          id: element.id,
          name: name,
          type: type,
          elevation: elevation,
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

    // Save to the public/data folder so Fastify can serve it to the frontend map!
    // Using current cwd path to avoid resolution errors
    const outputPath = path.join(process.cwd(), 'public/data/pois.geojson');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(geojson, null, 2));

    console.log(`🗺️ Salvato ${features.length} Punti di Interesse in ${outputPath}`);

  } catch (error) {
    console.error('❌ Errore durante il fetch:', error);
  }
}

fetchPOIs();
