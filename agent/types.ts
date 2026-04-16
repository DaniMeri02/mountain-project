// ─── POI input ───────────────────────────────────────────────────────────────

export type PoiType = 'peak' | 'hut' | 'bivouac' | 'ferrata' | string;

export interface AgentInput {
  name: string;
  type: PoiType;
  elevation?: number | string | null;
  osm_id?: string | number | null;
  lat?: number | null;
  lng?: number | null;
}

// ─── Source results ───────────────────────────────────────────────────────────

export interface SourceResult {
  sourceName: string;
  content: string;
  success: boolean;
  url?: string;  // URL where the content was found, for the sources dump
}

// ─── Cache ────────────────────────────────────────────────────────────────────

export interface CachedDescription {
  description: string;
  sources: string[];
  generatedAt: Date;
  expiresAt: Date;
}

/** Shape of a row returned by PostgreSQL for the cache table */
export interface CacheRow {
  description: string;
  sources: string[];   // pg parses JSONB automatically
  generated_at: Date;
  expires_at: Date;
}

// ─── API response ─────────────────────────────────────────────────────────────

export interface AgentResponse {
  description: string;
  fromCache: boolean;
  sources: string[];
  generatedAt: string;   // ISO-8601
  expiresAt: string;     // ISO-8601
}

// ─── Wikidata SPARQL ──────────────────────────────────────────────────────────

export interface WikidataBinding {
  value: string;
  type: string;
}

export interface WikidataRow {
  item?: WikidataBinding;
  itemLabel?: WikidataBinding;
  description?: WikidataBinding;
  elevation?: WikidataBinding;
  wikipedia?: WikidataBinding;
  website?: WikidataBinding;
  inception?: WikidataBinding;
}

export interface WikidataSparqlResponse {
  results: {
    bindings: WikidataRow[];
  };
}

// ─── Overpass API ─────────────────────────────────────────────────────────────

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

// ─── YouTube Data API v3 ─────────────────────────────────────────────────────

export interface YouTubeSnippet {
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
}

export interface YouTubeSearchItem {
  snippet: YouTubeSnippet;
}

export interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
  error?: { message: string; code: number };
}

// ─── Facebook via Apify ───────────────────────────────────────────────────────

/** Single post returned by the Apify facebook-posts-scraper actor. */
export interface ApifyFacebookPost {
  postId?: string;
  pageName?: string;
  url?: string;
  time?: string;         // ISO date string e.g. "2026-04-16T10:52:19.000Z"
  text?: string;
  user?: { id: string; name: string };
  inputUrl?: string;
}

/** Shape of ai-agent-conf/facebook-sources.json */
export interface FacebookSourcesConfig {
  page_ids: string[];    // Facebook page usernames (the part after facebook.com/)
  group_ids: string[];   // Public group IDs/names (the part after facebook.com/groups/)
}

// ─── TripAdvisor via Apify ────────────────────────────────────────────────────

/** Single place returned by the maxcopell/tripadvisor Apify actor. */
export interface TripAdvisorPlace {
  name?: string;
  locationString?: string;     // e.g. "Bergamo, Province of Bergamo, Italy"
  description?: string;
  rating?: number;             // 0–5
  numberOfReviews?: number;
  url?: string;
  latitude?: number;
  longitude?: number;
}

// ─── Komoot via Apify ─────────────────────────────────────────────────────────

/** Single route returned by the logiover/komoot-hiking-outdoor-routes-scraper actor. */
export interface KomootRoute {
  name?: string;
  description?: string;        // may contain HTML tags
  distance?: number;           // metres
  elevation_up?: number;       // metres of ascent
  difficulty?: string;         // e.g. "easy", "moderate", "difficult"
  sport?: string;              // e.g. "hike", "climbing"
  url?: string;
}

// ─── Reddit API ───────────────────────────────────────────────────────────────

export interface RedditTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface RedditPostData {
  title: string;
  subreddit: string;
  score: number;
  selftext: string;
  url: string;
  created_utc: number;
}

export interface RedditPost {
  kind: string;
  data: RedditPostData;
}

export interface RedditSearchResponse {
  data: {
    children: RedditPost[];
  };
}
