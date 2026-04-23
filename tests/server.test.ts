import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { AgentOrchestrator } from '../agent/orchestrator';

// Mock pg so server.ts can load without a real database
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: vi.fn(), end: vi.fn() })),
}));

// Mock orchestrator to avoid needing a real Gemini key at import time
vi.mock('../agent/orchestrator', () => ({
  AgentOrchestrator: vi.fn(() => ({
    generate: vi.fn().mockResolvedValue({
      description: 'AI description',
      fromCache: false,
      sources: ['Wikidata'],
      generatedAt: '2026-04-20T10:00:00Z',
      expiresAt: '2026-04-22T10:00:00Z',
    }),
  })),
}));

// Import server AFTER mocks are registered
import { fastify, parseBBox } from '../server';

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
});
