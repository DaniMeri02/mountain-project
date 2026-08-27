import { writeFile, appendFile, stat } from 'fs/promises';
import { join } from 'path';
import type { Pool } from 'pg';
import { AiDescriptionCache, buildCacheKey } from './cache';
import { loadAgentPrompt } from './prompt-loader';
import { fetchWikidata } from './sources/wikidata';
import { fetchOverpassData } from './sources/overpass';
import { fetchRifugiData } from './sources/rifugi-scraper';
import { fetchFerrate365Data } from './sources/ferrate365-scraper';
import { fetchYouTubeVideos } from './sources/youtube';
import { fetchRedditPosts } from './sources/reddit';
import { fetchKomootData } from './sources/komoot';
import { gatherSources, type NamedSource } from './sources/gather';
import { resolveGooglePlace } from './sources/google-places';
import { GooglePlaceCache } from './google-place-cache';
// TripAdvisor (maxcopell~tripadvisor) charges per-run on top of compute units — disabled
// Facebook (apify~facebook-posts/groups-scraper) — disabled: Apify credits exhausted
import type { AgentInput, AgentResponse, GooglePlaceLink, SourceResult } from './types';

// The sources consulted for every AI guide. The name attributes the result even when the
// fetch throws, so a failed source is reported (not silently dropped) with its identity intact.
const SOURCES: NamedSource[] = [
  { name: 'Wikidata', fetch: fetchWikidata },
  { name: 'OpenStreetMap', fetch: fetchOverpassData },
  { name: 'Rifugi regionali', fetch: fetchRifugiData },
  { name: 'Ferrate365', fetch: fetchFerrate365Data },
  { name: 'YouTube', fetch: fetchYouTubeVideos },
  { name: 'Reddit', fetch: fetchRedditPosts },
  { name: 'Komoot', fetch: fetchKomootData },
];

export interface AiModel {
  slug: string;
  label: string;
  base: string;
  key: string;
}

/**
 * Ranked model list — first entry is used by default, others are tried in order on failure.
 *
 * Every entry was verified against the real agent prompt on 2026-08-26. Providers retire slugs on
 * a rolling basis, so a model that starts returning 404 is not a bug in this file — it means the
 * catalogue moved and the list needs re-checking against each provider's GET /models.
 *
 * Deliberately excluded after testing:
 *   - qwen/qwen3.6-27b (Groq) — emits an untagged planning monologue before the answer, which
 *                               sanitizeAiResponse cannot strip; renders as garbage in the panel.
 *   - groq/compound           — 413 request_too_large: rejects any request carrying our prompt.
 *   - groq/compound-mini      — returns 200 with empty content.
 */
export const AI_MODELS: AiModel[] = [
  {
    slug: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (Google)',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: 'GEMINI_API_KEY',
  },
  {
    slug: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite (Google)',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: 'GEMINI_API_KEY',
  },
  {
    slug: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    base: 'https://api.groq.com/openai/v1',
    key: 'GROQ_API_KEY',
  },
  {
    slug: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B (Groq)',
    base: 'https://api.groq.com/openai/v1',
    key: 'GROQ_API_KEY',
  },
  {
    slug: 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 31B (OpenRouter)',
    base: 'https://openrouter.ai/api/v1',
    key: 'OPENROUTER_API_KEY',
  },
];

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string; code?: number | string };
}

/**
 * Strip reasoning leakage from AI responses.
 * Reasoning models (Qwen3, DeepSeek-R1, etc.) sometimes emit chain-of-thought
 * either inside <think>...</think> tags or as raw prose before the actual answer.
 * Both forms render as visible text when injected via innerHTML on the frontend.
 *
 * Strategy: drop any <think>/<thinking> blocks, then trim everything before the
 * first block-level HTML tag the prompt instructs the model to emit.
 */
export function sanitizeAiResponse(text: string): string {
  let cleaned = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // Strip leading code-fence wrappers some models add around HTML
  cleaned = cleaned.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // Find first expected block-level tag from the prompt schema
  const match = cleaned.search(/<(?:h[1-6]|p|ul|ol|div)\b[^>]*>/i);
  if (match > 0) cleaned = cleaned.slice(match);
  return cleaned.trim();
}

export async function callAiModel(
  model: AiModel,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const apiKey = process.env[model.key];
  if (!apiKey) throw new Error(`API key not set: ${model.key}`);

  const res = await fetch(`${model.base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model.slug,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const data = (await res.json()) as ChatCompletionResponse;

  if (!res.ok) {
    const msg = data.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from model');
  return text;
}

/**
 * Returns true if the error warrants trying the next model in the fallback chain.
 *
 * Nearly every failure is specific to one model or one provider: a retired slug (404), a prompt
 * too large for that model (413), an exhausted key or quota (401/403/429), a provider outage
 * (5xx). None of those say anything about whether the *next* model would succeed.
 *
 * Only a malformed request body is universal — we build an identical body for every model, so a
 * 400/422 would fail the same way for all of them and cascading just wastes time hiding our bug.
 */
export function shouldCascade(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status == null) return true;          // network error / timeout — transient
  return status !== 400 && status !== 422;  // only a malformed body fails identically everywhere
}

const DUMP_FILE = join(__dirname, '..', 'agent-sources-dump.txt');
const DUMP_MAX_BYTES = 1_000_000; // 1 MB cap — truncate before writing to prevent unbounded growth

async function writeSourcesDump(
  userMessage: string,
  results: SourceResult[],
  placeLink?: GooglePlaceLink,
): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;

  const separator = '═'.repeat(60);
  const lines: string[] = [
    separator,
    `AGENT SOURCES DUMP — ${new Date().toISOString()}`,
    separator,
    '',
    '>>> PROMPT SENT TO AI (exactly as the model reads it):',
    '',
    userMessage,
    '',
    separator,
    '>>> SOURCE DETAILS (including failed sources):',
    '',
  ];

  for (const r of results) {
    lines.push(`--- ${r.sourceName.toUpperCase()} | success: ${r.success} ---`);
    if (r.url) lines.push(`URL: ${r.url}`);
    lines.push(r.content.trim() || '(empty)');
    lines.push('');
  }

  // The place lookup is not a source — it never reaches the prompt — but its decision trail is
  // the only way to tell a wrong match from a genuine absence after the fact.
  if (placeLink) {
    lines.push(separator);
    lines.push(`>>> GOOGLE PLACES — status: ${placeLink.status}`);
    if (placeLink.url) lines.push(`URL: ${placeLink.url}`);
    lines.push(...(placeLink.debug ?? ['(no diagnostics)']));
    lines.push('');
  }

  lines.push(separator);
  const content = lines.join('\n');

  try {
    const fileStat = await stat(DUMP_FILE).catch(() => null);
    if (!fileStat || fileStat.size > DUMP_MAX_BYTES) {
      await writeFile(DUMP_FILE, content, 'utf8');
    } else {
      await appendFile(DUMP_FILE, content, 'utf8');
    }
  } catch {
    // Non-critical — dump failure must not affect the response
  }
}

/**
 * The Google Maps section, appended to the finished description.
 *
 * Written here rather than by the model on purpose: models mangle long URLs, and each of the five
 * would do it differently. The text is Italian because it joins the generated description, which
 * stays Italian by design — only the interface is English.
 *
 * `unavailable` renders nothing at all. A missing key, a throttled lookup or a network failure
 * must never appear as "nessun link", which would assert an absence we never verified.
 */
export function renderGoogleMapsBlock(link: GooglePlaceLink): string {
  if (link.status === 'found' && link.url) {
    const href = escapeHtmlAttribute(link.url);
    return `\n<h3>Google Maps</h3>\n<p><a href="${href}" target="_blank" rel="noopener noreferrer">Apri la scheda su Google Maps</a></p>`;
  }
  if (link.status === 'not_found') {
    return '\n<h3>Google Maps</h3>\n<p>Nessun link Google Maps disponibile.</p>';
  }
  return '';
}

/** The URL is ours, not user input, but it lands in an HTML attribute — escape it regardless. */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildUserMessage(input: AgentInput, results: SourceResult[]): string {
  const header = [
    `Nome: ${input.name}`,
    `Tipo: ${input.type}`,
    input.elevation != null ? `Altitudine: ${input.elevation}m s.l.m.` : null,
    input.lat != null && input.lng != null
      ? `Coordinate: ${Number(input.lat).toFixed(5)}N, ${Number(input.lng).toFixed(5)}E`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const sourceSections = results
    .filter((r) => r.success && r.content.length > 0)
    .map((r) => `\n=== ${r.sourceName.toUpperCase()} ===\n${r.content}`)
    .join('\n');

  const dataBlock = sourceSections.trim()
    ? `\n\n--- DATI RACCOLTI ---${sourceSections}`
    : '\n\n(Nessun dato aggiuntivo disponibile da fonti esterne.)';

  return `${header}${dataBlock}\n\nGenera ora la descrizione completa seguendo le istruzioni.`;
}

export class AgentOrchestrator {
  private readonly cache: AiDescriptionCache;
  private readonly placeCache: GooglePlaceCache;

  constructor(pool: Pool) {
    this.cache = new AiDescriptionCache(pool);
    this.placeCache = new GooglePlaceCache(pool);
  }

  async generate(
    input: AgentInput,
    forceRegenerate = false,
    preferredModelSlug?: string,
  ): Promise<AgentResponse> {
    const cacheKey = buildCacheKey(input);

    if (!forceRegenerate) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return {
          description: cached.description,
          fromCache: true,
          sources: cached.sources,
          generatedAt: cached.generatedAt.toISOString(),
          expiresAt: cached.expiresAt.toISOString(),
        };
      }
    }

    // Runs alongside the sources so it adds no latency, but is awaited separately and kept out of
    // buildUserMessage: the model must never see the URL, or it will try to reproduce it.
    const placeLinkPromise = resolveGooglePlace(input, this.placeCache, cacheKey);

    const results: SourceResult[] = await gatherSources(SOURCES, input, (name, err) =>
      console.error(`[${name}] source failed`, err),
    );

    const successfulSources = results.filter((r) => r.success).map((r) => r.sourceName);

    const systemPrompt = loadAgentPrompt();
    const userMessage = buildUserMessage(input, results);
    const placeLink = await placeLinkPromise;
    void writeSourcesDump(userMessage, results, placeLink);

    // Move preferred model to front while preserving ranked fallback order
    const orderedModels = [...AI_MODELS];
    if (preferredModelSlug) {
      const prefIdx = orderedModels.findIndex((m) => m.slug === preferredModelSlug);
      if (prefIdx > 0) {
        const [preferred] = orderedModels.splice(prefIdx, 1);
        orderedModels.unshift(preferred);
      }
    }

    let description: string | undefined;
    let modelUsed: string | undefined;
    // Every attempt is recorded. Previously only the last error survived, so an early model's real
    // problem (an exhausted key, say) stayed invisible behind a later model's unrelated noise.
    const failures: string[] = [];

    for (const model of orderedModels) {
      try {
        const raw = await callAiModel(model, systemPrompt, userMessage);
        description = sanitizeAiResponse(raw);
        modelUsed = model.label;
        break;
      } catch (err: unknown) {
        const status = (err as { status?: number }).status ?? 'no status';
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${model.slug} (${status}): ${message}`);
        console.error(`[ai] ${model.slug} failed — ${status}: ${message}`);
        if (!shouldCascade(err)) throw err;
      }
    }

    if (!description || !modelUsed) {
      throw new Error(`All ${orderedModels.length} AI models failed:\n${failures.join('\n')}`);
    }

    description += renderGoogleMapsBlock(placeLink);

    const expiresAt = await this.cache.set(cacheKey, input.name, input.type, description, successfulSources);

    return {
      description,
      fromCache: false,
      sources: successfulSources,
      generatedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      modelUsed,
    };
  }
}
