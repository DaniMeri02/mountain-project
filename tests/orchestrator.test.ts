import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  buildUserMessage,
  AgentOrchestrator,
  shouldCascade,
  renderGoogleMapsBlock,
} from '../agent/orchestrator';
import { resolveGooglePlace } from '../agent/sources/google-places';
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
vi.mock('../agent/sources/google-places', () => ({ resolveGooglePlace: vi.fn() }));
vi.mock('../agent/google-place-cache', () => ({ GooglePlaceCache: vi.fn() }));
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

  // Default: no place lookup happened, which is what a run without GOOGLE_PLACES_API_KEY does.
  // It appends nothing, so tests unrelated to the link can assert on the description as-is.
  vi.mocked(resolveGooglePlace).mockResolvedValue({ status: 'unavailable' });
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

  it('cascades past a retired model slug (404) instead of aborting', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeAiError(404, 'The model `dead-slug` does not exist'))
      .mockResolvedValueOnce(makeAiResponse('Recovered description')),
    );

    const orch = new AgentOrchestrator(mockPool);
    const result = await orch.generate(baseInput);

    expect(result.description).toBe('Recovered description');
  });

  it('names every failed model when the whole cascade fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeAiError(404, 'gone')));

    const orch = new AgentOrchestrator(mockPool);
    await expect(orch.generate(baseInput)).rejects.toThrow(/All \d+ AI models failed/);
  });
});

// ── Google Maps block ─────────────────────────────────────────────────────────

describe('renderGoogleMapsBlock', () => {
  const url = 'https://www.google.com/maps/search/?api=1&query=Rifugio&query_place_id=ChIJx';

  it('renders a link that opens in a new tab, in Italian like the description', () => {
    const html = renderGoogleMapsBlock({ status: 'found', url, placeId: 'ChIJx' });
    expect(html).toContain('<h3>Google Maps</h3>');
    expect(html).toContain('Apri la scheda su Google Maps');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('escapes the href so the query separator cannot break the attribute', () => {
    const html = renderGoogleMapsBlock({ status: 'found', url, placeId: 'ChIJx' });
    expect(html).toContain('&amp;query_place_id=');
    expect(html).not.toMatch(/href="[^"]*[<>]/);
  });

  it('states the absence when Google answered and had nothing', () => {
    expect(renderGoogleMapsBlock({ status: 'not_found' })).toContain('Nessun link Google Maps disponibile.');
  });

  it('renders nothing when the lookup never produced an answer', () => {
    // A missing key, a throttled call or a network failure must not read as "no link exists".
    expect(renderGoogleMapsBlock({ status: 'unavailable' })).toBe('');
  });

  it('renders nothing when status is found but no url came back', () => {
    expect(renderGoogleMapsBlock({ status: 'found' })).toBe('');
  });
});

describe('AgentOrchestrator + Google Maps block', () => {
  const url = 'https://www.google.com/maps/search/?api=1&query=Rifugio%20Albani&query_place_id=ChIJalb';

  it('appends the link to the description and stores it in the cache', async () => {
    vi.mocked(resolveGooglePlace).mockResolvedValue({ status: 'found', url, placeId: 'ChIJalb' });
    const orch = new AgentOrchestrator(mockPool);

    const result = await orch.generate(baseInput);

    expect(result.description).toContain('AI generated description');
    expect(result.description).toContain('<h3>Google Maps</h3>');
    expect(mockCacheInstance.set.mock.calls[0][3]).toContain('query_place_id=ChIJalb');
  });

  it('never puts the URL in the message sent to the model', async () => {
    vi.mocked(resolveGooglePlace).mockResolvedValue({ status: 'found', url, placeId: 'ChIJalb' });
    const orch = new AgentOrchestrator(mockPool);

    await orch.generate(baseInput);

    const body = JSON.parse(String((vi.mocked(global.fetch).mock.calls[0][1] as RequestInit).body));
    const prompt = JSON.stringify(body.messages);
    expect(prompt).not.toContain('query_place_id');
    expect(prompt).not.toContain('google.com/maps');
  });

  it('appends the absence line when the place is verified absent', async () => {
    vi.mocked(resolveGooglePlace).mockResolvedValue({ status: 'not_found' });
    const orch = new AgentOrchestrator(mockPool);
    const result = await orch.generate(baseInput);
    expect(result.description).toContain('Nessun link Google Maps disponibile.');
  });

  it('leaves the description untouched when the lookup was unavailable', async () => {
    vi.mocked(resolveGooglePlace).mockResolvedValue({ status: 'unavailable' });
    const orch = new AgentOrchestrator(mockPool);

    const result = await orch.generate(baseInput);

    expect(result.description).toBe('AI generated description');
    expect(result.description).not.toContain('Google Maps');
  });

  it('starts the lookup before awaiting the sources, so it costs no extra latency', async () => {
    const order: string[] = [];
    vi.mocked(resolveGooglePlace).mockImplementation(async () => {
      order.push('places');
      return { status: 'not_found' };
    });
    vi.mocked(fetchWikidata).mockImplementation(async () => {
      order.push('wikidata');
      return makeSourceResult('Wikidata');
    });

    await new AgentOrchestrator(mockPool).generate(baseInput);

    expect(order[0]).toBe('places');
  });
});

// ── shouldCascade ─────────────────────────────────────────────────────────────

describe('shouldCascade', () => {
  const withStatus = (status?: number): Error => Object.assign(new Error('boom'), { status });

  it.each([
    ['network error / timeout', undefined],
    ['retired model slug', 404],
    ['prompt too large for this model', 413],
    ['exhausted key or quota', 429],
    ['bad key for this provider', 401],
    ['forbidden for this provider', 403],
    ['provider outage', 503],
  ])('cascades on %s', (_label, status) => {
    expect(shouldCascade(withStatus(status))).toBe(true);
  });

  it.each([
    ['malformed request body', 400],
    ['unprocessable request body', 422],
  ])('fails fast on %s — identical for every model', (_label, status) => {
    expect(shouldCascade(withStatus(status))).toBe(false);
  });
});
