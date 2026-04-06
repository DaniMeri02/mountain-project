const { Pool } = require('pg');

const pool = new Pool({
  user: 'mountain_worker',
  password: 'mountain_secret_123',
  host: 'localhost',
  port: 5433,
  database: 'mountain_db'
});

async function checkCoverage() {
  console.log("[INFO] Scanning the entire map area for missing chunks...");
  
  const startLat = 45.3;
  const endLat = 46.8;
  const latStep = 0.15;
  const startLon = 8.8;
  const endLon = 11.8;
  const lonStep = 0.3;

  const BBOXES = [];
  for (let lat = startLat; lat < endLat; lat += latStep) {
    for (let lon = startLon; lon < endLon; lon += lonStep) {
      const nextLat = Math.min(lat + latStep, endLat);
      const nextLon = Math.min(lon + lonStep, endLon);
      BBOXES.push({
        minLat: parseFloat(lat.toFixed(3)),
        minLon: parseFloat(lon.toFixed(3)),
        maxLat: parseFloat(nextLat.toFixed(3)),
        maxLon: parseFloat(nextLon.toFixed(3))
      });
    }
  }

  console.log(`Checking ${BBOXES.length} total bounding boxes...`);

  let emptyChunks = 0;
  let totalTrails = 0;

  for (let i = 0; i < BBOXES.length; i++) {
    const b = BBOXES[i];
    const q = `
      SELECT COUNT(*) 
      FROM trails 
      WHERE ST_Intersects(
        geom, 
        ST_MakeEnvelope($1, $2, $3, $4, 4326)
      )
    `;
    
    try {
      const res = await pool.query(q, [b.minLon, b.minLat, b.maxLon, b.maxLat]);
      const count = parseInt(res.rows[0].count, 10);
      totalTrails += count;
      
      if (count === 0) {
        console.log(`[WARN] EMPTY CHUNK FOUND: Lat [${b.minLat} to ${b.maxLat}], Lon [${b.minLon} to ${b.maxLon}]`);
        emptyChunks++;
      }
    } catch (err) {
      console.error("Error querying", b, err.message);
    }
  }

  console.log('----------------------------------------------------');
  if (emptyChunks === 0) {
    console.log(`[OK] 100% COVERAGE CONFIRMED! All ${BBOXES.length} sections have trails.`);
  } else {
    console.log(`[WARN] ${emptyChunks} out of ${BBOXES.length} sections are completely empty!`);
  }
  console.log('----------------------------------------------------');
  
  await pool.end();
}

checkCoverage();
