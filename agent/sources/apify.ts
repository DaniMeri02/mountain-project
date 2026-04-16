const APIFY_BASE = 'https://api.apify.com/v2/acts';

/**
 * Call an Apify actor synchronously and return its dataset items as a typed array.
 * Returns [] on any network error or non-OK HTTP response — each caller decides
 * how to handle the empty result without crashing the overall agent run.
 */
export async function runApifyActor<T>(
  actor: string,
  body: Record<string, unknown>,
  token: string
): Promise<T[]> {
  const url = `${APIFY_BASE}/${actor}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),   // 90s — Apify cold starts can be slow
  });
  if (!res.ok) {
    console.warn(`[apify] ${actor} → HTTP ${res.status}`);
    return [];
  }
  return (await res.json()) as T[];
}
