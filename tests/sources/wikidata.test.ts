import { describe, it, expect, vi, afterEach } from 'vitest';
import { sparqlEscape, formatRow, fetchWikidata } from '../../agent/sources/wikidata';
import type { WikidataRow } from '../../agent/types';
import wikidataResponse from '../fixtures/wikidata-response.json';
import wikidataEmpty from '../fixtures/wikidata-empty.json';

function mockFetch(data: unknown, ok = true) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok,
    json: () => Promise.resolve(data),
  } as Response);
}

afterEach(() => vi.restoreAllMocks());

describe('sparqlEscape', () => {
  it('escapes backslashes', () => {
    expect(sparqlEscape('path\\file')).toBe('path\\\\file');
  });

  it('escapes double quotes', () => {
    expect(sparqlEscape('say "hello"')).toBe('say \\"hello\\"');
  });
});

describe('formatRow', () => {
  it('includes all fields when present', () => {
    const row: WikidataRow = {
      description: { type: 'literal', value: 'A mountain hut' },
      elevation: { type: 'literal', value: '1939' },
      inception: { type: 'literal', value: '1955-06-01T00:00:00Z' },
      website: { type: 'uri', value: 'https://example.com' },
      wikipedia: { type: 'uri', value: 'https://it.wikipedia.org/wiki/Test' },
    };
    const result = formatRow(row);
    expect(result).toContain('Descrizione: A mountain hut');
    expect(result).toContain('Altitudine (Wikidata): 1939m');
    expect(result).toContain('Anno di costruzione/inaugurazione: 1955');
    expect(result).toContain('Sito ufficiale: https://example.com');
    expect(result).toContain('Pagina Wikipedia: https://it.wikipedia.org/wiki/Test');
  });

  it('omits absent fields', () => {
    const row: WikidataRow = {
      description: { type: 'literal', value: 'Just a description' },
    };
    const result = formatRow(row);
    expect(result).toBe('Descrizione: Just a description');
  });

  it('skips year when inception date is invalid', () => {
    const row: WikidataRow = {
      inception: { type: 'literal', value: 'not-a-date' },
    };
    const result = formatRow(row);
    expect(result).toBe('');
  });
});

describe('fetchWikidata', () => {
  it('returns success with content and url on name match', async () => {
    mockFetch(wikidataResponse);
    const result = await fetchWikidata({ name: 'Rifugio Albani', type: 'hut' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Rifugio alpino nelle Alpi Orobie');
    expect(result.url).toBe('http://www.wikidata.org/entity/Q123456');
  });

  it('falls back to coordinate query when name returns empty', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(wikidataEmpty) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(wikidataResponse) } as Response);

    const result = await fetchWikidata({ name: 'Unknown Peak', type: 'peak', lat: 45.9, lng: 9.8 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.sourceName).toBe('Wikidata (coordinate)');
  });

  it('returns success:false without second fetch when no coords', async () => {
    const fetchSpy = mockFetch(wikidataEmpty);
    const result = await fetchWikidata({ name: 'Ghost Peak', type: 'peak' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it('returns success:false on HTTP error', async () => {
    mockFetch({}, false);
    const result = await fetchWikidata({ name: 'Test', type: 'hut' });
    expect(result.success).toBe(false);
  });

  it('returns success:false when fetch throws', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    const result = await fetchWikidata({ name: 'Test', type: 'hut' });
    expect(result.success).toBe(false);
  });
});
