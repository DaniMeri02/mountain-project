const APIFY_BASE = 'https://api.apify.com/v2/acts';

// ─── Process-level result cache ───────────────────────────────────────────────
// Prevents re-running the same actor+input within the same server session.
// Key: `${actor}::${JSON.stringify(body)}` — unique per POI and source.
// TTL: 6 hours — long enough to cover repeated "Rigenera" clicks on the same POI.

const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

interface ApifyCacheEntry {
  data: unknown[];
  expiresAt: number;
}

const resultCache = new Map<string, ApifyCacheEntry>();

/**
 * Call an Apify actor synchronously and return its dataset items as a typed array.
 * Results are cached in-process for 6 hours to avoid repeat billing on the same input.
 * Returns [] on any network error or non-OK HTTP response.
 */
export async function runApifyActor<T>(
  actor: string,
  body: Record<string, unknown>,
  token: string
): Promise<T[]> {
  const cacheKey = `${actor}::${JSON.stringify(body)}`;
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data as T[];
  }

  const url = `${APIFY_BASE}/${actor}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    console.warn(`[apify] ${actor} → HTTP ${res.status}`);
    return [];
  }

  const data = (await res.json()) as T[];
  resultCache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}
