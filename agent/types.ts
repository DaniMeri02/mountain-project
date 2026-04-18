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
  id?: { videoId?: string };
  snippet: YouTubeSnippet;
}

export interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
  error?: { message: string; code: number };
}

export interface YouTubeVideoItem {
  id: string;
  snippet: YouTubeSnippet;
}

export interface YouTubeVideoResponse {
  items?: YouTubeVideoItem[];
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

// ─── Komoot native API (api.komoot.de/v007) ──────────────────────────────────
// No authentication required for public highlight, tour and tip data.

/** A highlight returned by GET /highlights/?center=lat,lng&max_distance=N */
export interface KomootHighlight {
  id: number;
  base_name?: string;          // original name, e.g. "Rifugio Capanna 2000"
  name?: string;               // localized display name, e.g. "Capanna 2000 Hut"
  category?: string;           // primary category: "hut" | "mountain" | "viewpoint" | ...
  categories?: string[];
  sport?: string;
  start_point?: { lat: number; lng: number; alt: number };
  score?: number;
  intro?: string;              // HTML description paragraph (present for huts, absent for bare peaks)
  _links?: {
    discover_tours?: { href: string };
    tips?: { href: string };
  };
}

/** A tour returned by GET /discover_tours/for_highlight/{id}/ */
export interface KomootTour {
  id?: string;
  name?: string;
  sport?: string;
  distance?: number;           // metres
  elevation_up?: number;       // metres of ascent
  difficulty?: {
    grade?: string;            // "easy" | "moderate" | "difficult" | "expert"
    explanation_technical?: string;
    explanation_fitness?: string;
  };
  duration?: number;           // seconds
  _embedded?: {
    tour_description?: {
      text?: string;
      short_description?: string;
    };
  };
}

/** A user tip returned by GET /highlights/{id}/tips/ */
export interface KomootTip {
  text?: string;
  sport?: string;
  votes?: { up?: number; down?: number };
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
