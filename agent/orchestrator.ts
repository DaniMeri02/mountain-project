import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Pool } from 'pg';
import { AiDescriptionCache, buildCacheKey } from './cache';
import { loadAgentPrompt } from './prompt-loader';
import { fetchWikidata } from './sources/wikidata';
import { fetchOverpassData } from './sources/overpass';
import { fetchRifugiData } from './sources/rifugi-scraper';
import { fetchFerrate365Data } from './sources/ferrate365-scraper';
import { fetchYouTubeVideos } from './sources/youtube';
import { fetchRedditPosts } from './sources/reddit';
import type { AgentInput, AgentResponse, SourceResult } from './types';

const GEMINI_MODEL = 'gemini-1.5-flash';

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

    const model = this.gemini.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: systemPrompt,
    });

    const geminiResult = await model.generateContent(userMessage);
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
