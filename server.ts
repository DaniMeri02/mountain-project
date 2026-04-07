import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'path';
import { Pool } from 'pg';

const fastify = Fastify({ logger: true });

type BBoxQuery = {
  minLng?: string;
  minLat?: string;
  maxLng?: string;
  maxLat?: string;
};

type SearchQuery = {
  q?: string;
};

// Setup PostgreSQL pool
const pool = new Pool({
  user: 'mountain_worker',
  password: 'mountain_secret_123',
  host: 'localhost',
  port: 5433,
  database: 'mountain_db'
});

// Spatial API Endpoint for Trails
fastify.get('/api/trails', async (request, reply) => {
  const { minLng, minLat, maxLng, maxLat } = request.query as BBoxQuery;

  if (!minLng || !minLat || !maxLng || !maxLat) {
    return { type: 'FeatureCollection', features: [] };
  }

  // Pull unmodified entire LineString lines (Let Mapbox handle the rendering and clipping)
  const query = `
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ST_AsGeoJSON(geom)::json,
          'properties', json_build_object('id', id, 'osm_id', osm_id, 'name', name, 'sac_scale', sac_scale)
        )
      ), '[]'::json)
    ) AS geojson
    FROM trails
    WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
  `;

  try {
    const result = await pool.query(query, [minLng, minLat, maxLng, maxLat]);
    return result.rows[0].geojson;
  } catch (error) {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Database query failed' });
  }
});
// Spatial API Endpoint for POIs
fastify.get('/api/pois', async (request, reply) => {
  const { minLng, minLat, maxLng, maxLat } = request.query as BBoxQuery;

  if (!minLng || !minLat || !maxLng || !maxLat) {
    return { type: 'FeatureCollection', features: [] };
  }

  const query = `
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ST_AsGeoJSON(geom)::json,
          'properties', json_build_object('id', id, 'osm_id', osm_id, 'type', type, 'name', name, 'elevation', elevation)
        )
      ), '[]'::json)
    ) AS geojson
    FROM pois
    WHERE ST_Intersects(
      geom,
      ST_MakeEnvelope($1, $2, $3, $4, 4326)
    )
  `;

  try {
    const result = await pool.query(query, [minLng, minLat, maxLng, maxLat]);
    return result.rows[0].geojson;
  } catch (error) {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Database query failed' });
  }
});

// Search API Endpoint for the Autocomplete box
fastify.get('/api/search', async (request, reply) => {
  const { q } = request.query as SearchQuery;

  if (!q || q.length < 2) {
    return [];
  }

  // Find POIs matching the search name, pulling their coordinates using ST_X and ST_Y
  const query = `
    SELECT id, osm_id, type, name, elevation, ST_X(geom) as lng, ST_Y(geom) as lat
    FROM pois
    WHERE name ILIKE $1
    LIMIT 20;
  `;

  try {
    const result = await pool.query(query, [`%${q}%`]);
    return result.rows;
  } catch (error) {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Search query failed' });
  }
});

// Register the plugin to serve static files from the 'public' folder
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/', 
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000 });
    console.log('🏔️ Portal is live! Visit http://localhost:3000 in your browser');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
