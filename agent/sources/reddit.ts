import type {
  AgentInput,
  RedditTokenResponse,
  RedditSearchResponse,
  SourceResult,
} from '../types';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const SEARCH_URL = 'https://oauth.reddit.com/search';
const USER_AGENT = 'MountainPortal/1.0 (personal project)';

async function fetchAccessToken(clientId: string, clientSecret: string): Promise<string | null> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as RedditTokenResponse;
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

function buildSearchQuery(input: AgentInput): string {
  const suffix = input.type === 'ferrata' ? 'via ferrata' : 'montagna escursione';
  return `${input.name} ${suffix}`;
}

export async function fetchRedditPosts(input: AgentInput): Promise<SourceResult> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { sourceName: 'Reddit', content: '', success: false };
  }

  const token = await fetchAccessToken(clientId, clientSecret);
  if (!token) {
    return { sourceName: 'Reddit', content: '', success: false };
  }

  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', buildSearchQuery(input));
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('limit', '5');
  url.searchParams.set('type', 'link');

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { sourceName: 'Reddit', content: '', success: false };
    }

    const data = (await response.json()) as RedditSearchResponse;
    const posts = data.data?.children ?? [];

    if (posts.length === 0) {
      return { sourceName: 'Reddit', content: '', success: false };
    }

    const formatted = posts
      .map((post) => {
        const d = post.data;
        const text = d.selftext.trim().substring(0, 300).replace(/\n/g, ' ');
        const date = new Date(d.created_utc * 1000).toISOString().substring(0, 7);
        return `• "${d.title}" (r/${d.subreddit}, score: ${d.score}, ${date})${text ? `\n  ${text}` : ''}`;
      })
      .join('\n\n');

    if (!formatted.trim()) {
      return { sourceName: 'Reddit', content: '', success: false };
    }

    return { sourceName: 'Reddit', content: formatted, success: true };
  } catch {
    return { sourceName: 'Reddit', content: '', success: false };
  }
}
