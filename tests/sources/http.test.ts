import { describe, it, expect, vi, afterEach } from 'vitest';
import { truncateAtWord, fetchHtml } from '../../agent/sources/http';

describe('truncateAtWord', () => {
  it('returns text unchanged when shorter than limit', () => {
    expect(truncateAtWord('hello world', 50)).toBe('hello world');
  });

  it('cuts at last word boundary before limit', () => {
    const result = truncateAtWord('hello world foo bar', 12);
    expect(result).toBe('hello world');
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it('falls back to hard cut when no space found before limit', () => {
    const result = truncateAtWord('averylongwordwithoutspaces', 5);
    expect(result).toBe('avery');
    expect(result.length).toBe(5);
  });

  it('handles empty string', () => {
    expect(truncateAtWord('', 10)).toBe('');
  });

  it('handles text exactly at limit', () => {
    const text = 'hello';
    expect(truncateAtWord(text, 5)).toBe('hello');
  });
});

describe('fetchHtml', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns html text on 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html>hello</html>',
    }));

    const result = await fetchHtml('https://example.com');
    expect(result).toBe('<html>hello</html>');
  });

  it('returns null on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));

    const result = await fetchHtml('https://example.com');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await fetchHtml('https://example.com');
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new DOMException('Timeout', 'TimeoutError'))
    ));

    const result = await fetchHtml('https://example.com', 5_000);
    expect(result).toBeNull();
  });
});
