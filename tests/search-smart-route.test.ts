import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool } from 'pg';

vi.mock('pg', () => ({
  Pool: vi.fn(function () {
    return { query: vi.fn(), end: vi.fn() };
  }),
}));

// server.ts imports AI_MODELS at load; mock orchestrator to avoid needing real keys.
vi.mock('../agent/orchestrator', () => ({
  AgentOrchestrator: vi.fn(function () {
    return { generate: vi.fn() };
  }),
  AI_MODELS: [{ slug: 'm1', label: 'Model 1', base: 'b', key: 'GROQ_API_KEY' }],
  callAiModel: vi.fn(),
  shouldCascade: () => true,
}));

// Keep the real validator + query builder; stub only the LLM translation step.
vi.mock('../agent/search-filter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/search-filter')>();
  return { ...actual, translateQuery: vi.fn() };
});

import { fastify } from '../server';
import { translateQuery } from '../agent/search-filter';
import type { SearchFilter } from '../agent/types';

const mockedTranslate = vi.mocked(translateQuery);

function poolQuery(): ReturnType<typeof vi.fn> {
  const instance = vi.mocked(Pool).mock.results[0]?.value as { query: ReturnType<typeof vi.fn> };
  return instance.query;
}

const baseFilter: SearchFilter = {
  types: ['hut'],
  minElevation: 2000,
  maxElevation: null,
  area: { kind: 'province', name: 'Bergamo' },
  difficulty: null,
  nameContains: null,
  sort: 'elevation_desc',
  limit: 50,
  offset: 0,
};

const row = (over: Record<string, unknown>) => ({
  id: 1, osm_id: 42, type: 'hut', name: 'Rifugio Curò', elevation: 1915,
  lng: 10.0, lat: 46.0, via_ferrata_scale: null, sac_scale: null, source_type: null,
  total: '1', ...over,
});

beforeEach(() => {
  // Reset only call history + queued impls; do NOT clearAllMocks — that would wipe
  // the Pool constructor's recorded instance (Pool is built once at server import).
  mockedTranslate.mockReset();
  poolQuery().mockReset();
});

describe('POST /api/search/smart', () => {
  it('translates q, runs the query, and returns results + total + the executed filter', async () => {
    mockedTranslate.mockResolvedValueOnce({ filter: baseFilter, modelUsed: 'Model 1', fromCache: false });
    poolQuery().mockResolvedValueOnce({ rows: [row({})] });

    const res = await fastify.inject({
      method: 'POST', url: '/api/search/smart',
      headers: { 'content-type': 'application/json' },
      payload: { q: 'rifugi sopra i 2000m in bergamasca' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ name: 'Rifugio Curò' });
    expect(body.results[0]).not.toHaveProperty('total');
    expect(body.filter.area).toMatchObject({ kind: 'province', name: 'Bergamo' });
    expect(body.modelUsed).toBe('Model 1');
    expect(mockedTranslate).toHaveBeenCalledOnce();
  });

  it('paginates from a provided filter WITHOUT calling the translator', async () => {
    poolQuery().mockResolvedValueOnce({ rows: [row({ name: 'Rifugio B', total: '99' })] });

    const res = await fastify.inject({
      method: 'POST', url: '/api/search/smart',
      headers: { 'content-type': 'application/json' },
      payload: { filter: baseFilter, offset: 50 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(99);
    expect(body.offset).toBe(50);
    expect(mockedTranslate).not.toHaveBeenCalled();
  });

  it('returns 422 when the translator cannot interpret the query', async () => {
    mockedTranslate.mockRejectedValueOnce(new Error('all models failed'));
    const res = await fastify.inject({
      method: 'POST', url: '/api/search/smart',
      headers: { 'content-type': 'application/json' },
      payload: { q: 'asdkfjghqwe' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 400 when neither q nor filter is provided', async () => {
    const res = await fastify.inject({
      method: 'POST', url: '/api/search/smart',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('degrades gracefully (empty set) when a required table is missing', async () => {
    mockedTranslate.mockResolvedValueOnce({ filter: baseFilter, modelUsed: 'Model 1', fromCache: false });
    poolQuery().mockRejectedValueOnce(Object.assign(new Error('relation "admin_areas" does not exist'), { code: '42P01' }));

    const res = await fastify.inject({
      method: 'POST', url: '/api/search/smart',
      headers: { 'content-type': 'application/json' },
      payload: { q: 'rifugi in bergamasca' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([]);
    expect(res.json().total).toBe(0);
  });

  it('injects the request viewport bbox for "in questa zona" queries', async () => {
    const viewportFilter: SearchFilter = { ...baseFilter, area: { kind: 'viewport', bbox: null } };
    mockedTranslate.mockResolvedValueOnce({ filter: viewportFilter, modelUsed: 'Model 1', fromCache: false });
    const query = poolQuery();
    query.mockResolvedValueOnce({ rows: [] });

    const res = await fastify.inject({
      method: 'POST', url: '/api/search/smart',
      headers: { 'content-type': 'application/json' },
      payload: { q: 'rifugi in questa zona', viewport: [9.5, 45.8, 9.9, 46.1] },
    });

    expect(res.statusCode).toBe(200);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(expect.arrayContaining([9.5, 45.8, 9.9, 46.1]));
  });
});
