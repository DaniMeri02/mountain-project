import { load } from 'cheerio';
import type { AgentInput, SourceResult } from '../types';

const BASE_URL = 'https://www.ferrate365.it';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MountainPortal/1.0; personal-project)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'it-IT,it;q=0.9',
} as const;

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

async function scrapeFerrataPage(name: string): Promise<string | null> {
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(name)}`;

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

  // Find the first result link pointing to a ferrata detail page
  const detailHref = $search('a')
    .filter((_, el) => {
      const href = $search(el).attr('href') ?? '';
      return (
        href.startsWith(BASE_URL) &&
        (href.includes('ferrata') || href.includes('ferrate') || href.includes('via-ferrata'))
      );
    })
    .first()
    .attr('href');

  if (!detailHref) return null;

  let pageHtml: string;
  try {
    const pageRes = await fetch(detailHref, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!pageRes.ok) return null;
    pageHtml = await pageRes.text();
  } catch {
    return null;
  }

  const $page = load(pageHtml);

  $page('script, style, nav, header, footer, .menu, aside, .sidebar, .widget, .comments').remove();

  const mainContent = $page('main, article, .content, .entry-content, #content, .ferrata-content').first();
  const rawText = mainContent.length > 0 ? mainContent.text() : $page('body').text();

  const cleaned = cleanText(rawText);
  return cleaned.length > 150 ? cleaned.substring(0, 3_000) : null;
}

export async function fetchFerrate365Data(input: AgentInput): Promise<SourceResult> {
  if (input.type !== 'ferrata') {
    return { sourceName: 'Ferrate365', content: '', success: false };
  }

  const content = await scrapeFerrataPage(input.name);
  if (!content) {
    return { sourceName: 'Ferrate365', content: '', success: false };
  }

  return { sourceName: 'Ferrate365.it', content, success: true };
}
