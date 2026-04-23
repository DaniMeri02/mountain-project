import type { AgentInput, SourceResult, KomootHighlight, KomootTour, KomootTip } from '../types';

const BASE = 'https://api.komoot.de/v007';

// Expand search radius in steps — tight first to avoid false name matches
const SEARCH_RADII = [300, 800, 2_000];

export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Generic Italian/English mountain words that appear in many names — exclude from word-overlap matching
// so "monte" or "rifugio" alone don't produce false-positive matches across different POIs.
const GENERIC_WORDS = new Set([
  'rifugio', 'bivacco', 'bivouac', 'monte', 'colle', 'passo', 'pizzo', 'cima',
  'bocchetta', 'forcella', 'sentiero', 'alpe', 'valle',
  'hut', 'lake', 'pass', 'trail', 'mountain', 'peak', 'summit', 'valley',
  'reservoir', 'viewpoint', 'waterfall', 'junction',
]);

async function findNearbyHighlight(
  name: string,
  lat: number,
  lng: number,
): Promise<KomootHighlight | null> {
  const needle = normalize(name);
  // Unique words from the needle (5+ chars, not generic) used for word-overlap matching.
  // Handles translated names: "Rifugio Barbellino" → unique word "barbellino"
  // matches "Ludwigsburg Hut at Barbellino" even though full strings don't include each other.
  const needleWords = needle.split(' ').filter((w) => w.length >= 5 && !GENERIC_WORDS.has(w));

  for (const radius of SEARCH_RADII) {
    const url = `${BASE}/highlights/?center=${lat},${lng}&max_distance=${radius}&limit=15`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      console.error('[Komoot] highlight fetch at radius', radius, 'failed:', err);
      continue;
    }
    if (!res.ok) continue;

    const data = (await res.json()) as { _embedded?: { items?: KomootHighlight[] } };
    const highlights = data._embedded?.items ?? [];

    const match = highlights.find((h) => {
      const haystack = normalize(h.base_name ?? h.name ?? '');
      if (haystack.includes(needle) || needle.includes(haystack)) return true;
      return needleWords.length > 0 && needleWords.some((w) => haystack.includes(w));
    });

    if (match) return match;
  }
  return null;
}

/**
 * Fallback for highlights with no tagged tours (e.g. bare peaks).
 * Searches nearby highlights within 5 km, prioritising those whose
 * name shares significant words with the input POI name, and returns
 * the first batch of tours found alongside the highlight they came from.
 */
async function fetchNearbyFallbackTours(
  inputName: string,
  lat: number,
  lng: number,
  excludeId: number,
): Promise<{ tours: KomootTour[]; sourceHighlight: KomootHighlight | null }> {
  try {
    const res = await fetch(
      `${BASE}/highlights/?center=${lat},${lng}&max_distance=5000&limit=20`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return { tours: [], sourceHighlight: null };
    const data = (await res.json()) as { _embedded?: { items?: KomootHighlight[] } };
    const nearby = (data._embedded?.items ?? []).filter((h) => h.id !== excludeId);

    // Prefer highlights that share at least one significant word with our POI name
    const words = normalize(inputName).split(' ').filter((w) => w.length >= 4);
    const nameMatched = nearby.filter((h) =>
      words.some((w) => normalize(h.base_name ?? h.name ?? '').includes(w)),
    );
    const ordered = [...nameMatched, ...nearby].filter(
      (h, i, arr) => arr.indexOf(h) === i,
    );

    for (const h of ordered.slice(0, 6)) {
      const tours = await fetchTours(h.id);
      if (tours.length > 0) return { tours, sourceHighlight: h };
    }
    return { tours: [], sourceHighlight: null };
  } catch (err) {
    console.error('[Komoot] fetchNearbyFallbackTours failed:', err);
    return { tours: [], sourceHighlight: null };
  }
}

async function fetchTours(highlightId: number): Promise<KomootTour[]> {
  const url = `${BASE}/discover_tours/for_highlight/${highlightId}/?sport_types=hike&limit=5`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { _embedded?: { items?: KomootTour[] } };
  return data._embedded?.items ?? [];
}

/**
 * Returns the richest description available for a tour:
 * - User-authored tours: the list endpoint already carries the full text (~1000-2000 chars)
 * - Editorial tours: the list only has a short blurb — fetch the detail endpoint and extract
 *   the 2 most informative FAQs (terrain/landmarks/wildlife).
 */
async function fetchTourFullDescription(tourId: string, listText: string): Promise<string> {
  // Long list text = user-authored tour — already complete, just cap it
  if (listText.length > 300) return listText.replace(/\s+/g, ' ').trim().slice(0, 1_200);

  // Short text = editorial tour — the FAQ array on the detail endpoint has the real content
  const numericId = tourId.replace(/^e/, '');
  try {
    const res = await fetch(`${BASE}/tours/${numericId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return listText;

    const data = (await res.json()) as {
      faq?: Array<{ question: string; answer: string }>;
    };
    if (!data.faq?.length) return listText;

    // Prefer FAQs about what to experience on the trail — most useful for a guide
    const USEFUL = /terrain|expect|highlight|viewpoint|landmark|wildlife|flora|scenery|feature/i;
    const chosen = [
      ...data.faq.filter((f) => USEFUL.test(f.question)),
      ...data.faq,
    ]
      .filter((f, i, arr) => arr.indexOf(f) === i) // deduplicate preserving order
      .slice(0, 2);

    return chosen
      .map((f) => f.answer.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600))
      .join('\n');
  } catch (err) {
    console.error('[Komoot] fetchTourFullDescription failed:', err);
    return listText;
  }
}

async function fetchTips(highlightId: number): Promise<KomootTip[]> {
  const url = `${BASE}/highlights/${highlightId}/tips/?limit=10`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  // Tips endpoint uses _embedded.items (not _embedded.tips) and rating (not votes)
  const data = (await res.json()) as { _embedded?: { items?: KomootTip[] } };
  return (data._embedded?.items ?? []).sort(
    (a, b) => (b.rating?.up ?? 0) - (a.rating?.up ?? 0),
  );
}

export async function fetchKomootData(input: AgentInput): Promise<SourceResult> {
  if (input.lat == null || input.lng == null) {
    return { sourceName: 'Komoot', content: '', success: false };
  }

  const highlight = await findNearbyHighlight(input.name, input.lat, input.lng).catch(
    () => null,
  );
  if (!highlight) return { sourceName: 'Komoot', content: '', success: false };

  const [toursResult, tipsResult] = await Promise.allSettled([
    fetchTours(highlight.id),
    fetchTips(highlight.id),
  ]);

  const lines: string[] = [];

  // Highlight intro — huts carry rich editorial text here (up to 3000+ chars from the list endpoint).
  // Bare peaks have no intro: Komoot shows Wikipedia text on their site via wiki_poi_id,
  // but that is fetched by their frontend directly — it is not exposed in the API.
  if (highlight.intro) {
    const intro = highlight.intro.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 800);
    if (intro) lines.push(`Komoot: ${intro}`);
  }

  // Top 2 tours — if the matched highlight has none (e.g. a bare peak), fall back to nearby highlights
  let tours = toursResult.status === 'fulfilled' ? toursResult.value : [];
  let fallbackHighlight: KomootHighlight | null = null;
  if (tours.length === 0) {
    const fallback = await fetchNearbyFallbackTours(input.name, input.lat, input.lng, highlight.id);
    tours = fallback.tours;
    fallbackHighlight = fallback.sourceHighlight;
  }
  const top2 = tours.slice(0, 2);
  const descResults = await Promise.allSettled(
    top2.map((t) =>
      fetchTourFullDescription(
        String(t.id ?? ''),
        t._embedded?.tour_description?.text ?? '',
      ),
    ),
  );

  // When tours come from a nearby fallback highlight, label the section clearly
  const tourLabel = fallbackHighlight
    ? `Nearby approach routes (via ${fallbackHighlight.base_name ?? fallbackHighlight.name})`
    : null;
  if (tourLabel) lines.push(tourLabel);

  for (let i = 0; i < top2.length; i++) {
    const t = top2[i];
    const parts: string[] = [];
    if (t.name) parts.push(t.name);
    if (t.distance != null) parts.push(`${(t.distance / 1_000).toFixed(1)} km`);
    if (t.elevation_up != null) parts.push(`↑${Math.round(t.elevation_up)} m`);
    if (t.difficulty?.grade) parts.push(t.difficulty.grade);
    const descResult = descResults[i];
    const desc = descResult.status === 'fulfilled' ? descResult.value : '';
    lines.push(`Tour: ${parts.join(' · ')}${desc ? `\n  ${desc}` : ''}`);
  }

  // Top 3 tips by upvotes (already sorted) — prefer English translation when available
  const tips = tipsResult.status === 'fulfilled' ? tipsResult.value : [];
  for (const tip of tips.slice(0, 3)) {
    const text = (tip.translated_text ?? tip.text)?.trim();
    if (text) {
      const votes = tip.rating?.up ? ` (${tip.rating.up} ↑)` : '';
      lines.push(`Tip${votes}: ${text.slice(0, 200)}`);
    }
  }

  if (lines.length === 0) return { sourceName: 'Komoot', content: '', success: false };

  return {
    sourceName: 'Komoot',
    content: lines.join('\n\n'),
    success: true,
    url: `https://www.komoot.com/highlight/${highlight.id}`,
  };
}
