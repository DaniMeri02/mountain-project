/** Truncates text at the last word boundary before maxLength characters. */
export function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.lastIndexOf(' ', maxLength);
  return cut > 0 ? text.substring(0, cut) : text.substring(0, maxLength);
}

/** Shared HTML fetch headers used by web scrapers. */
export const SCRAPER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MountainPortal/1.0; personal-project)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'it-IT,it;q=0.9',
} as const;

/**
 * Fetches a URL and returns the response body as text.
 * Returns null on network errors, timeouts, or non-2xx responses.
 */
export async function fetchHtml(url: string, timeoutMs = 8_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: SCRAPER_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.error('[http] fetchHtml failed:', url, err);
    return null;
  }
}
