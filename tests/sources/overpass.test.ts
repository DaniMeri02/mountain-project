import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchOverpassData } from '../../agent/sources/overpass';
import type { AgentInput } from '../../agent/types';

const baseInput: AgentInput = {
  name: 'Rifugio Test',
  type: 'hut',
  osm_id: '123456',
  lat: 46.0,
  lng: 9.5,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchOverpassData', () => {
  it('returns failure when osm_id is null', async () => {
    const result = await fetchOverpassData({ ...baseInput, osm_id: null });
    expect(result.success).toBe(false);
  });

  it('returns failure when osm_id is not a finite number', async () => {
    const result = await fetchOverpassData({ ...baseInput, osm_id: 'not-a-number' });
    expect(result.success).toBe(false);
  });

  it('returns failure when API returns empty elements array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [] }),
    }));

    const result = await fetchOverpassData(baseInput);
    expect(result.success).toBe(false);
  });

  it('returns failure when element has no useful tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{ type: 'node', id: 123456, tags: { source: 'survey' } }],
      }),
    }));

    const result = await fetchOverpassData(baseInput);
    expect(result.success).toBe(false);
  });

  it('returns formatted content for a node with useful tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{
          type: 'node',
          id: 123456,
          tags: { name: 'Rifugio Test', ele: '1800', operator: 'CAI' },
        }],
      }),
    }));

    const result = await fetchOverpassData(baseInput);
    expect(result.success).toBe(true);
    expect(result.content).toContain('name: Rifugio Test');
  });

  it('returns failure on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failed')));

    const result = await fetchOverpassData(baseInput);
    expect(result.success).toBe(false);
  });

  it('returns failure on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }));

    const result = await fetchOverpassData(baseInput);
    expect(result.success).toBe(false);
  });
});
