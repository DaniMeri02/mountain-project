import { load } from 'cheerio';
import type { AgentInput, SourceResult } from '../types';

const BASE_URL = 'https://www.ferrate365.it';
const DDG_SEARCH = 'https://lite.duckduckgo.com/lite/';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MountainPortal/1.0; personal-project)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'it-IT,it;q=0.9',
} as const;

/**
 * Uses DuckDuckGo Lite to find the ferrate365.it detail page URL for a given ferrata name.
 * DDG Lite returns static HTML with result links wrapped in redirect URLs.
 * Pattern: //duckduckgo.com/l/?uddg={encoded_url}&rut=...
 */
async function findFerrataUrl(name: string): Promise<string | null> {
  const query = `site:${BASE_URL}/vie-ferrate ${name}`;
  const searchUrl = `${DDG_SEARCH}?q=${encodeURIComponent(query)}`;

  let html: string;
  try {
    const res = await fetch(searchUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const $ = load(html);

  // DDG Lite wraps result URLs in redirect links: ?uddg=https%3A%2F%2F...
  let foundUrl: string | null = null;
  $('a').each((_, el) => {
    if (foundUrl) return;
    const href = $(el).attr('href') ?? '';
    const match = href.match(/[?&]uddg=([^&]+)/);
    if (!match) return;
    const decoded = decodeURIComponent(match[1]);
    if (decoded.startsWith(`${BASE_URL}/vie-ferrate/`) && decoded !== `${BASE_URL}/vie-ferrate/`) {
      foundUrl = decoded;
    }
  });

  return foundUrl;
}

/**
 * Fetches and scrapes a ferrate365.it ferrata detail page.
 * Returns up to 3000 characters of cleaned main content, or null on failure.
 */
async function scrapeDetailPage(url: string): Promise<string | null> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const $ = load(html);
  $('script, style, nav, header, footer, .menu, aside, .sidebar, .widget, .comments').remove();

  const mainContent = $(
    'main, article, .content, .entry-content, #content, .ferrata-content'
  ).first();
  const rawText = mainContent.length > 0 ? mainContent.text() : $('body').text();

  const cleaned = rawText.replace(/\s+/g, ' ').trim();
  return cleaned.length > 150 ? cleaned.substring(0, 3_000) : null;
}

export async function fetchFerrate365Data(input: AgentInput): Promise<SourceResult> {
  if (input.type !== 'ferrata') {
    return { sourceName: 'Ferrate365', content: '', success: false };
  }

  const detailUrl = await findFerrataUrl(input.name);
  if (!detailUrl) {
    return { sourceName: 'Ferrate365', content: '', success: false };
  }

  const content = await scrapeDetailPage(detailUrl);
  if (!content) {
    return { sourceName: 'Ferrate365', content: '', success: false };
  }

  return { sourceName: 'Ferrate365.it', content, success: true, url: detailUrl };
}
