import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  database: process.env.DB_NAME,
});

async function importPois() {
  console.log("📥 Loading pois.geojson file...");
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
    
    console.log(`✅ Upserted ${inserted} POIs into the database.`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("❌ Error reading or parsing pois.geojson:", errorMessage);
  } finally {
    await pool.end();
  }
}

importPois();
