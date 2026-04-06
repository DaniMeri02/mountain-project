const { Pool } = require('pg');
const pool = new Pool({ user: 'mountain_worker', password: 'mountain_secret_123', host: 'localhost', port: 5433, database: 'mountain_db' });

pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pois';")
  .then(res => { console.table(res.rows); pool.end(); })
  .catch(e => { console.error(e); pool.end(); });
