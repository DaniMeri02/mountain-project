import { load } from 'cheerio';
import type { AgentInput, SourceResult } from '../types';

const LISTING_PAGES = [
  'https://rifugi.bergamo.it',  // Bergamo
  'https://rifugi.brescia.it',  // Brescia
  'https://rifugi.lecco.it',    // Lecco
  'https://rifugi.como.it',     // Como + Varese
  'https://rifugi.sondrio.it',  // Sondrio (Valtellina)
] as const;

const LOMBARDIA_HOST = 'rifugi.lombardia.it';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MountainPortal/1.0; personal-project)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'it-IT,it;q=0.9',
} as const;

// In-memory cache: listingUrl → parsed hut entries (static pages, fetch once per process)
const indexCache = new Map<string, { text: string; url: string }[]>();

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Normalize Italian text for fuzzy matching: lowercase, strip accents and punctuation */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[àáâã]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõ]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/['.`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip "rifugio"/"bivacco" prefix so "Rifugio Albani" matches link text "Albani" */
function stripPrefix(name: string): string {
  return normalize(name)
    .replace(/^(rifugio|bivacco|bivouac)\s+/, '')
    .trim();
}

/**
 * Fetches a provincial listing page and returns all links pointing to
 * rifugi.lombardia.it detail pages. Cached in memory after first fetch.
 */
async function buildHutIndex(listingUrl: string): Promise<{ text: string; url: string }[]> {
  if (indexCache.has(listingUrl)) {
    return indexCache.get(listingUrl)!;
  }

  let html: string;
  try {
    const res = await fetch(listingUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  const $ = load(html);
  const entries: { text: string; url: string }[] = [];

  $('a').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = cleanText($(el).text());
    if (href.includes(LOMBARDIA_HOST) && href.endsWith('.html') && text.length > 2) {
      entries.push({ text, url: href });
    }
  });

  indexCache.set(listingUrl, entries);
  return entries;
}

/**
 * Fuzzy-matches a hut name against an index of {text, url} entries.
 * Returns the best-matching URL, or null if no confident match found.
 *
 * Scoring:
 *  2 — exact match against normalized link text
 *  1 — all significant words (len≥4) from input found in URL slug
 *  0.5 — at least one significant word found in link text
 */
function findBestMatch(
  index: { text: string; url: string }[],
  inputName: string
): string | null {
  const normalizedInput = stripPrefix(inputName);
  const significantWords = normalizedInput.split(' ').filter((w) => w.length >= 4);

  let bestUrl: string | null = null;
  let bestScore = 0;

  for (const entry of index) {
    const normalizedText = stripPrefix(entry.text);
    const slug = normalize(entry.url.split('/').pop()?.replace('.html', '') ?? '');

    let score = 0;

    if (normalizedText === normalizedInput) {
      score = 2;
    } else if (
      significantWords.length > 0 &&
      significantWords.every((w) => slug.includes(w))
    ) {
      score = 1;
    } else if (
      significantWords.length > 0 &&
      significantWords.some((w) => normalizedText.includes(w))
    ) {
      score = 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = entry.url;
    }
  }

  return bestScore >= 0.5 ? bestUrl : null;
}

/**
 * Fetches and scrapes a rifugi.lombardia.it detail page.
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
  $('script, style, nav, header, footer, .menu, .navigation, aside, .sidebar, .widget').remove();

  const mainContent = $(
    'main, article, .content, .entry-content, #content, .page-content, .single-content'
  ).first();
  const rawText = mainContent.length > 0 ? mainContent.text() : $('body').text();

  const cleaned = cleanText(rawText);
  return cleaned.length > 150 ? cleaned.substring(0, 3_000) : null;
}

export async function fetchRifugiData(input: AgentInput): Promise<SourceResult> {
  if (input.type !== 'hut' && input.type !== 'bivouac') {
    return { sourceName: 'Rifugi regionali', content: '', success: false };
  }

  for (const listingUrl of LISTING_PAGES) {
    const index = await buildHutIndex(listingUrl);
    if (index.length === 0) continue;

    const detailUrl = findBestMatch(index, input.name);
    if (!detailUrl) continue;

    const content = await scrapeDetailPage(detailUrl);
    if (!content) continue;

    return {
      sourceName: `Rifugi regionali (${new URL(detailUrl).hostname})`,
      content,
      success: true,
      url: detailUrl,
    };
  }

  return { sourceName: 'Rifugi regionali', content: '', success: false };
}
