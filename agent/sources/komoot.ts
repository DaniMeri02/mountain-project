import type { AgentInput, SourceResult, KomootHighlight, KomootTour, KomootTip } from '../types';

const BASE = 'https://api.komoot.de/v007';

// Expand search radius in steps — tight first to avoid false name matches
const SEARCH_RADII = [300, 800, 2_000];

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function findNearbyHighlight(
  name: string,
  lat: number,
  lng: number,
): Promise<KomootHighlight | null> {
  const needle = normalize(name);

  for (const radius of SEARCH_RADII) {
    const url = `${BASE}/highlights/?center=${lat},${lng}&max_distance=${radius}&limit=10`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const data = (await res.json()) as { _embedded?: { items?: KomootHighlight[] } };
    const highlights = data._embedded?.items ?? [];

    const match = highlights.find((h) => {
      const haystack = normalize(h.base_name ?? h.name ?? '');
      return haystack.includes(needle) || needle.includes(haystack);
    });

    if (match) return match;
  }
  return null;
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
  if (listText.length > 300) return listText.replace(/\s+/g, ' ').trim().slice(0, 700);

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
      .map((f) => f.answer.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 450))
      .join('\n');
  } catch {
    return listText;
  }
}

async function fetchTips(highlightId: number): Promise<KomootTip[]> {
  const url = `${BASE}/highlights/${highlightId}/tips/?limit=10`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { _embedded?: { tips?: KomootTip[] } };
  return (data._embedded?.tips ?? []).sort(
    (a, b) => (b.votes?.up ?? 0) - (a.votes?.up ?? 0),
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

  // Highlight intro — strip HTML tags left by Komoot's rich-text editor
  if (highlight.intro) {
    const intro = highlight.intro.replace(/<[^>]+>/g, '').trim().slice(0, 400);
    if (intro) lines.push(`Komoot intro: ${intro}`);
  }

  // Top 2 tours — fetch full descriptions in parallel (editorial tours via FAQ, user tours via list text)
  const tours = toursResult.status === 'fulfilled' ? toursResult.value : [];
  const top2 = tours.slice(0, 2);
  const descResults = await Promise.allSettled(
    top2.map((t) =>
      fetchTourFullDescription(
        String(t.id ?? ''),
        t._embedded?.tour_description?.text ?? '',
      ),
    ),
  );

  for (let i = 0; i < top2.length; i++) {
    const t = top2[i];
    const parts: string[] = [];
    if (t.name) parts.push(t.name);
    if (t.distance != null) parts.push(`${(t.distance / 1_000).toFixed(1)} km`);
    if (t.elevation_up != null) parts.push(`↑${Math.round(t.elevation_up)} m`);
    if (t.difficulty?.grade) parts.push(t.difficulty.grade);
    const desc = descResults[i].status === 'fulfilled' ? descResults[i].value : '';
    lines.push(`Tour: ${parts.join(' · ')}${desc ? `\n  ${desc}` : ''}`);
  }

  // Top 3 tips by upvotes (already sorted)
  const tips = tipsResult.status === 'fulfilled' ? tipsResult.value : [];
  for (const tip of tips.slice(0, 3)) {
    const text = tip.text?.trim();
    if (text) {
      const votes = tip.votes?.up ? ` (${tip.votes.up} ↑)` : '';
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
