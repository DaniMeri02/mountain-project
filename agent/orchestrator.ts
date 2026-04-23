import { writeFileSync } from 'fs';
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
// TripAdvisor (maxcopell~tripadvisor) charges per-run on top of compute units — disabled
// Facebook (apify~facebook-posts/groups-scraper) — disabled: Apify credits exhausted
import type { AgentInput, AgentResponse, SourceResult } from './types';

export interface AiModel {
  slug: string;
  label: string;
  base: string;
  key: string;
}

/** Ranked model list — first entry is used by default, others are tried in order on failure. */
export const AI_MODELS: AiModel[] = [
  {
    slug: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (Google)',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: 'GEMINI_API_KEY',
  },
  {
    slug: 'qwen/qwen3-32b',
    label: 'Qwen3 32B (Groq)',
    base: 'https://api.groq.com/openai/v1',
    key: 'GROQ_API_KEY',
  },
  {
    slug: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B (Groq)',
    base: 'https://api.groq.com/openai/v1',
    key: 'GROQ_API_KEY',
  },
  {
    slug: 'meta-llama/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout 17B (Groq)',
    base: 'https://api.groq.com/openai/v1',
    key: 'GROQ_API_KEY',
  },
  {
    slug: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    base: 'https://api.groq.com/openai/v1',
    key: 'GROQ_API_KEY',
  },
  {
    slug: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite (Google)',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: 'GEMINI_API_KEY',
  },
  {
    slug: 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 31B (OpenRouter)',
    base: 'https://openrouter.ai/api/v1',
    key: 'OPENROUTER_API_KEY',
  },
  {
    slug: 'meta-llama/llama-3.3-70b-instruct:free',
    label: 'Llama 3.3 70B (OpenRouter)',
    base: 'https://openrouter.ai/api/v1',
    key: 'OPENROUTER_API_KEY',
  },
];

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string; code?: number | string };
}

async function callAiModel(
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
 * Returns false for errors that indicate a client-side mistake (bad key, malformed request, etc.)
 */
function shouldCascade(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status == null) return true;  // network error / timeout — transient
  if (status === 429) return true;  // rate-limited — next model may have quota
  if (status >= 500) return true;   // server overloaded — transient
  return false;                     // 4xx client errors — bad key or request bug, fail fast
}

const DUMP_FILE = join(__dirname, '..', 'agent-sources-dump.txt');

function writeSourcesDump(userMessage: string, results: SourceResult[]): void {
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

  lines.push(separator);
  writeFileSync(DUMP_FILE, lines.join('\n'), 'utf8');
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

  constructor(pool: Pool) {
    this.cache = new AiDescriptionCache(pool);
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

    const settled = await Promise.allSettled([
      fetchWikidata(input),
      fetchOverpassData(input),
      fetchRifugiData(input),
      fetchFerrate365Data(input),
      fetchYouTubeVideos(input),
      fetchRedditPosts(input),
      fetchKomootData(input),
      // fetchFacebookPosts(input),  // disabled: Apify credits exhausted
    ]);

    const results: SourceResult[] = settled.map((outcome) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : { sourceName: 'unknown', content: '', success: false },
    );

    const successfulSources = results.filter((r) => r.success).map((r) => r.sourceName);

    const systemPrompt = loadAgentPrompt();
    const userMessage = buildUserMessage(input, results);
    writeSourcesDump(userMessage, results);

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
    let lastError: unknown;

    for (const model of orderedModels) {
      try {
        description = await callAiModel(model, systemPrompt, userMessage);
        modelUsed = model.label;
        break;
      } catch (err: unknown) {
        lastError = err;
        if (!shouldCascade(err)) throw err;
      }
    }

    if (!description || !modelUsed) throw lastError;

    await this.cache.set(cacheKey, input.name, input.type, description, successfulSources);
    const stored = await this.cache.get(cacheKey);
    const expiresAt = stored?.expiresAt ?? new Date(Date.now() + 48 * 60 * 60 * 1_000);

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
