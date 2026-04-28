import { describe, it, expect, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('pg', () => ({
  Pool: vi.fn(function () { return { query: vi.fn(), end: vi.fn() }; }),
}));

vi.mock('../agent/orchestrator', () => ({
  AgentOrchestrator: vi.fn(function () { return { generate: vi.fn() }; }),
  AI_MODELS: [],
}));

import { fastify } from '../server';

function poolQuery(): ReturnType<typeof vi.fn> {
  const instance = vi.mocked(Pool).mock.results[0]?.value as { query: ReturnType<typeof vi.fn> };
  return instance.query;
}

const VALID_BBOX = { minLng: '9.5', minLat: '45.5', maxLng: '9.7', maxLat: '45.7' };
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const GEOJSON_ROW = { rows: [{ geojson: EMPTY_FC }] };

describe('GET /api/offline/bundle', () => {
  it('returns trails+pois+ferrata bundle for valid bbox', async () => {
    poolQuery()
      .mockResolvedValueOnce(GEOJSON_ROW)
      .mockResolvedValueOnce(GEOJSON_ROW)
      .mockResolvedValueOnce(GEOJSON_ROW);

    const res = await fastify.inject({ method: 'GET', url: '/api/offline/bundle', query: VALID_BBOX });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('bbox');
    expect(body).toHaveProperty('generated_at');
    expect(body.trails).toMatchObject({ type: 'FeatureCollection' });
    expect(body.pois).toMatchObject({ type: 'FeatureCollection' });
    expect(body.ferrata).toMatchObject({ type: 'FeatureCollection' });
    expect(body.bbox).toEqual([9.5, 45.5, 9.7, 45.7]);
  });

  it('returns 400 for invalid bbox', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/offline/bundle',
      query: { minLng: '10', minLat: '46', maxLng: '9', maxLat: '45' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 413 for oversized bbox (> 0.5°)', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/offline/bundle',
      query: { minLng: '9.0', minLat: '45.0', maxLng: '9.6', maxLat: '45.6' },
    });
    expect(res.statusCode).toBe(413);
  });

  it('falls back gracefully when via_ferrata table is missing', async () => {
    poolQuery()
      .mockResolvedValueOnce(GEOJSON_ROW)
      .mockResolvedValueOnce(GEOJSON_ROW)
      .mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

    const res = await fastify.inject({ method: 'GET', url: '/api/offline/bundle', query: VALID_BBOX });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ferrata).toEqual(EMPTY_FC);
    expect(body.trails).toMatchObject({ type: 'FeatureCollection' });
    expect(body.pois).toMatchObject({ type: 'FeatureCollection' });
  });

  it('returns 500 on unexpected DB error', async () => {
    poolQuery()
      .mockResolvedValueOnce(GEOJSON_ROW)
      .mockResolvedValueOnce(GEOJSON_ROW)
      .mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));

    const res = await fastify.inject({ method: 'GET', url: '/api/offline/bundle', query: VALID_BBOX });

    expect(res.statusCode).toBe(500);
  });
});
