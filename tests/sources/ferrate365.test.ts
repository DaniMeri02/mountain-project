import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFerrate365Data } from '../../agent/sources/ferrate365-scraper';
import type { AgentInput } from '../../agent/types';

afterEach(() => {
  vi.restoreAllMocks();
});

const ferrataInput: AgentInput = {
  name: 'Ferrata Test',
  type: 'ferrata',
};

const nonFerrataInput: AgentInput = {
  name: 'Rifugio Test',
  type: 'hut',
};

describe('fetchFerrate365Data', () => {
  it('returns failure immediately for non-ferrata POI types', async () => {
    const result = await fetchFerrate365Data(nonFerrataInput);
    expect(result.success).toBe(false);
    expect(result.content).toBe('');
  });

  it('returns failure when DuckDuckGo returns no matching link', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body><a href="https://other.com">Other</a></body></html>',
    }));

    const result = await fetchFerrate365Data(ferrataInput);
    expect(result.success).toBe(false);
  });

  it('returns failure when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await fetchFerrate365Data(ferrataInput);
    expect(result.success).toBe(false);
  });

  it('does not crash when regex capture groups produce no match in stats extraction', async () => {
    // DDG search returns a valid ferrate365 URL
    const ddgHtml = `<html><body><a href="/?uddg=https%3A%2F%2Fwww.ferrate365.it%2Fvie-ferrate%2Ftest-ferrata">Result</a></body></html>`;
    // Detail page returns HTML with no numeric stats and short text (should return null content)
    const detailHtml = `<html><body><main>Too short</main></body></html>`;

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => ddgHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => detailHtml }),
    );

    // Should not throw — returns failure gracefully
    const result = await fetchFerrate365Data(ferrataInput);
    expect(result.success).toBe(false);
  });
});
