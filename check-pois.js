const { Pool } = require('pg');
const pool = new Pool({ user: process.env.DB_USER || 'mountain_worker', password: process.env.DB_PASSWORD || 'mountain_secret_123', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5433), database: process.env.DB_NAME || 'mountain_db' });

pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pois';")
  .then(res => { console.table(res.rows); pool.end(); })
  .catch(e => { console.error(e); pool.end(); });
