import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { AgentOrchestrator } from '../agent/orchestrator';

// Mock pg so server.ts can load without a real database
vi.mock('pg', () => ({
  Pool: vi.fn(function () { return { query: vi.fn(), end: vi.fn() }; }),
}));

// Mock orchestrator to avoid needing a real Gemini key at import time
vi.mock('../agent/orchestrator', () => ({
  AgentOrchestrator: vi.fn(function () {
    return {
      generate: vi.fn().mockResolvedValue({
        description: 'AI description',
        fromCache: false,
        sources: ['Wikidata'],
        generatedAt: '2026-04-20T10:00:00Z',
        expiresAt: '2026-04-22T10:00:00Z',
      }),
    };
  }),
  AI_MODELS: [
    { slug: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY' },
    { slug: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)', base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY' },
  ],
}));

// Import server AFTER mocks are registered
import { fastify, parseBBox, parseElevationQuery } from '../server';

// ── Helpers ────────────────────────────────────────────────────────────────────

function poolQuery(): ReturnType<typeof vi.fn> {
  const instance = vi.mocked(Pool).mock.results[0]?.value as { query: ReturnType<typeof vi.fn> };
  return instance.query;
}

function setQueryResult(rows: unknown[]) {
  poolQuery().mockResolvedValueOnce({ rows });
}

function setQueryError(code: string) {
  poolQuery().mockRejectedValueOnce(Object.assign(new Error('DB error'), { code }));
}

const VALID_BBOX = { minLng: '9.5', minLat: '45.5', maxLng: '10.0', maxLat: '46.0' };
const GEOJSON_ROW = { geojson: { type: 'FeatureCollection', features: [] } };

// ── parseBBox ─────────────────────────────────────────────────────────────────

describe('parseBBox', () => {
  it('returns a parsed object for valid coordinates', () => {
    const result = parseBBox({ minLng: '9.5', minLat: '45.5', maxLng: '10.0', maxLat: '46.0' });
    expect(result).toEqual({ minLng: 9.5, minLat: 45.5, maxLng: 10.0, maxLat: 46.0 });
  });

  it('returns null when minLng >= maxLng', () => {
    expect(parseBBox({ minLng: '10.0', minLat: '45.5', maxLng: '9.0', maxLat: '46.0' })).toBeNull();
  });

  it('returns null for NaN input', () => {
    expect(parseBBox({ minLng: 'abc', minLat: '45.5', maxLng: '10.0', maxLat: '46.0' })).toBeNull();
  });

  it('returns null when all params are undefined', () => {
    expect(parseBBox({})).toBeNull();
  });
});

// ── GET routes ────────────────────────────────────────────────────────────────

describe('GET /api/pois', () => {
  it('returns FeatureCollection when bbox is valid', async () => {
    setQueryResult([GEOJSON_ROW]);
    const res = await fastify.inject({ method: 'GET', url: '/api/pois', query: VALID_BBOX });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: 'FeatureCollection' });
  });

  it('returns empty FeatureCollection when no bbox params', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/pois' });
    expect(res.statusCode).toBe(200);
    expect(res.json().features).toEqual([]);
  });
});

describe('GET /api/trails', () => {
  it('returns empty FeatureCollection for invalid bbox', async () => {
    const res = await fastify.inject({
      method: 'GET', url: '/api/trails',
      query: { minLng: '10', minLat: '45', maxLng: '9', maxLat: '46' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().features).toEqual([]);
  });
});

describe('GET /api/ferrata', () => {
  it('returns empty FeatureCollection gracefully when via_ferrata table is missing', async () => {
    setQueryError('42P01');
    const res = await fastify.inject({ method: 'GET', url: '/api/ferrata', query: VALID_BBOX });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: 'FeatureCollection', features: [] });
  });
});

describe('GET /api/search', () => {
  it('returns rows for a valid query', async () => {
    const mockRow = { id: 1, name: 'Rifugio Albani', type: 'hut', osm_id: 42 };
    setQueryResult([mockRow]);
    const res = await fastify.inject({ method: 'GET', url: '/api/search', query: { q: 'rifugio' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual(expect.objectContaining({ name: 'Rifugio Albani' }));
  });

  it('returns empty array when q is missing', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/search' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('POST /api/search/smart', () => {
  // A non-finite viewport bound (1e400 parses to Infinity) must never reach PostGIS. The body
  // schema already rejects it: ajv's number type excludes Infinity. Raw string payload so the
  // JSON parser yields Infinity — an object payload would stringify it to null.
  it('rejects a non-finite viewport bound at schema validation', async () => {
    const res = await fastify.inject({
      method: 'POST', url: '/api/search/smart',
      headers: { 'content-type': 'application/json' },
      payload: '{"viewport":[1e400,45,10,46]}',
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST routes ───────────────────────────────────────────────────────────────

describe('POST /api/ai/research', () => {
  it('returns AgentResponse shape for valid body', async () => {
    const res = await fastify.inject({
      method: 'POST', url: '/api/ai/research',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Rifugio Albani', type: 'hut', lat: 45.9, lng: 9.8 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('description');
    expect(body).toHaveProperty('fromCache');
    expect(body).toHaveProperty('sources');
  });

  it('returns 400 when required field name is missing', async () => {
    const res = await fastify.inject({
      method: 'POST', url: '/api/ai/research',
      headers: { 'content-type': 'application/json' },
      payload: { type: 'hut' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a POI type outside the allowed set', async () => {
    const res = await fastify.inject({
      method: 'POST', url: '/api/ai/research',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Castello', type: 'castle', lat: 45.9, lng: 9.8 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts each allowed POI type', async () => {
    for (const type of ['peak', 'hut', 'bivouac', 'ferrata']) {
      const res = await fastify.inject({
        method: 'POST', url: '/api/ai/research',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'X', type, lat: 45.9, lng: 9.8 },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

// ── parseElevationQuery ─────────────────────────────────────────────────────────

describe('parseElevationQuery', () => {
  it('parses valid coordinates and rounds the cache key to 4 dp', () => {
    expect(parseElevationQuery({ lat: '46.077323', lng: '9.989028' }))
      .toEqual({ lat: 46.077323, lng: 9.989028, key: '46.0773,9.9890' });
  });

  it('returns null for non-finite input', () => {
    expect(parseElevationQuery({ lat: 'abc', lng: '9.6' })).toBeNull();
    expect(parseElevationQuery({})).toBeNull();
  });

  it('returns null for out-of-range coordinates', () => {
    expect(parseElevationQuery({ lat: '91', lng: '9.6' })).toBeNull();
    expect(parseElevationQuery({ lat: '46', lng: '181' })).toBeNull();
  });
});

// ── GET /api/elevation ──────────────────────────────────────────────────────────

describe('GET /api/elevation', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('returns 400 for invalid coordinates', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/elevation', query: { lat: 'abc', lng: '9.6' } });
    expect(res.statusCode).toBe(400);
  });

  it('proxies the DEM API and returns a rounded elevation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ elevation: 1933.8 }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const res = await fastify.inject({ method: 'GET', url: '/api/elevation', query: { lat: '46.10', lng: '9.61' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ elevation: 1934 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches by rounded coordinates — no second upstream call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ elevation: 2500 }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const query = { lat: '46.20', lng: '9.70' };
    const first = await fastify.inject({ method: 'GET', url: '/api/elevation', query });
    const second = await fastify.inject({ method: 'GET', url: '/api/elevation', query });
    expect(first.json()).toEqual({ elevation: 2500 });
    expect(second.json()).toEqual({ elevation: 2500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns { elevation: null } when the DEM API responds non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const res = await fastify.inject({ method: 'GET', url: '/api/elevation', query: { lat: '45.55', lng: '9.81' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ elevation: null });
  });

  it('returns { elevation: null } when the DEM API request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const res = await fastify.inject({ method: 'GET', url: '/api/elevation', query: { lat: '45.66', lng: '9.82' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ elevation: null });
  });
});
