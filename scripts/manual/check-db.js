const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  database: process.env.DB_NAME,
});

const FAILED_BBOXES = [
  { bbox: "(45.750, 9.400, 45.900, 9.700)", minLat: 45.750, minLon: 9.400, maxLat: 45.900, maxLon: 9.700 },
  { bbox: "(45.750, 10.300, 45.900, 10.600)", minLat: 45.750, minLon: 10.300, maxLat: 45.900, maxLon: 10.600 },
  { bbox: "(46.050, 10.600, 46.200, 10.900)", minLat: 46.050, minLon: 10.600, maxLat: 46.200, maxLon: 10.900 },
  { bbox: "(46.050, 10.900, 46.200, 11.200)", minLat: 46.050, minLon: 10.900, maxLat: 46.200, maxLon: 11.200 },
  { bbox: "(46.050, 11.200, 46.200, 11.500)", minLat: 46.050, minLon: 11.200, maxLat: 46.200, maxLon: 11.500 },
  { bbox: "(46.050, 11.500, 46.200, 11.800)", minLat: 46.050, minLon: 11.500, maxLat: 46.200, maxLon: 11.800 },
  { bbox: "(46.200, 8.800, 46.350, 9.100)", minLat: 46.200, minLon: 8.800, maxLat: 46.350, maxLon: 9.100 },
  { bbox: "(46.200, 9.400, 46.350, 9.700)", minLat: 46.200, minLon: 9.400, maxLat: 46.350, maxLon: 9.700 }
];

async function checkDB() {
  try {
    const totalRes = await pool.query('SELECT COUNT(*) FROM trails');
    console.log(`\n📊 TOTAL TRAILS IN DATABASE: ${totalRes.rows[0].count}`);

    console.log('\n🔍 CHECKING PREVIOUSLY FAILED CHUNKS...');
    for (const b of FAILED_BBOXES) {
      const q = `
        SELECT COUNT(*) 
        FROM trails 
        WHERE ST_Intersects(
          geom, 
          ST_MakeEnvelope($1, $2, $3, $4, 4326)
        )
      `;
      // Coordinates: minLon, minLat, maxLon, maxLat
      const res = await pool.query(q, [b.minLon, b.minLat, b.maxLon, b.maxLat]);
      console.log(`Chunk ${b.bbox} -> ${res.rows[0].count} trails found.`);
    }

    console.log('\n✅ CHECK COMPLETE!');
  } catch (e) {
    console.error('Error:', e);
  } finally {
    pool.end();
  }
}

checkDB();
