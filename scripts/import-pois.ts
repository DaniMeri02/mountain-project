import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';

const pool = new Pool({
  user: 'mountain_worker',
  password: 'mountain_secret_123',
  host: 'localhost',
  port: 5433,
  database: 'mountain_db'
});

async function importPois() {
  console.log("[INFO] Loading pois.geojson file...");
  try {
    const rawData = await fs.readFile(path.join(__dirname, '../public/data/pois.geojson'), 'utf8');
    const featureCollection = JSON.parse(rawData);
    const features = featureCollection.features;
    
    console.log(`Found ${features.length} POIs to insert into database...`);

    let inserted = 0;
    
    for (const feat of features) {
      const props = feat.properties;
      const coords = feat.geometry.coordinates; // [lon, lat]
      
      const geom = `{"type": "Point", "coordinates": [${coords[0]}, ${coords[1]}]}`;
      
      let elevation = 0;
      if (typeof props.elevation === 'number') elevation = props.elevation;
      else if (typeof props.elevation === 'string' && props.elevation !== 'N/D') {
        const parsed = parseInt(props.elevation, 10);
        if (!isNaN(parsed)) elevation = parsed;
      }
      
      try {
        await pool.query(
          `INSERT INTO pois (osm_id, type, name, elevation, geom) 
           VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))
           ON CONFLICT (osm_id) DO UPDATE SET type = EXCLUDED.type, name = EXCLUDED.name, elevation = EXCLUDED.elevation, geom = EXCLUDED.geom`,
          [props.osm_id || props.id, props.type, props.name || null, elevation, geom]
        );
        inserted++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Failed to insert POI: ${props.name}`, errorMessage);
      }
    }
    
    console.log(`[OK] Upserted ${inserted} POIs into the database.`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[ERROR] Error reading or parsing pois.geojson:", errorMessage);
  } finally {
    await pool.end();
  }
}

importPois();
