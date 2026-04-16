import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  AgentInput,
  SourceResult,
  ApifyFacebookPost,
  FacebookSourcesConfig,
} from '../types';
import { runApifyActor } from './apify';

const CONFIG_PATH = join(__dirname, '..', '..', 'ai-agent-conf', 'facebook-sources.json');
const PAGES_ACTOR  = 'apify~facebook-posts-scraper';
const GROUPS_ACTOR = 'apify~facebook-groups-scraper';

// Process-level cache: config is read once per server start
let configCache: FacebookSourcesConfig | null = null;

function loadConfig(): FacebookSourcesConfig {
  if (configCache) return configCache;
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  configCache = JSON.parse(raw) as FacebookSourcesConfig;
  return configCache;
}

// ─── matchesPoi helpers ───────────────────────────────────────────────────────

const TYPE_PREFIXES: Readonly<Partial<Record<string, readonly string[]>>> = {
  hut:     ['rifugio', 'rif'],
  bivouac: ['bivacco', 'biv'],
  peak:    ['monte', 'm'],
  ferrata: ['via', 'ferrata'],
};

const STOPWORDS = new Set([
  'del', 'della', 'dei', 'degli', 'di', 'd',
  'il', 'lo', 'la', 'i', 'gli', 'le',
  'al', 'allo', 'alla', 'agli', 'alle', 'all',
  'sul', 'sulla', 'sui', 'sugli', 'sulle',
  'nel', 'nella', 'nei', 'negli', 'nelle', 'nell',
  'un', 'una', 'dal', 'dall', 'da',
]);

const TYPE_SIGNALS: Readonly<Partial<Record<string, readonly string[]>>> = {
  hut:     ['rifugio', 'rif.', 'capanna', 'baita'],
  bivouac: ['bivacco', 'biv.'],
  peak:    ['monte', 'pizzo', 'cima', 'punta', 'vetta', 'corno'],
  ferrata: ['ferrata', 'scalata', 'arrampicata'],
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractCoreTokens(name: string, type: string): string[] {
  const prefixes = new Set(TYPE_PREFIXES[type] ?? []);
  const tokens = normalize(name)
    .split(/[\s,.''\u2018\u2019\-\u2013\u2014]+/)
    .filter((t) => t.length > 0);

  let start = 0;
  while (start < tokens.length && prefixes.has(tokens[start])) {
    start++;
  }

  return tokens
    .slice(start)
    .filter((t) => !STOPWORDS.has(t) && t.length >= 2);
}

function tokenPresent(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

function hasTypeSignal(message: string, type: string): boolean {
  const signals = TYPE_SIGNALS[type];
  return signals?.some((s) => tokenPresent(message, s)) ?? false;
}

/**
 * Three-tier relevance filter:
 *   Tier 1 — full name verbatim
 *   Tier 2 — all core tokens present as whole words
 *   Tier 3 — short single-token names (≤5 chars) also need a type signal
 */
function matchesPoi(text: string, input: AgentInput): boolean {
  const msg = normalize(text);
  const name = normalize(input.name);

  if (msg.includes(name)) return true;

  const coreTokens = extractCoreTokens(input.name, input.type);
  if (coreTokens.length === 0) return false;
  if (!coreTokens.every((token) => tokenPresent(msg, token))) return false;

  const isAmbiguous = coreTokens.length === 1 && coreTokens[0].length <= 5;
  return isAmbiguous ? hasTypeSignal(msg, input.type) : true;
}

// ─── Main source function ─────────────────────────────────────────────────────

export async function fetchFacebookPosts(input: AgentInput): Promise<SourceResult> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { sourceName: 'Facebook', content: '', success: false };

  const { page_ids, group_ids } = loadConfig();
  if (page_ids.length === 0 && group_ids.length === 0) {
    return { sourceName: 'Facebook', content: '', success: false };
  }

  // Run pages and groups actors in parallel — skip whichever list is empty
  const tasks: Promise<ApifyFacebookPost[]>[] = [];

  if (page_ids.length > 0) {
    tasks.push(
      runApifyActor<ApifyFacebookPost>(
        PAGES_ACTOR,
        { startUrls: page_ids.map((id) => ({ url: `https://www.facebook.com/${id}` })), resultsLimit: 25 },
        token
      ).catch(() => [])
    );
  }

  if (group_ids.length > 0) {
    tasks.push(
      runApifyActor<ApifyFacebookPost>(
        GROUPS_ACTOR,
        { groupUrls: group_ids.map((id) => `https://www.facebook.com/groups/${id}`), postsLimit: 25 },
        token
      ).catch(() => [])
    );
  }

  const results = await Promise.all(tasks);
  const allPosts = results.flat();

  const matched = allPosts.filter((p) => p.text && matchesPoi(p.text, input));
  if (matched.length === 0) return { sourceName: 'Facebook', content: '', success: false };

  // Newest-first, top 5
  matched.sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : 0;
    const tb = b.time ? new Date(b.time).getTime() : 0;
    return tb - ta;
  });
  const top5 = matched.slice(0, 5);

  const content = top5
    .map((post) => {
      const date = post.time ? new Date(post.time).toISOString().slice(0, 7) : '??';
      const snippet = post.text!.slice(0, 300).replace(/\n+/g, ' ');
      return `• "${snippet}" (${date})\n  ${post.url ?? ''}`;
    })
    .join('\n\n');

  return { sourceName: 'Facebook', content, success: true };
}
