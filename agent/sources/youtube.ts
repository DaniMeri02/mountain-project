import type { AgentInput, SourceResult, YouTubeSearchResponse } from '../types';

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const MAX_RESULTS = 5;

function buildSearchQuery(input: AgentInput): string {
  if (input.type === 'ferrata') {
    return `${input.name} via ferrata`;
  }
  if (input.type === 'hut' || input.type === 'bivouac') {
    return `${input.name} rifugio montagna`;
  }
  return `${input.name} montagna escursione`;
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

    if (!response.ok) {
      return { sourceName: 'YouTube', content: '', success: false };
    }

    const data = (await response.json()) as YouTubeSearchResponse;

    if (data.error) {
      return { sourceName: 'YouTube', content: '', success: false };
    }

    const items = data.items ?? [];
    if (items.length === 0) {
      return { sourceName: 'YouTube', content: '', success: false };
    }

    const formatted = items
      .map((item) => {
        const s = item.snippet;
        const month = s.publishedAt.substring(0, 7);
        const desc = s.description.substring(0, 200).replace(/\n/g, ' ');
        return `• "${s.title}" — ${s.channelTitle} (${month})\n  ${desc}`;
      })
      .join('\n\n');

    return { sourceName: 'YouTube', content: formatted, success: true };
  } catch {
    return { sourceName: 'YouTube', content: '', success: false };
  }
}
