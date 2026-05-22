import 'dotenv/config';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'path';
import { Pool } from 'pg';
import { AgentOrchestrator, AI_MODELS } from './agent/orchestrator';
import { reloadPrompt } from './agent/prompt-loader';
import type { PoiType } from './agent/types';

const fastify = Fastify({ logger: process.env.NODE_ENV !== 'production' });

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

export function parseBBox(query: BBoxQuery): ParsedBBox | null {
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

  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
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

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const TRAILS_QUERY = `
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

const FERRATA_QUERY = `
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

const POIS_QUERY = `
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

// Spatial API Endpoint for Trails
fastify.get<{ Querystring: BBoxQuery }>('/api/trails', async (request, reply) => {
  const bbox = parseBBox(request.query);

  if (!bbox) {
    return EMPTY_FC;
  }

  try {
    const result = await pool.query(TRAILS_QUERY, [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
    return result.rows[0]?.geojson ?? EMPTY_FC;
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({ error: 'Database query failed' });
  }
});

// Spatial API Endpoint for Via Ferrata lines
fastify.get<{ Querystring: BBoxQuery }>('/api/ferrata', async (request, reply) => {
  const bbox = parseBBox(request.query);

  if (!bbox) {
    return EMPTY_FC;
  }

  try {
    const result = await pool.query(FERRATA_QUERY, [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
    return result.rows[0]?.geojson ?? EMPTY_FC;
  } catch (error) {
    if (getErrorCode(error) === '42P01') {
      fastify.log.warn('Table "via_ferrata" not found yet. Returning empty dataset.');
      return EMPTY_FC;
    }

    fastify.log.error(error);
    return reply.status(500).send({ error: 'Database query failed' });
  }
});

// Spatial API Endpoint for POIs
fastify.get<{ Querystring: BBoxQuery }>('/api/pois', async (request, reply) => {
  const bbox = parseBBox(request.query);

  if (!bbox) {
    return EMPTY_FC;
  }

  try {
    const result = await pool.query(POIS_QUERY, [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
    return result.rows[0]?.geojson ?? EMPTY_FC;
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({ error: 'Database query failed' });
  }
});

// Bundle endpoint for offline downloads — single round-trip
const MAX_OFFLINE_AREA_DEG = 0.5; // ~55 km @ 45°N

fastify.get<{ Querystring: BBoxQuery }>('/api/offline/bundle', async (request, reply) => {
  const bbox = parseBBox(request.query);

  if (!bbox) {
    return reply.status(400).send({ error: 'Invalid bbox' });
  }

  if (
    bbox.maxLng - bbox.minLng > MAX_OFFLINE_AREA_DEG ||
    bbox.maxLat - bbox.minLat > MAX_OFFLINE_AREA_DEG
  ) {
    return reply.status(413).send({ error: 'Area too large for offline download' });
  }

  const params = [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat];

  try {
    const [trails, pois, ferrata] = await Promise.all([
      pool.query(TRAILS_QUERY, params),
      pool.query(POIS_QUERY, params),
      pool.query(FERRATA_QUERY, params).catch((err: unknown) => {
        if (getErrorCode(err) === '42P01') {
          return { rows: [{ geojson: EMPTY_FC }] };
        }
        throw err;
      }),
    ]);

    return {
      bbox: [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat],
      generated_at: new Date().toISOString(),
      trails: trails.rows[0]?.geojson ?? EMPTY_FC,
      pois: pois.rows[0]?.geojson ?? EMPTY_FC,
      ferrata: ferrata.rows[0]?.geojson ?? EMPTY_FC,
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({ error: 'Bundle query failed' });
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
    return reply.status(500).send({ error: 'Search query failed' });
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
  modelSlug?: string | null;
};

const researchBodySchema = {
  body: {
    type: 'object',
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', minLength: 1 },
      type: { type: 'string', minLength: 1 },
      elevation: { type: ['number', 'null'] },
      osm_id: { type: ['string', 'integer', 'null'] },
      lat: { type: ['number', 'null'] },
      lng: { type: ['number', 'null'] },
      modelSlug: { type: ['string', 'null'] },
    },
  },
} as const;

// Lazy singleton — created on the first AI request so startup never fails
// if AI provider keys are missing (they will fail gracefully at request time).
let orchestrator: AgentOrchestrator | null = null;

function getOrchestrator(): AgentOrchestrator {
  if (!orchestrator) {
    orchestrator = new AgentOrchestrator(pool);
  }
  return orchestrator;
}

const VALID_MODEL_SLUGS = new Set(AI_MODELS.map((m) => m.slug));

function resolveModelSlug(modelSlug: string | null | undefined, reply: { status: (n: number) => { send: (b: unknown) => unknown } }): string | undefined | null {
  if (modelSlug == null) return undefined;
  if (!VALID_MODEL_SLUGS.has(modelSlug)) {
    reply.status(400).send({
      error: 'Unknown modelSlug',
      validSlugs: Array.from(VALID_MODEL_SLUGS),
    });
    return null;
  }
  return modelSlug;
}

fastify.post<{ Body: ResearchBody }>(
  '/api/ai/research',
  { schema: researchBodySchema },
  async (request, reply) => {
    const { name, type, elevation, osm_id, lat, lng, modelSlug } = request.body;
    const resolvedSlug = resolveModelSlug(modelSlug, reply);
    if (resolvedSlug === null) return;
    try {
      return await getOrchestrator().generate(
        { name, type: type as PoiType, elevation, osm_id, lat, lng },
        false,
        resolvedSlug,
      );
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'AI generation failed. Check server logs.' });
    }
  }
);

fastify.post<{ Body: ResearchBody }>(
  '/api/ai/research/regenerate',
  { schema: researchBodySchema },
  async (request, reply) => {
    const { name, type, elevation, osm_id, lat, lng, modelSlug } = request.body;
    const resolvedSlug = resolveModelSlug(modelSlug, reply);
    if (resolvedSlug === null) return;
    try {
      return await getOrchestrator().generate(
        { name, type: type as PoiType, elevation, osm_id, lat, lng },
        true,
        resolvedSlug,
      );
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'AI regeneration failed. Check server logs.' });
    }
  }
);

fastify.get('/api/ai/models', async () => {
  return AI_MODELS.map(m => ({ slug: m.slug, label: m.label }));
});

fastify.post('/api/ai/reload-prompt', async () => {
  reloadPrompt();
  return { ok: true };
});

fastify.get('/api/config', async () => {
  return { mapboxToken: process.env.MAPBOX_TOKEN ?? '' };
});

// Register the plugin to serve static files
// In production, __dirname is dist/ so path.join(__dirname, 'public') → dist/public/ (Vite output)
// In dev, Vite dev server handles the frontend on :5173; serve project-root/public as fallback
const staticRoot =
  process.env.NODE_ENV === 'production'
    ? path.join(__dirname, 'public')
    : path.join(__dirname, 'public');

fastify.register(fastifyStatic, {
  root: staticRoot,
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

export { fastify };

if (require.main === module) {
  start();
}
