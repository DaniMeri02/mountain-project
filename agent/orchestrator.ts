import { GoogleGenerativeAI } from '@google/generative-ai';
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
import { fetchFacebookPosts } from './sources/facebook';
// TripAdvisor (maxcopell~tripadvisor) charges per-run on top of compute units — disabled
// Komoot (logiover~komoot-hiking-outdoor-routes-scraper) requires a paid plan (HTTP 402) — disabled
// Facebook (apify~facebook-posts/groups-scraper) — disabled: Apify credits exhausted
import type { AgentInput, AgentResponse, SourceResult } from './types';

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const DUMP_FILE = join(__dirname, '..', 'agent-sources-dump.txt');

function writeSourcesDump(userMessage: string, results: SourceResult[]): void {
  const separator = '═'.repeat(60);
  const lines: string[] = [
    separator,
    `AGENT SOURCES DUMP — ${new Date().toISOString()}`,
    separator,
    '',
    '>>> PROMPT SENT TO GEMINI (exactly as Gemini reads it):',
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

/**
 * Builds the user-turn prompt that Gemini receives.
 * The system prompt (instructions) is passed separately via systemInstruction.
 */
function buildUserMessage(input: AgentInput, results: SourceResult[]): string {
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
  private readonly gemini: GoogleGenerativeAI;

  constructor(pool: Pool) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.');
    }

    this.cache = new AiDescriptionCache(pool);
    this.gemini = new GoogleGenerativeAI(apiKey);
  }

  async generate(input: AgentInput, forceRegenerate = false): Promise<AgentResponse> {
    const cacheKey = buildCacheKey(input);

    // Return cached result unless explicitly bypassed
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

    // Fetch all sources in parallel; each source handles its own errors gracefully
    const settled = await Promise.allSettled([
      fetchWikidata(input),
      fetchOverpassData(input),
      fetchRifugiData(input),
      fetchFerrate365Data(input),
      fetchYouTubeVideos(input),
      fetchRedditPosts(input),
      // fetchFacebookPosts(input),  // disabled: Apify credits exhausted
    ]);

    const results: SourceResult[] = settled.map((outcome) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : { sourceName: 'unknown', content: '', success: false }
    );

    const successfulSources = results
      .filter((r) => r.success)
      .map((r) => r.sourceName);

    // Load the editable system prompt from disk (cached in memory after first read)
    const systemPrompt = loadAgentPrompt();
    const userMessage = buildUserMessage(input, results);

    // Dump all raw source data to file for inspection before Gemini processes it
    writeSourcesDump(userMessage, results);

    // Try each model in order; fall back to the next on 503 (transient overload)
    let geminiResult;
    let lastError: unknown;
    for (const modelName of GEMINI_MODELS) {
      const model = this.gemini.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      });
      try {
        geminiResult = await model.generateContent(userMessage);
        break;
      } catch (err: unknown) {
        lastError = err;
        const is503 = err instanceof Error && (err as { status?: number }).status === 503;
        if (!is503) throw err;
        // 503 on this model — wait briefly then try the next one
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (!geminiResult) throw lastError;
    const description = geminiResult.response.text();

    // Store in cache (upsert — handles both first-time and forced regeneration)
    await this.cache.set(cacheKey, input.name, input.type, description, successfulSources);

    // Re-read the expiry from DB for an accurate timestamp in the response
    const stored = await this.cache.get(cacheKey);
    const expiresAt = stored?.expiresAt ?? new Date(Date.now() + 48 * 60 * 60 * 1_000);

    return {
      description,
      fromCache: false,
      sources: successfulSources,
      generatedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }
}
