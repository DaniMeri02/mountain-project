import type { AgentInput, SourceResult, KomootRoute } from '../types';
import { runApifyActor } from './apify';

const ACTOR = 'logiover~komoot-hiking-outdoor-routes-scraper';

// Komoot only supports: hike, mtb, racebike, touringbicycle, jogging, e_mtb, e_touringbicycle
// Ferratas are hiked to (no dedicated climbing mode), so they stay as 'hike'
const SPORT_BY_TYPE: Partial<Record<string, string>> = {};

const MAX_DISTANCE_BY_TYPE: Partial<Record<string, number>> = {
  ferrata:  3_000,   // ferratas are precise — tight radius avoids unrelated routes
  peak:     8_000,   // approach trails may start a few km away
  hut:      6_000,
  bivouac:  6_000,
};

function buildKomootInput(input: AgentInput): Record<string, unknown> {
  const sport       = SPORT_BY_TYPE[input.type]        ?? 'hike';
  const maxDistance = MAX_DISTANCE_BY_TYPE[input.type] ?? 10_000;

  const hasCoords = input.lat != null && input.lng != null;

  if (hasCoords) {
    return {
      mode:        'coords',
      lat:         input.lat,
      lng:         input.lng,
      sport,
      maxDistance,
      maxResults:  5,
    };
  }

  return {
    mode:       'location',
    location:   input.name,
    sport,
    maxResults: 5,
  };
}

export async function fetchKomootRoutes(input: AgentInput): Promise<SourceResult> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { sourceName: 'Komoot', content: '', success: false };

  const actorInput = buildKomootInput(input);
  const routes = await runApifyActor<KomootRoute>(ACTOR, actorInput, token).catch(() => []);

  if (routes.length === 0) return { sourceName: 'Komoot', content: '', success: false };

  const content = routes
    .map((route) => {
      const parts: string[] = [];
      if (route.name) parts.push(route.name);
      if (route.distance != null) parts.push(`${(route.distance / 1000).toFixed(1)} km`);
      if (route.elevation_up != null) parts.push(`↑${route.elevation_up} m`);
      if (route.difficulty) parts.push(route.difficulty);
      const headline = parts.join(' · ');
      // Strip HTML tags that Komoot sometimes includes in descriptions
      const desc = route.description
        ? route.description.replace(/<[^>]+>/g, '').slice(0, 200).replace(/\n+/g, ' ')
        : '';
      const link = route.url ?? '';
      return `• ${headline}\n  ${desc}\n  ${link}`;
    })
    .join('\n\n');

  return { sourceName: 'Komoot', content, success: true };
}
