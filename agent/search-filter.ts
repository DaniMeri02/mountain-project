import { readFileSync } from 'fs';
import { join } from 'path';
import { AI_MODELS, callAiModel, shouldCascade } from './orchestrator';
import type {
  AreaKind,
  DifficultyFilter,
  ElevationRange,
  SearchArea,
  SearchableType,
  SearchFilter,
  SortKey,
} from './types';

// ─── Editable prompt (mirrors prompt-loader.ts) ─────────────────────────────

const PROMPT_PATH = join(process.cwd(), 'ai-agent-conf', 'search-filter-prompt.md');
let cachedPrompt: string | null = null;

export function loadSearchFilterPrompt(): string {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = readFileSync(PROMPT_PATH, 'utf-8');
  return cachedPrompt;
}

export function reloadSearchFilterPrompt(): void {
  cachedPrompt = null;
}

// ─── Allowed vocabularies ───────────────────────────────────────────────────

const SEARCHABLE_TYPES: ReadonlySet<SearchableType> = new Set(['peak', 'hut', 'bivouac', 'ferrata']);
const SORT_KEYS: ReadonlySet<SortKey> = new Set(['elevation_desc', 'elevation_asc', 'name']);
const AREA_KINDS: ReadonlySet<AreaKind> = new Set(['province', 'region', 'viewport', 'bbox']);
const SAC_SCALES: ReadonlySet<string> = new Set([
  'hiking',
  'mountain_hiking',
  'demanding_mountain_hiking',
  'alpine_hiking',
  'demanding_alpine_hiking',
  'difficult_alpine_hiking',
]);
const NUMERIC_GRADE_TO_LETTER: Record<string, string> = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E', '6': 'F' };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const MAX_TEXT = 100;

// ─── Helpers ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function finiteOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

/** Normalize a via ferrata grade to a letter A–F, accepting both 'A'..'F' and '1'..'6'. */
function normalizeGrade(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toUpperCase();
  if (/^[A-F]$/.test(t)) return t;
  return NUMERIC_GRADE_TO_LETTER[t] ?? null;
}

// ─── Validator: untrusted JSON → safe SearchFilter ──────────────────────────
// Pure & structural. Drops anything unknown rather than trusting the model.

export function validateFilter(raw: unknown): SearchFilter {
  const obj = asRecord(raw);

  const types = Array.isArray(obj.types)
    ? [...new Set(obj.types.filter((t): t is SearchableType => typeof t === 'string' && SEARCHABLE_TYPES.has(t as SearchableType)))]
    : [];

  let elevation: ElevationRange | null = null;
  const elev = asRecord(obj.elevation);
  // Elevations are positive metres. Treat 0/negative bounds as "absent" — models often
  // emit max:0 as a "no upper bound" sentinel — and drop a max that sits below the min.
  let elevMin = finiteOrNull(elev.min);
  let elevMax = finiteOrNull(elev.max);
  if (elevMin != null && elevMin <= 0) elevMin = null;
  if (elevMax != null && elevMax <= 0) elevMax = null;
  if (elevMin != null && elevMax != null && elevMin > elevMax) elevMax = null;
  if (elevMin != null || elevMax != null) elevation = { min: elevMin, max: elevMax };

  let area: SearchArea | null = null;
  const rawArea = asRecord(obj.area);
  if (typeof rawArea.kind === 'string' && AREA_KINDS.has(rawArea.kind as AreaKind)) {
    const kind = rawArea.kind as AreaKind;
    const name = trimmedOrNull(rawArea.name);
    const bbox = Array.isArray(rawArea.bbox) && rawArea.bbox.length === 4 && rawArea.bbox.every((n) => Number.isFinite(Number(n)))
      ? (rawArea.bbox.map(Number) as [number, number, number, number])
      : null;
    if (kind === 'province' || kind === 'region') {
      if (name) area = { kind, name };
    } else {
      // viewport/bbox — bbox may be null here; the route fills viewport from the request.
      area = { kind, bbox };
    }
  }

  let difficulty: DifficultyFilter | null = null;
  const rawDiff = asRecord(obj.difficulty);
  const vf = asRecord(rawDiff.viaFerrataScale);
  const vfMin = normalizeGrade(vf.min);
  const vfMax = normalizeGrade(vf.max);
  const sacScale = Array.isArray(rawDiff.sacScale)
    ? rawDiff.sacScale.filter((s): s is string => typeof s === 'string' && SAC_SCALES.has(s))
    : [];
  if (vfMin || vfMax || sacScale.length > 0) {
    difficulty = {
      viaFerrataScale: vfMin || vfMax ? { min: vfMin, max: vfMax } : null,
      sacScale: sacScale.length > 0 ? sacScale : null,
    };
  }

  const sort: SortKey = typeof obj.sort === 'string' && SORT_KEYS.has(obj.sort as SortKey) ? (obj.sort as SortKey) : 'elevation_desc';

  const rawLimit = finiteOrNull(obj.limit);
  const limit = rawLimit == null ? DEFAULT_LIMIT : Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT);
  const rawOffset = finiteOrNull(obj.offset);
  const offset = rawOffset == null ? 0 : Math.max(Math.trunc(rawOffset), 0);

  return {
    types,
    elevation,
    area,
    difficulty,
    nameContains: trimmedOrNull(obj.nameContains),
    sort,
    limit,
    offset,
  };
}

// ─── JSON extraction (models may wrap JSON in prose or ``` fences) ──────────

export class FilterParseError extends Error {}

export function parseFilterJson(raw: string): unknown {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new FilterParseError('No JSON object found in model response');
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new FilterParseError(`Invalid JSON from model: ${(err as Error).message}`);
  }
}

// ─── Translation cache (in-process, like sources/komoot + apify) ────────────

interface CacheEntry {
  filter: SearchFilter;
  modelUsed?: string;
  expires: number;
}

const TRANSLATION_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const translationCache = new Map<string, CacheEntry>();

export function clearTranslationCache(): void {
  translationCache.clear();
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

export interface Translation {
  filter: SearchFilter;
  modelUsed?: string;
  fromCache: boolean;
}

/**
 * Translate a natural-language query into a validated SearchFilter via the AI
 * cascade. Defensive at every step: any model whose output can't be parsed is
 * skipped (cascades to the next); a hard client error (bad key) fails fast.
 * Throws when no model produces a usable filter — the route maps that to 422.
 */
export async function translateQuery(q: string): Promise<Translation> {
  const key = normalizeQuery(q);
  const hit = translationCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return { filter: structuredClone(hit.filter), modelUsed: hit.modelUsed, fromCache: true };
  }

  const prompt = loadSearchFilterPrompt();
  let lastError: unknown;

  for (const model of AI_MODELS) {
    try {
      const raw = await callAiModel(model, prompt, q);
      const filter = validateFilter(parseFilterJson(raw));
      translationCache.set(key, { filter, modelUsed: model.label, expires: Date.now() + TRANSLATION_TTL_MS });
      return { filter: structuredClone(filter), modelUsed: model.label, fromCache: false };
    } catch (err) {
      lastError = err;
      if (!shouldCascade(err)) throw err;
    }
  }

  throw lastError ?? new Error('No AI model could translate the query');
}
