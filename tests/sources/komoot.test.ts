import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalize, fetchKomootData } from '../../agent/sources/komoot';
import highlightsFixture from '../fixtures/komoot-highlights.json';
import toursFixture from '../fixtures/komoot-tours.json';
import tipsFixture from '../fixtures/komoot-tips.json';

const BASE_INPUT = { name: 'Rifugio Albani', type: 'hut' as const, lat: 45.9, lng: 9.8 };
const EMPTY_ITEMS = { _embedded: { items: [] } };

afterEach(() => vi.restoreAllMocks());

/** Chain multiple mock responses onto a single fetch spy in order. */
function mockFetchSequence(...responses: unknown[]) {
  let spy = vi.spyOn(global, 'fetch');
  for (const r of responses) {
    spy = spy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(r) } as Response);
  }
  return spy;
}

// ── Pure helper ──────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('strips accents and lowercases', () => {
    expect(normalize('Büel Höhe')).toBe('buel hohe');
    expect(normalize('Rifügio Albàni')).toBe('rifugio albani');
  });
});

// ── fetchKomootData ──────────────────────────────────────────────────────────

describe('fetchKomootData', () => {
  it('returns success:false immediately when lat/lng are missing', async () => {
    const spy = vi.spyOn(global, 'fetch');
    const result = await fetchKomootData({ name: 'Test', type: 'hut' });
    expect(result.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('matches highlight by full-name substring', async () => {
    // "rifugio albani" is a substring of "rifugio albani" (exact match on first radius)
    mockFetchSequence(highlightsFixture, toursFixture, tipsFixture);
    const result = await fetchKomootData(BASE_INPUT);
    expect(result.success).toBe(true);
    expect(result.url).toContain('123456');
  });

  it('matches highlight by word-overlap when full strings differ', async () => {
    // Needle: "rifugio barbellino" → significant word: "barbellino"
    // Highlight name: "Barbellino Lake" — neither contains the other, but shares "barbellino"
    const highlights = { _embedded: { items: [
      { id: 555, base_name: 'Barbellino Lake', name: 'Barbellino Lake', intro: 'A glacial lake.' },
    ] } };
    mockFetchSequence(highlights, toursFixture, tipsFixture);
    const result = await fetchKomootData({ name: 'Rifugio Barbellino', type: 'hut', lat: 45.9, lng: 9.8 });
    expect(result.success).toBe(true);
    expect(result.url).toContain('555');
  });

  // TODO(human): add a test for the word-length boundary (w.length >= 5) in the needleWords filter

  it('does not match via generic words alone', async () => {
    // "monte hut" → needleWords=[] (both are GENERIC_WORDS) → word-overlap skipped
    // Mock all 3 radius calls returning a non-matching highlight
    const nonMatch = { _embedded: { items: [
      { id: 999, base_name: 'Rifugio Bianco', name: 'Rifugio Bianco' },
    ] } };
    mockFetchSequence(nonMatch, nonMatch, nonMatch);
    const result = await fetchKomootData({ name: 'Monte Hut', type: 'peak', lat: 45.9, lng: 9.8 });
    expect(result.success).toBe(false);
  });

  it('includes formatted tour lines in content', async () => {
    mockFetchSequence(highlightsFixture, toursFixture, tipsFixture);
    const result = await fetchKomootData(BASE_INPUT);
    expect(result.content).toContain('Hike to Rifugio Albani');
    expect(result.content).toContain('12.5 km');
    expect(result.content).toContain('↑750 m');
    expect(result.content).toContain('moderate');
  });

  it('shows only the top 3 tips sorted by upvotes', async () => {
    mockFetchSequence(highlightsFixture, toursFixture, tipsFixture);
    const result = await fetchKomootData(BASE_INPUT);
    // Top 3 tips (42↑, 28↑, 15↑) should appear; 4th tip (5↑) should not
    expect(result.content).toContain('Excellent refuge, friendly staff');
    expect(result.content).toContain('Book in advance during summer');
    expect(result.content).toContain('Excellent local cuisine');
    expect(result.content).not.toContain('This tip should not appear');
  });

  it('uses fallback nearby tours when primary highlight has none', async () => {
    const emptyTours = { _embedded: { items: [] } };
    const nearbyHighlights = { _embedded: { items: [
      { id: 789, base_name: 'Nearby Hut Albani', name: 'Nearby Hut' },
    ] } };
    // Sequence: highlights → empty tours + tips → 5km fallback highlights → tours from fallback
    mockFetchSequence(
      highlightsFixture,   // findNearbyHighlight (radius 300) → finds highlight 123456
      emptyTours,          // fetchTours(123456) → empty
      tipsFixture,         // fetchTips(123456)
      nearbyHighlights,    // fetchNearbyFallbackTours → 5km highlights
      toursFixture,        // fetchTours(789) → has tours
    );
    const result = await fetchKomootData(BASE_INPUT);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Nearby approach routes (via');
  });

  it('long tour text (>300 chars) is returned directly without detail fetch', async () => {
    mockFetchSequence(highlightsFixture, toursFixture, tipsFixture);
    const fetchSpy = vi.spyOn(global, 'fetch');
    await fetchKomootData(BASE_INPUT);
    // Verify no additional /tours/{id} detail calls beyond highlights + tours + tips
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    const detailCalls = urls.filter((u) => u.match(/\/tours\/\d+$/) && !u.includes('discover_tours'));
    expect(detailCalls).toHaveLength(0);
  });

  it('short tour text fetches FAQ from detail endpoint', async () => {
    const shortTourFixture = { _embedded: { items: [
      { id: 't42', name: 'Short Tour', distance: 5000, elevation_up: 300,
        difficulty: { grade: 'easy' },
        _embedded: { tour_description: { text: 'A short hike.' } } },
    ] } };
    const detailFixture = { faq: [
      { question: 'What terrain to expect?', answer: 'Rocky alpine terrain with great views.' },
    ] };
    mockFetchSequence(highlightsFixture, shortTourFixture, tipsFixture, detailFixture);
    const result = await fetchKomootData(BASE_INPUT);
    expect(result.content).toContain('Rocky alpine terrain with great views.');
  });

  it('returns success:false when all radii find no matching highlight', async () => {
    mockFetchSequence(EMPTY_ITEMS, EMPTY_ITEMS, EMPTY_ITEMS);
    const result = await fetchKomootData(BASE_INPUT);
    expect(result.success).toBe(false);
  });

  it('returns success:false when all radius fetches throw', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
    const result = await fetchKomootData(BASE_INPUT);
    expect(result.success).toBe(false);
  });
});
