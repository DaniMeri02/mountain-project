import { AI_MODELS } from './orchestrator';

const VALID_MODEL_SLUGS = new Set(AI_MODELS.map((m) => m.slug));

export type ModelSlugResolution =
  | { ok: true; slug: string | undefined }
  | { ok: false; validSlugs: string[] };

/**
 * Validate a caller-supplied model slug. Pure — returns a result; the route decides how to
 * respond. A missing slug resolves to `undefined` (use the default cascade); an unknown slug
 * is rejected with the list of valid slugs.
 */
export function resolveModelSlug(modelSlug: string | null | undefined): ModelSlugResolution {
  if (modelSlug == null) return { ok: true, slug: undefined };
  if (!VALID_MODEL_SLUGS.has(modelSlug)) {
    return { ok: false, validSlugs: Array.from(VALID_MODEL_SLUGS) };
  }
  return { ok: true, slug: modelSlug };
}
