import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildUserMessage, AgentOrchestrator } from '../agent/orchestrator';
import type { Pool } from 'pg';
import type { SourceResult, CachedDescription } from '../agent/types';
import { fetchWikidata } from '../agent/sources/wikidata';
import { fetchOverpassData } from '../agent/sources/overpass';
import { fetchRifugiData } from '../agent/sources/rifugi-scraper';
import { fetchFerrate365Data } from '../agent/sources/ferrate365-scraper';
import { fetchYouTubeVideos } from '../agent/sources/youtube';
import { fetchRedditPosts } from '../agent/sources/reddit';
import { fetchKomootData } from '../agent/sources/komoot';
import { AiDescriptionCache } from '../agent/cache';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../agent/sources/wikidata', () => ({ fetchWikidata: vi.fn() }));
vi.mock('../agent/sources/overpass', () => ({ fetchOverpassData: vi.fn() }));
vi.mock('../agent/sources/rifugi-scraper', () => ({ fetchRifugiData: vi.fn() }));
vi.mock('../agent/sources/ferrate365-scraper', () => ({ fetchFerrate365Data: vi.fn() }));
vi.mock('../agent/sources/youtube', () => ({ fetchYouTubeVideos: vi.fn() }));
vi.mock('../agent/sources/reddit', () => ({ fetchRedditPosts: vi.fn() }));
vi.mock('../agent/sources/komoot', () => ({ fetchKomootData: vi.fn() }));
vi.mock('../agent/prompt-loader', () => ({ loadAgentPrompt: vi.fn(() => 'System prompt') }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: vi.fn() };
});

// Cache mock: AiDescriptionCache constructor returns mockCacheInstance (assigned in beforeEach)
let mockCacheInstance: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> };
vi.mock('../agent/cache', () => ({
  buildCacheKey: vi.fn(() => 'test-cache-key'),
  AiDescriptionCache: vi.fn().mockImplementation(function () { return mockCacheInstance; }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockPool = {} as Pool;
const baseInput = { name: 'Rifugio Albani', type: 'hut' as const, elevation: 1939, lat: 45.9, lng: 9.8 };

function makeSourceResult(name: string): SourceResult {
  return { sourceName: name, content: `${name} data`, success: true };
}

function makeCachedResult(): CachedDescription {
  return {
    description: 'Cached description',
    sources: ['Wikidata'],
    generatedAt: new Date('2026-04-19T10:00:00Z'),
    expiresAt: new Date('2026-04-21T10:00:00Z'),
  };
}

function makeAiResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: text } }] }),
  } as unknown as Response;
}

function makeAiError(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { message } }),
  } as unknown as Response;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => { process.env.GROQ_API_KEY = 'test-key'; });
afterAll(() => { delete process.env.GROQ_API_KEY; });

beforeEach(() => {
  vi.clearAllMocks();

  mockCacheInstance = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(new Date('2026-04-21T10:00:00Z')),
    invalidate: vi.fn().mockResolvedValue(undefined),
  };

  // Default: AI model returns success
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeAiResponse('AI generated description')));

  // Default: all sources succeed
  vi.mocked(fetchWikidata).mockResolvedValue(makeSourceResult('Wikidata'));
  vi.mocked(fetchOverpassData).mockResolvedValue(makeSourceResult('Overpass'));
  vi.mocked(fetchRifugiData).mockResolvedValue(makeSourceResult('Rifugi'));
  vi.mocked(fetchFerrate365Data).mockResolvedValue(makeSourceResult('Ferrate365'));
  vi.mocked(fetchYouTubeVideos).mockResolvedValue(makeSourceResult('YouTube'));
  vi.mocked(fetchRedditPosts).mockResolvedValue(makeSourceResult('Reddit'));
  vi.mocked(fetchKomootData).mockResolvedValue(makeSourceResult('Komoot'));
});

// ── buildUserMessage ──────────────────────────────────────────────────────────

describe('buildUserMessage', () => {
  it('includes all header fields when elevation and coords are present', () => {
    const msg = buildUserMessage(baseInput, []);
    expect(msg).toContain('Nome: Rifugio Albani');
    expect(msg).toContain('Tipo: hut');
    expect(msg).toContain('Altitudine: 1939m');
    expect(msg).toContain('Coordinate:');
  });

  it('omits elevation and coords lines when not provided', () => {
    const msg = buildUserMessage({ name: 'Test Hut', type: 'hut' }, []);
    expect(msg).not.toContain('Altitudine');
    expect(msg).not.toContain('Coordinate');
  });

  it('only includes successful sources in the data block', () => {
    const results: SourceResult[] = [
      { sourceName: 'Wikidata', content: 'Wiki content', success: true },
      { sourceName: 'Broken', content: 'Ignored', success: false },
    ];
    const msg = buildUserMessage(baseInput, results);
    expect(msg).toContain('=== WIKIDATA ===');
    expect(msg).not.toContain('=== BROKEN ===');
  });

  it('shows fallback message when no sources succeeded', () => {
    const msg = buildUserMessage(baseInput, []);
    expect(msg).toContain('Nessun dato aggiuntivo');
  });
});

// ── AgentOrchestrator.generate ────────────────────────────────────────────────

describe('AgentOrchestrator.generate', () => {
  it('returns fromCache:true on cache hit without calling any source', async () => {
    mockCacheInstance.get = vi.fn().mockResolvedValue(makeCachedResult());
    const orch = new AgentOrchestrator(mockPool);

    const result = await orch.generate(baseInput);
    expect(result.fromCache).toBe(true);
    expect(result.description).toBe('Cached description');
    expect(vi.mocked(fetchWikidata)).not.toHaveBeenCalled();
  });

  it('skips cache check on forceRegenerate=true', async () => {
    mockCacheInstance.get = vi.fn().mockResolvedValue(makeCachedResult());
    const orch = new AgentOrchestrator(mockPool);

    const result = await orch.generate(baseInput, true);
    expect(result.fromCache).toBe(false);
    expect(vi.mocked(fetchWikidata)).toHaveBeenCalled();
  });

  it('calls all 7 sources, AI model, and stores in cache on miss', async () => {
    const orch = new AgentOrchestrator(mockPool);
    await orch.generate(baseInput);
    expect(vi.mocked(fetchWikidata)).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchKomootData)).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(mockCacheInstance.set).toHaveBeenCalledOnce();
  });

  it('completes successfully when one source rejects', async () => {
    vi.mocked(fetchWikidata).mockRejectedValueOnce(new Error('Timeout'));
    const orch = new AgentOrchestrator(mockPool);
    const result = await orch.generate(baseInput);
    expect(result.fromCache).toBe(false);
    expect(result.description).toBe('AI generated description');
  });

  it('retries with second model on 503', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeAiError(503, 'Service overloaded'))
      .mockResolvedValueOnce(makeAiResponse('Fallback description')),
    );

    const orch = new AgentOrchestrator(mockPool);
    const result = await orch.generate(baseInput);

    expect(result.description).toBe('Fallback description');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws when all models return 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeAiError(503, 'Overloaded')));

    const orch = new AgentOrchestrator(mockPool);
    await expect(orch.generate(baseInput)).rejects.toThrow();
  });
});
