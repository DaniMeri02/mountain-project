import 'dotenv/config';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'path';
import { Pool } from 'pg';
import { AgentOrchestrator } from './agent/orchestrator';

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

type ParsedBBox = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

type ErrorWithCode = {
  code?: string;
};

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const maybeError = error as ErrorWithCode;
  if (typeof maybeError.code === 'string') {
    return maybeError.code;
  }

  return undefined;
}

function parseBBox(query: BBoxQuery): ParsedBBox | null {
  const minLng = Number(query.minLng);
  const minLat = Number(query.minLat);
  const maxLng = Number(query.maxLng);
  const maxLat = Number(query.maxLat);

  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) {
    return null;
  }

  if (minLng >= maxLng || minLat >= maxLat) {
    return null;
  }

  return { minLng, minLat, maxLng, maxLat };
}

// Setup PostgreSQL pool
for (const key of ['DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT', 'DB_NAME'] as const) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
});

// Spatial API Endpoint for Trails
fastify.get<{ Querystring: BBoxQuery }>('/api/trails', async (request, reply) => {
  const bbox = parseBBox(request.query);

  if (!bbox) {
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
    const result = await pool.query(query, [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
    return result.rows[0]?.geojson ?? { type: 'FeatureCollection', features: [] };
  } catch (error) {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Database query failed' });
  }
});

// Spatial API Endpoint for Via Ferrata lines
fastify.get<{ Querystring: BBoxQuery }>('/api/ferrata', async (request, reply) => {
  const bbox = parseBBox(request.query);

  if (!bbox) {
    return { type: 'FeatureCollection', features: [] };
  }

  const query = `
    WITH ferrata_rows AS (
      SELECT
        id,
        osm_id,
        name,
        via_ferrata_scale,
        sac_scale,
        source_type,
        geom
      FROM via_ferrata

      UNION ALL

      SELECT
        NULL::bigint AS id,
        t.osm_id,
        t.name,
        NULL::text AS via_ferrata_scale,
        t.sac_scale,
        'name:ferrata'::text AS source_type,
        t.geom
      FROM trails t
      WHERE
        (
          t.name ILIKE 'ferrata %'
          OR t.name ILIKE '% via ferrata %'
          OR t.name ILIKE '%ferrata%'
        )
        AND t.sac_scale IN (
          'demanding_mountain_hiking',
          'alpine_hiking',
          'demanding_alpine_hiking',
          'difficult_alpine_hiking'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM via_ferrata vf
          WHERE vf.osm_id = t.osm_id
        )
    )
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ST_AsGeoJSON(geom)::json,
          'properties', json_build_object(
            'id', id,
            'osm_id', osm_id,
            'name', name,
            'via_ferrata_scale', via_ferrata_scale,
            'sac_scale', sac_scale,
            'source_type', source_type
          )
        )
      ), '[]'::json)
    ) AS geojson
    FROM ferrata_rows
    WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
  `;

  try {
    const result = await pool.query(query, [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
    return result.rows[0]?.geojson ?? { type: 'FeatureCollection', features: [] };
  } catch (error) {
    if (getErrorCode(error) === '42P01') {
      fastify.log.warn('Table "via_ferrata" not found yet. Returning empty dataset.');
      return { type: 'FeatureCollection', features: [] };
    }

    fastify.log.error(error);
    reply.status(500).send({ error: 'Database query failed' });
  }
});

// Spatial API Endpoint for POIs
fastify.get<{ Querystring: BBoxQuery }>('/api/pois', async (request, reply) => {
  const bbox = parseBBox(request.query);

  if (!bbox) {
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
    const result = await pool.query(query, [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
    return result.rows[0]?.geojson ?? { type: 'FeatureCollection', features: [] };
  } catch (error) {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Database query failed' });
  }
});

// Search API Endpoint for the Autocomplete box
fastify.get<{ Querystring: SearchQuery }>('/api/search', async (request, reply) => {
  const { q } = request.query;

  if (!q || q.length < 2) {
    return [];
  }

  const searchTerm = q.trim();
  const searchPattern = `%${searchTerm}%`;

  const query = `
    WITH poi_matches AS (
      SELECT
        id,
        osm_id,
        type,
        name,
        elevation,
        ST_X(geom) AS lng,
        ST_Y(geom) AS lat,
        NULL::text AS via_ferrata_scale,
        NULL::text AS source_type
      FROM pois
      WHERE name ILIKE $1
    ),
    ferrata_rows AS (
      SELECT
        osm_id,
        name,
        via_ferrata_scale,
        source_type,
        geom
      FROM via_ferrata

      UNION ALL

      SELECT
        t.osm_id,
        t.name,
        NULL::text AS via_ferrata_scale,
        'name:ferrata'::text AS source_type,
        t.geom
      FROM trails t
      WHERE
        (
          t.name ILIKE 'ferrata %'
          OR t.name ILIKE '% via ferrata %'
          OR t.name ILIKE '%ferrata%'
        )
        AND t.sac_scale IN (
          'demanding_mountain_hiking',
          'alpine_hiking',
          'demanding_alpine_hiking',
          'difficult_alpine_hiking'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM via_ferrata vf
          WHERE vf.osm_id = t.osm_id
        )
    ),
    ferrata_matches AS (
      SELECT
        NULL::bigint AS id,
        MIN(osm_id) AS osm_id,
        'ferrata'::text AS type,
        name,
        NULL::integer AS elevation,
        ST_X(ST_Centroid(ST_Collect(geom))) AS lng,
        ST_Y(ST_Centroid(ST_Collect(geom))) AS lat,
        MIN(via_ferrata_scale) FILTER (WHERE via_ferrata_scale IS NOT NULL) AS via_ferrata_scale,
        CASE
          WHEN BOOL_OR(source_type <> 'name:ferrata') THEN 'via_ferrata'
          ELSE 'name:ferrata'
        END AS source_type
      FROM ferrata_rows
      WHERE name IS NOT NULL
        AND name ILIKE $1
      GROUP BY name
    ),
    combined AS (
      SELECT * FROM poi_matches
      UNION ALL
      SELECT * FROM ferrata_matches
    )
    SELECT
      id,
      osm_id,
      type,
      name,
      elevation,
      lng,
      lat,
      via_ferrata_scale,
      source_type
    FROM combined
    ORDER BY
      CASE
        WHEN LOWER(name) = LOWER($2) THEN 0
        WHEN LOWER(name) LIKE LOWER($2) || '%' THEN 1
        ELSE 2
      END,
      name
    LIMIT 20;
  `;

  try {
    const result = await pool.query(query, [searchPattern, searchTerm]);
    return result.rows;
  } catch (error) {
    if (getErrorCode(error) === '42P01') {
      // If ferrata tables are missing, gracefully keep POI search working.
      const fallbackQuery = `
        SELECT
          id,
          osm_id,
          type,
          name,
          elevation,
          ST_X(geom) AS lng,
          ST_Y(geom) AS lat,
          NULL::text AS via_ferrata_scale,
          NULL::text AS source_type
        FROM pois
        WHERE name ILIKE $1
        LIMIT 20;
      `;

      const fallback = await pool.query(fallbackQuery, [searchPattern]);
      return fallback.rows;
    }

    fastify.log.error(error);
    reply.status(500).send({ error: 'Search query failed' });
  }
});

// ─── AI Agent ─────────────────────────────────────────────────────────────────

type ResearchBody = {
  name: string;
  type: string;
  elevation?: number | string | null;
  osm_id?: string | number | null;
  lat?: number | null;
  lng?: number | null;
};

const researchBodySchema = {
  body: {
    type: 'object',
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string', minLength: 1 },
      elevation: {},
      osm_id: {},
      lat: { type: ['number', 'null'] },
      lng: { type: ['number', 'null'] },
    },
  },
} as const;

// Lazy singleton — created on the first AI request so startup never fails
// if GEMINI_API_KEY is missing (it will fail gracefully at request time).
let orchestrator: AgentOrchestrator | null = null;

function getOrchestrator(): AgentOrchestrator {
  if (!orchestrator) {
    orchestrator = new AgentOrchestrator(pool);
  }
  return orchestrator;
}

fastify.post<{ Body: ResearchBody }>(
  '/api/ai/research',
  { schema: researchBodySchema },
  async (request, reply) => {
    const { name, type, elevation, osm_id, lat, lng } = request.body;
    try {
      return await getOrchestrator().generate({ name, type, elevation, osm_id, lat, lng });
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'AI generation failed. Check server logs.' });
    }
  }
);

fastify.post<{ Body: ResearchBody }>(
  '/api/ai/research/regenerate',
  { schema: researchBodySchema },
  async (request, reply) => {
    const { name, type, elevation, osm_id, lat, lng } = request.body;
    try {
      return await getOrchestrator().generate(
        { name, type, elevation, osm_id, lat, lng },
        true   // forceRegenerate = true — bypasses cache
      );
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'AI regeneration failed. Check server logs.' });
    }
  }
);

// Register the plugin to serve static files from the 'public' folder
fastify.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/', 
});

fastify.addHook('onClose', async () => {
  await pool.end();
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
