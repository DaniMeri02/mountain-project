import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace the orchestrator with a 2-model stub so no network/key is needed.
vi.mock('../agent/orchestrator', () => ({
  AI_MODELS: [
    { slug: 'm1', label: 'Model 1', base: 'https://x/v1', key: 'GROQ_API_KEY' },
    { slug: 'm2', label: 'Model 2', base: 'https://x/v1', key: 'GROQ_API_KEY' },
  ],
  callAiModel: vi.fn(),
  shouldCascade: (err: unknown) => {
    const s = (err as { status?: number }).status;
    return s == null || s === 429 || s >= 500;
  },
}));

import { callAiModel } from '../agent/orchestrator';
import {
  validateFilter,
  translateQuery,
  parseFilterJson,
  clearTranslationCache,
  FilterParseError,
} from '../agent/search-filter';

const mockedCall = vi.mocked(callAiModel);

beforeEach(() => {
  vi.clearAllMocks();
  clearTranslationCache();
});

describe('validateFilter', () => {
  it('keeps only known searchable types', () => {
    expect(validateFilter({ types: ['hut', 'dragon', 'peak'] }).types).toEqual(['hut', 'peak']);
  });

  it('drops an unknown area kind', () => {
    expect(validateFilter({ area: { kind: 'galaxy', name: 'X' } }).area).toBeNull();
  });

  it('requires a name for province/region areas', () => {
    expect(validateFilter({ area: { kind: 'province' } }).area).toBeNull();
    expect(validateFilter({ area: { kind: 'province', name: 'Bergamo' } }).area).toEqual({
      kind: 'province',
      name: 'Bergamo',
    });
  });

  it('keeps a viewport area even without a bbox (the route fills it)', () => {
    expect(validateFilter({ area: { kind: 'viewport' } }).area).toEqual({ kind: 'viewport', bbox: null });
  });

  it('caps limit at 50 and floors offset at 0', () => {
    const f = validateFilter({ limit: 999, offset: -5 });
    expect(f.limit).toBe(50);
    expect(f.offset).toBe(0);
  });

  it('falls back to elevation_desc for an unknown sort', () => {
    expect(validateFilter({ sort: 'random' }).sort).toBe('elevation_desc');
  });

  it('normalizes numeric via ferrata grades to letters', () => {
    const f = validateFilter({ difficulty: { viaFerrataScale: { min: '4' } } });
    expect(f.difficulty?.viaFerrataScale).toEqual({ min: 'D', max: null });
  });

  it('filters sacScale down to the known set', () => {
    const f = validateFilter({ difficulty: { sacScale: ['alpine_hiking', 'bogus'] } });
    expect(f.difficulty?.sacScale).toEqual(['alpine_hiking']);
  });

  it('drops a non-finite elevation', () => {
    expect(validateFilter({ elevation: { min: 'abc' } }).elevation).toBeNull();
  });
});

describe('parseFilterJson', () => {
  it('extracts JSON wrapped in prose and code fences', () => {
    const raw = 'Sure!\n```json\n{"types":["hut"]}\n```\n';
    expect(parseFilterJson(raw)).toEqual({ types: ['hut'] });
  });

  it('throws FilterParseError when there is no JSON object', () => {
    expect(() => parseFilterJson('no json here')).toThrow(FilterParseError);
  });
});

describe('translateQuery', () => {
  it('translates a query into a validated filter', async () => {
    mockedCall.mockResolvedValueOnce(
      '{"types":["hut"],"elevation":{"min":2000},"area":{"kind":"province","name":"Bergamo"}}',
    );
    const { filter, modelUsed, fromCache } = await translateQuery('rifugi sopra i 2000m in bergamasca');
    expect(filter.types).toEqual(['hut']);
    expect(filter.elevation).toEqual({ min: 2000, max: null });
    expect(filter.area).toEqual({ kind: 'province', name: 'Bergamo' });
    expect(modelUsed).toBe('Model 1');
    expect(fromCache).toBe(false);
  });

  it('cascades to the next model when the first returns unparseable output', async () => {
    mockedCall
      .mockResolvedValueOnce('I cannot help with that')
      .mockResolvedValueOnce('{"types":["ferrata"]}');
    const { filter, modelUsed } = await translateQuery('vie ferrate in provincia di lecco');
    expect(filter.types).toEqual(['ferrata']);
    expect(modelUsed).toBe('Model 2');
    expect(mockedCall).toHaveBeenCalledTimes(2);
  });

  it('throws when no model yields a usable filter', async () => {
    mockedCall.mockResolvedValue('garbage with no json');
    await expect(translateQuery('???')).rejects.toThrow();
  });

  it('caches the translation: a normalized-equal query skips the model', async () => {
    mockedCall.mockResolvedValueOnce('{"types":["peak"],"elevation":{"min":2700}}');
    const first = await translateQuery('pizzi sopra i 2700m');
    const second = await translateQuery('Pizzi  sopra i 2700m'); // case + spacing variant
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.filter.types).toEqual(['peak']);
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });

  it('returns a clone so callers cannot mutate the cached filter', async () => {
    mockedCall.mockResolvedValueOnce('{"types":["peak"]}');
    const a = await translateQuery('cime');
    a.filter.types.push('hut');
    const b = await translateQuery('cime');
    expect(b.filter.types).toEqual(['peak']);
  });
});
