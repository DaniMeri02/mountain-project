import type { AgentInput, SourceResult, YouTubeSearchResponse, YouTubeVideoResponse } from '../types';

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const MAX_RESULTS = 5;

function buildSearchQuery(input: AgentInput): string {
  if (input.type === 'ferrata') {
    return `${input.name} via ferrata`;
  }
  if (input.type === 'hut' || input.type === 'bivouac') {
    return `${input.name} rifugio montagna`;
  }
  // Peaks: dropping "montagna" reduces over-filtering — the name alone is specific enough
  return `${input.name} escursione`;
}

/**
 * Fetches full snippets (including complete descriptions) for up to 2 video IDs
 * using the videos endpoint, which returns the full description unlike the search endpoint.
 */
async function fetchFullSnippets(
  ids: string[],
  apiKey: string,
): Promise<Map<string, string>> {
  const url = new URL(VIDEOS_URL);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return new Map();
    const data = (await res.json()) as YouTubeVideoResponse;
    const map = new Map<string, string>();
    for (const item of data.items ?? []) {
      map.set(item.id, item.snippet.description);
    }
    return map;
  } catch {
    return new Map();
  }
}

// Section headers that mark logistical content (parking/driving) — not useful for a trail guide
const SKIP_HEADER = /^(ACCESSO|PARCHEGGIO|COME ARRIVARE|DOVE PARCHEGGIARE)\s*:/i;
// Inline keywords that identify a parking-logistics paragraph even without a header
const SKIP_KEYWORDS = /gratta\s+e\s+sosta|autostrada\s+uscita|navigatore\s+gps/i;

function filterDescription(raw: string): string {
  const paragraphs = raw.split(/\n{2,}/);
  const useful = paragraphs.filter((p) => {
    const trimmed = p.trim();
    return !SKIP_HEADER.test(trimmed) && !SKIP_KEYWORDS.test(trimmed);
  });
  return useful.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1_200);
}

export async function fetchYouTubeVideos(input: AgentInput): Promise<SourceResult> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { sourceName: 'YouTube', content: '', success: false };
  }

  const query = buildSearchQuery(input);
  const url = new URL(SEARCH_URL);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  url.searchParams.set('relevanceLanguage', 'it');
  url.searchParams.set('key', apiKey);

  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });

    // Always parse JSON — YouTube returns error details in JSON even on non-2xx
    const data = (await response.json()) as YouTubeSearchResponse;

    if (!response.ok || data.error) {
      const errMsg = data.error?.message ?? `HTTP ${response.status}`;
      return { sourceName: 'YouTube', content: `API error: ${errMsg}`, success: false };
    }

    const items = data.items ?? [];
    if (items.length === 0) {
      return { sourceName: 'YouTube', content: `No results for query: "${query}"`, success: false };
    }

    // Extract video IDs from the top 2 results and fetch their full descriptions
    const topIds = items
      .slice(0, 2)
      .map((item) => item.id?.videoId)
      .filter((id): id is string => id != null);

    const fullDescriptions = topIds.length > 0
      ? await fetchFullSnippets(topIds, apiKey)
      : new Map<string, string>();

    const formatted = items
      .map((item) => {
        const s = item.snippet;
        const videoId = item.id?.videoId;
        const month = s.publishedAt.substring(0, 7);

        // Use full description if we fetched it, fall back to search snippet
        const rawDesc = (videoId != null && fullDescriptions.has(videoId))
          ? fullDescriptions.get(videoId)!
          : s.description;

        const desc = filterDescription(rawDesc).replace(/\n/g, ' ');
        return `• "${s.title}" — ${s.channelTitle} (${month})\n  ${desc}`;
      })
      .join('\n\n');

    return { sourceName: 'YouTube', content: formatted, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sourceName: 'YouTube', content: `Error: ${msg}`, success: false };
  }
}
