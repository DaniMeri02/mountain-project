import { load } from 'cheerio';
import type { AgentInput, SourceResult } from '../types';
import { fetchHtml, truncateAtWord } from './http';

const LISTING_PAGES = [
  'https://rifugi.bergamo.it',  // Bergamo
  'https://rifugi.brescia.it',  // Brescia
  'https://rifugi.lecco.it',    // Lecco
  'https://rifugi.como.it',     // Como + Varese
  'https://rifugi.sondrio.it',  // Sondrio (Valtellina)
] as const;

const LOMBARDIA_HOST = 'rifugi.lombardia.it';

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

  const html = await fetchHtml(listingUrl);
  if (!html) return [];

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
 * Extracts the sidebar boxes (contacts, location info, access routes) from a
 * rifugi.lombardia.it detail page before the sidebar is stripped from the DOM.
 */
function extractSideboxes($: ReturnType<typeof load>): string {
  const parts: string[] = [];

  $('.sidebox').each((_, box) => {
    const title = cleanText($('.boxtitle', box).text());
    const content = $('.boxcontent', box);

    if (title === 'Contatti del rifugio' || title === 'Informazioni utili') {
      // Remove social/print-only links before reading text
      $('.hidden-print, a[href*="facebook"], a[href*="instagram"]', content).remove();
      const text = cleanText(content.text());
      if (text) parts.push(text);
    } else if (title === 'Accesso al rifugio') {
      $('.approach-data', content).each((_, ap) => {
        const text = cleanText($(ap).text());
        // Skip entries with no time or 00:00 — incomplete/invalid routes
        if (text && text.includes('Tempo:') && !text.includes('00:00')) {
          parts.push(`Accesso — ${text}`);
        }
      });
    }
  });

  return parts.join('\n');
}

/**
 * Fetches and scrapes a rifugi.lombardia.it detail page.
 * Returns structured sidebar info (contacts, location, access) combined with
 * the main descriptive text, or null on failure.
 */
async function scrapeDetailPage(url: string): Promise<string | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = load(html);

  // Extract sidebar data BEFORE removing it from the DOM
  const sideboxText = extractSideboxes($);

  $('script, style, nav, header, footer, .menu, .navigation, aside, .sidebar, .widget').remove();

  const mainContent = $(
    'main, article, .content, .entry-content, #content, .page-content, .single-content'
  ).first();
  const rawText = mainContent.length > 0 ? mainContent.text() : $('body').text();
  const mainText = cleanText(rawText);

  const parts: string[] = [];
  if (sideboxText) parts.push(sideboxText);
  if (mainText.length > 150) parts.push(truncateAtWord(mainText, 2_000));

  const combined = parts.join('\n\n');
  return combined.length > 50 ? combined : null;
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
