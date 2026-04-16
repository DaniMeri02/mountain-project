import type { AgentInput, SourceResult, TripAdvisorPlace } from '../types';
import { runApifyActor } from './apify';

const ACTOR = 'maxcopell~tripadvisor';

export async function fetchTripAdvisorData(input: AgentInput): Promise<SourceResult> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { sourceName: 'TripAdvisor', content: '', success: false };

  const places = await runApifyActor<TripAdvisorPlace>(
    ACTOR,
    {
      query: input.name,
      includeAttractions: true,
      includeHotels: false,
      includeRestaurants: false,
      maxItemsPerQuery: 3,
    },
    token
  ).catch(() => []);

  if (places.length === 0) return { sourceName: 'TripAdvisor', content: '', success: false };

  const content = places
    .map((place) => {
      const meta: string[] = [];
      if (place.name) meta.push(place.name);
      if (place.locationString) meta.push(`(${place.locationString})`);
      if (place.rating != null) meta.push(`★ ${place.rating}/5`);
      if (place.numberOfReviews != null) meta.push(`${place.numberOfReviews} reviews`);
      const headline = meta.join(' ');
      const desc = place.description?.slice(0, 300).replace(/\n+/g, ' ') ?? '';
      const link = place.url ?? '';
      return `• ${headline}\n  ${desc}\n  ${link}`;
    })
    .join('\n\n');

  return { sourceName: 'TripAdvisor', content, success: true };
}
