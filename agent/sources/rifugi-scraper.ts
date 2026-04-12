import { load } from 'cheerio';
import type { AgentInput, SourceResult } from '../types';

/**
 * Regional Alpine hut directory sites to try in order.
 * All use low-frequency scraping (max 1 request per POI per 48h via cache).
 */
const RIFUGI_SITES = [
  'https://www.rifugi.lombardia.it',
  'https://rifugi.bergamo.it',
  'https://rifugi.brescia.it',
  'https://rifugi.lecco.it',
] as const;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MountainPortal/1.0; personal-project)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'it-IT,it;q=0.9',
} as const;

/** Cleans raw text extracted by Cheerio: collapses whitespace, trims. */
function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Tries to find the hut page on a given base URL by searching for the name.
 * Returns up to 3000 characters of the main content, or null on failure.
 */
async function scrapeHutPage(baseUrl: string, name: string): Promise<string | null> {
  // Try WP-style search first, then a direct URL slug as fallback
  const searchUrl = `${baseUrl}/?s=${encodeURIComponent(name)}`;

  let searchHtml: string;
  try {
    const res = await fetch(searchUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    searchHtml = await res.text();
  } catch {
    return null;
  }

  const $search = load(searchHtml);

  // Look for the first link that plausibly points to a hut detail page
  const detailHref = $search('a')
    .filter((_, el) => {
      const href = $search(el).attr('href') ?? '';
      const text = $search(el).text().toLowerCase();
      return (
        (href.includes('rifugio') || href.includes('rifug') || href.includes('bivacco')) &&
        text.length > 3
      );
    })
    .first()
    .attr('href');

  if (!detailHref) return null;

  const pageUrl = detailHref.startsWith('http') ? detailHref : `${baseUrl}${detailHref}`;

  let pageHtml: string;
  try {
    const pageRes = await fetch(pageUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!pageRes.ok) return null;
    pageHtml = await pageRes.text();
  } catch {
    return null;
  }

  const $page = load(pageHtml);

  // Strip boilerplate
  $page('script, style, nav, header, footer, .menu, .navigation, aside, .sidebar, .widget').remove();

  // Prefer specific content containers, fall back to body
  const mainContent = $page('main, article, .content, .entry-content, #content, .page-content, .single-content').first();
  const rawText = mainContent.length > 0 ? mainContent.text() : $page('body').text();

  const cleaned = cleanText(rawText);
  return cleaned.length > 150 ? cleaned.substring(0, 3_000) : null;
}

export async function fetchRifugiData(input: AgentInput): Promise<SourceResult> {
  if (input.type !== 'hut' && input.type !== 'bivouac') {
    return { sourceName: 'Rifugi regionali', content: '', success: false };
  }

  for (const site of RIFUGI_SITES) {
    const content = await scrapeHutPage(site, input.name);
    if (content) {
      return {
        sourceName: `Rifugi regionali (${new URL(site).hostname})`,
        content,
        success: true,
      };
    }
  }

  return { sourceName: 'Rifugi regionali', content: '', success: false };
}
