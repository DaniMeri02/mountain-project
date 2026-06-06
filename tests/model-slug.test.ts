import { describe, it, expect } from 'vitest';
import { resolveModelSlug } from '../agent/model-slug';
import { AI_MODELS } from '../agent/orchestrator';

// resolveModelSlug decides whether a caller-supplied model slug is usable. It is pure: it
// returns a result, leaving any HTTP response to the route. undefined means "no preference,
// use the default cascade".
describe('resolveModelSlug', () => {
  it('accepts a missing slug as "use the default cascade"', () => {
    expect(resolveModelSlug(undefined)).toEqual({ ok: true, slug: undefined });
    expect(resolveModelSlug(null)).toEqual({ ok: true, slug: undefined });
  });

  it('accepts a known model slug and echoes it back', () => {
    const known = AI_MODELS[0].slug;
    expect(resolveModelSlug(known)).toEqual({ ok: true, slug: known });
  });

  it('rejects an unknown slug and reports the valid set', () => {
    const res = resolveModelSlug('not-a-real-model');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.validSlugs).toEqual(AI_MODELS.map((m) => m.slug));
    }
  });
});
