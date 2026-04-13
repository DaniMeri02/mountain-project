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
 * Scans raw HTML for numeric ferrata stats that may be in any element or JS data.
 * Returns a compact string like "Dislivello: 534 m | Altitudine max: 1736 m | ..."
 */
function extractStatsFromHtml(rawHtml: string): string {
  // Strip tags and decode HTML entities to get a flat text stream
  const flat = rawHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ');

  const patterns: Array<[string, RegExp]> = [
    ['Dislivello', /Dislivello\s*:?\s*(\d[\d\s]*m)/i],
    ['Altitudine max', /Altitudine\s*max\s*:?\s*(\d+\s*m)/i],
    ['Lunghezza', /Lunghezza\s*:?\s*(\d[\d.,]*\s*km)/i],
    ['Avvicinamento', /Avvicinamento\s*:?\s*(\d+[h:'\s]\d*\s*[hm']*)/i],
    ['Durata ferrata', /(?:^|[^a-z])Ferrata\s*:?\s*(\d+[h:'\s]\d*\s*[hm']*)/i],
    ['Itinerario', /Itinerario\s*:?\s*(\d+[h:'\s]\d*\s*[hm']*)/i],
  ];

  const found: string[] = [];
  for (const [label, pattern] of patterns) {
    const match = flat.match(pattern);
    if (match) found.push(`${label}: ${match[1].trim()}`);
  }
  return found.join(' | ');
}

/**
 * Fetches and scrapes a ferrate365.it ferrata detail page.
 * Returns key stats (always) + main description text, or null on failure.
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

  // Extract numeric stats from the raw HTML before Cheerio strips anything.
  // These values may live in any element or even inside JS/JSON blobs.
  const stats = extractStatsFromHtml(html);

  const $ = load(html);
  $('script, style, nav, header, footer, .menu, aside, .sidebar, .widget, .comments').remove();

  const mainContent = $(
    'main, article, .content, .entry-content, #content, .ferrata-content'
  ).first();
  const rawText = mainContent.length > 0 ? mainContent.text() : $('body').text();
  const mainText = rawText.replace(/\s+/g, ' ').trim();

  // Stats always come first so Gemini sees them even if description is long
  const parts = [
    stats.length > 0 ? `Dettagli: ${stats}` : '',
    mainText.substring(0, 2_800),
  ].filter(s => s.length > 0);

  const combined = parts.join('\n\n');
  return combined.length > 150 ? combined : null;
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
