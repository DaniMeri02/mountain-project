const { Pool } = require('pg');
const pool = new Pool({ user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST, port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined, database: process.env.DB_NAME });

pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pois';")
  .then(res => { console.table(res.rows); pool.end(); })
  .catch(e => { console.error(e); pool.end(); });
