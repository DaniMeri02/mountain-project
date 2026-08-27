import type { AgentInput, GooglePlaceLink, PlaceCandidate, PlacesSearchResponse } from '../types';

/**
 * Resolves the Google Maps link for a hut or bivouac — deterministically, server-side.
 *
 * No model in the cascade can browse, so a Maps URL written by an LLM is invented. This module is
 * the only thing allowed to produce one, and it links a place only when the API's answer provably
 * refers to *that* POI: inside a ~300m box, name tokens agreeing, and no contradiction between the
 * POI's kind and the words in Google's name.
 *
 * Nothing here reaches the prompt. The orchestrator appends the result to the finished description.
 */

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

// Pro SKU: 5,000 calls/month free. `primaryType` and `googleMapsUri` cost nothing extra once
// displayName is requested, and the number of results returned never affects billing.
const FIELD_MASK =
  'places.id,places.displayName,places.location,places.googleMapsUri,places.primaryType';

const SEARCH_RADIUS_M = 300;
const MAX_DISTANCE_M = 300;
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 20;

/**
 * Google has no mountain-hut type — real rifugi come back as `lodging`, `restaurant`, `bar`,
 * `cottage`, `tourist_attraction`, unpredictably. So this is a deny-list of things a hut plainly
 * is not, never an allow-list. `hiking_area` and the park types are deliberately absent: a remote
 * bivouac could legitimately carry one.
 */
const REJECTED_PRIMARY_TYPES = new Set([
  'parking', 'parking_lot', 'parking_garage',
  'bus_station', 'bus_stop', 'transit_station', 'transit_stop',
]);

/**
 * Words that name a *kind* of building.
 *
 * A word belonging to the other kind, or to a different sort of lodging, vetoes the match — this
 * is what stops `Ostello al Curò` being linked as `Rifugio Antonio Curò`, two real places 71m
 * apart. Conflicts are derived rather than listed per type, so the two sets cannot drift out of
 * step: everything that names one kind automatically contradicts the other.
 *
 * Words Google uses as a *listing* category rather than a building kind — `ristorante`, `bar` —
 * are deliberately absent. Real rifugi are routinely listed that way (Rifugio Mirtillo comes back
 * with primaryType `restaurant`), so treating them as contradictions would reject genuine matches.
 */
const HUT_WORDS = new Set(['rifugio', 'baita', 'capanna', 'chalet', 'casera']);
const BIVOUAC_WORDS = new Set(['bivacco', 'bivouac']);
const OTHER_LODGING_WORDS = new Set(['ostello', 'albergo', 'hotel', 'agriturismo', 'parcheggio']);

const CONFLICTING_WORDS: Record<'hut' | 'bivouac', Set<string>> = {
  hut: new Set([...BIVOUAC_WORDS, ...OTHER_LODGING_WORDS]),
  bivouac: new Set([...HUT_WORDS, ...OTHER_LODGING_WORDS]),
};

const ALL_CATEGORY_WORDS = new Set([...HUT_WORDS, ...BIVOUAC_WORDS, ...OTHER_LODGING_WORDS]);

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Splits on punctuation as well as whitespace. This is load-bearing, not cosmetic: OSM's
 * `Bivacco Resnati` is `Bivacco Resnati-Tempesti` on Google, 4m away. Splitting on spaces alone
 * yields `resnati-tempesti`, which does not match `resnati`, and a genuinely listed bivouac would
 * be reported as absent. Apostrophes behave the same way (`dell'Alpe` → `dell`, `alpe`).
 */
export function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Tokens that identify *this* place, with the generic kind-of-building words removed. */
export function distinctiveTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !ALL_CATEGORY_WORDS.has(t));
}

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Text Search restricts strictly to a rectangle only — a circle is `locationBias`, which merely
 * nudges ranking and would let far-away results through.
 */
export function buildRectangle(lat: number, lng: number, metres = SEARCH_RADIUS_M): {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
} {
  const dLat = metres / 111_320;
  const dLng = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    low: { latitude: lat - dLat, longitude: lng - dLng },
    high: { latitude: lat + dLat, longitude: lng + dLng },
  };
}

/**
 * Built from the place ID, never from the API's `googleMapsUri`. Place IDs are the one field
 * Google's caching policy exempts from its storage restrictions, and the returned URI carries a
 * `g_mp` telemetry parameter we have no reason to store or render. Building it here also means a
 * cache hit and a fresh lookup produce byte-identical links.
 */
export function buildMapsUrl(name: string, placeId: string): string {
  const query = encodeURIComponent(name);
  return `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${placeId}`;
}

/** 1 = identical, 2 = one name nested in the other, 3 = distinctive tokens only, null = no match. */
export function nameTier(osmTokens: string[], googleTokens: string[]): 1 | 2 | 3 | null {
  const osm = new Set(osmTokens);
  const google = new Set(googleTokens);

  const sameSize = osm.size === google.size;
  const osmInGoogle = [...osm].every((t) => google.has(t));
  const googleInOsm = [...google].every((t) => osm.has(t));

  if (sameSize && osmInGoogle) return 1;
  if (osmInGoogle || googleInOsm) return 2;

  const distinctive = distinctiveTokens(osmTokens);
  if (distinctive.length > 0 && distinctive.every((t) => google.has(t))) return 3;

  return null;
}

interface Survivor {
  candidate: PlaceCandidate;
  tier: 1 | 2 | 3;
  distanceM: number;
}

/**
 * Applies every gate and returns the accepted candidate, or null for a verified absence.
 * Order matters: cheap structural rejections first, so the debug log reads as a decision trail.
 */
export function selectCandidate(
  candidates: PlaceCandidate[],
  input: { name: string; type: 'hut' | 'bivouac'; lat: number; lng: number },
  debug: string[],
): PlaceCandidate | null {
  const osmTokens = tokenize(input.name);
  const conflicts = CONFLICTING_WORDS[input.type];
  const survivors: Survivor[] = [];

  for (const candidate of candidates) {
    const label = candidate.displayName?.text ?? '(unnamed)';
    const reject = (why: string): void => void debug.push(`  ✗ ${label} — ${why}`);

    if (candidate.primaryType && REJECTED_PRIMARY_TYPES.has(candidate.primaryType)) {
      reject(`primaryType ${candidate.primaryType} is on the deny-list`);
      continue;
    }
    if (!candidate.location) {
      reject('no location returned');
      continue;
    }

    const distanceM = Math.round(
      haversineMeters(input.lat, input.lng, candidate.location.latitude, candidate.location.longitude),
    );
    if (distanceM > MAX_DISTANCE_M) {
      reject(`${distanceM}m away, over the ${MAX_DISTANCE_M}m limit`);
      continue;
    }

    const googleTokens = tokenize(label);
    const conflicting = googleTokens.find((t) => conflicts.has(t));
    if (conflicting) {
      reject(`name says "${conflicting}", which contradicts a ${input.type}`);
      continue;
    }

    const tier = nameTier(osmTokens, googleTokens);
    if (tier === null) {
      reject(`name shares no distinctive token (${distanceM}m)`);
      continue;
    }

    debug.push(`  · ${label} — tier ${tier}, ${distanceM}m, type ${candidate.primaryType ?? '-'}`);
    survivors.push({ candidate, tier, distanceM });
  }

  if (survivors.length === 0) {
    debug.push('  → no candidate survived');
    return null;
  }

  const bestTier = Math.min(...survivors.map((s) => s.tier));

  // A tier-3 survivor shares only the distinctive token, so it is the ambiguous case: the real hut
  // may simply be unlisted while a neighbour is. Trust it only when it is the sole survivor —
  // two weak candidates mean we cannot tell them apart, and guessing is worse than saying nothing.
  // Any contradicting kind-of-building word was already vetoed above.
  if (bestTier === 3 && survivors.length > 1) {
    debug.push(`  → ${survivors.length} weak matches, none distinguishable — treating as absent`);
    return null;
  }

  const best = survivors
    .filter((s) => s.tier === bestTier)
    .sort((a, b) => a.distanceM - b.distanceM)[0];

  debug.push(`  → accepted: ${best.candidate.displayName?.text} (tier ${bestTier}, ${best.distanceM}m)`);
  return best.candidate;
}

// ── Store seam ───────────────────────────────────────────────────────────────

/** What the resolver needs from Postgres. Implemented by GooglePlaceCache; faked in tests. */
export interface PlaceStore {
  /** Cached lookup, or null when this POI has never been checked (or the absence went stale). */
  get(cacheKey: string): Promise<{ placeId: string | null; poiName: string } | null>;
  save(cacheKey: string, poiName: string, placeId: string | null): Promise<void>;
  /** Increments the day and month counters, or returns false when either ceiling is reached. */
  reserveCall(): Promise<boolean>;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

async function searchText(
  textQuery: string,
  input: { lat: number; lng: number },
  apiKey: string,
): Promise<PlacesSearchResponse> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      textQuery,
      locationRestriction: { rectangle: buildRectangle(input.lat, input.lng) },
      pageSize: PAGE_SIZE,
      languageCode: 'it',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as PlacesSearchResponse;
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as PlacesSearchResponse;
}

function isLinkable(type: string): type is 'hut' | 'bivouac' {
  return type === 'hut' || type === 'bivouac';
}

/**
 * Looks up the Google Maps listing for a hut or bivouac.
 *
 * Never throws: any failure is `unavailable`, which the orchestrator renders as *nothing at all*.
 * That separation is the whole point — only `not_found` may be shown to the user as "no link",
 * because only `not_found` means Google actually answered and had nothing.
 */
export async function resolveGooglePlace(
  input: AgentInput,
  store: PlaceStore,
  cacheKey: string,
): Promise<GooglePlaceLink> {
  const debug: string[] = [];

  if (!isLinkable(input.type)) return { status: 'unavailable' };
  if (input.lat == null || input.lng == null) return { status: 'unavailable' };
  if (!input.name.trim()) return { status: 'unavailable' };

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return { status: 'unavailable', debug: ['GOOGLE_PLACES_API_KEY not set — lookup skipped'] };
  }

  const lat = Number(input.lat);
  const lng = Number(input.lng);
  const target = { name: input.name, type: input.type, lat, lng };

  try {
    const cached = await store.get(cacheKey);
    if (cached) {
      return cached.placeId
        ? {
            status: 'found',
            placeId: cached.placeId,
            url: buildMapsUrl(cached.poiName, cached.placeId),
            debug: ['served from google_place_cache'],
          }
        : { status: 'not_found', debug: ['known absent (google_place_cache)'] };
    }

    // Pass 1 is the full OSM name. Pass 2 drops the kind-of-building word, which is what finds a
    // hut Google lists under a different one — `Baita Mirtillo` for OSM's `Rifugio Mirtillo`.
    const queries = [input.name];
    const distinctive = distinctiveTokens(tokenize(input.name)).join(' ');
    if (distinctive && distinctive !== input.name.toLowerCase()) queries.push(distinctive);

    for (const [index, query] of queries.entries()) {
      if (!(await store.reserveCall())) {
        return { status: 'unavailable', debug: [...debug, 'daily or monthly call limit reached'] };
      }

      debug.push(`pass ${index + 1}: "${query}"`);
      const body = await searchText(query, target, apiKey);
      const candidates = body.places ?? [];
      if (candidates.length === 0) {
        debug.push('  → no results in the search box');
        continue;
      }

      const match = selectCandidate(candidates, target, debug);
      if (match) {
        await store.save(cacheKey, input.name, match.id);
        if (match.googleMapsUri) debug.push(`  google's own uri: ${match.googleMapsUri}`);
        return {
          status: 'found',
          placeId: match.id,
          url: buildMapsUrl(input.name, match.id),
          debug,
        };
      }
    }

    await store.save(cacheKey, input.name, null);
    return { status: 'not_found', debug };
  } catch (err) {
    // A failed lookup is not evidence of absence — say "unavailable" and write nothing to the
    // cache, so the next request retries instead of inheriting a wrong answer.
    console.error('[GooglePlaces]', err);
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'unavailable', debug: [...debug, `lookup failed: ${message}`] };
  }
}
