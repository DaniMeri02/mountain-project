import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  tokenize,
  distinctiveTokens,
  haversineMeters,
  buildRectangle,
  buildMapsUrl,
  nameTier,
  selectCandidate,
  resolveGooglePlace,
  type PlaceStore,
} from '../../agent/sources/google-places';
import type { AgentInput, PlaceCandidate } from '../../agent/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Coordinates and names are real, taken from OSM and from live Places responses.

const CURO = { name: 'Rifugio Antonio Curò', type: 'hut' as const, lat: 46.061855, lng: 10.047776 };
const RESNATI = { name: 'Bivacco Resnati', type: 'bivouac' as const, lat: 46.083831, lng: 9.999299 };
const MIRTILLO = { name: 'Rifugio Mirtillo', type: 'hut' as const, lat: 46.008889, lng: 10.006506 };

/** Build a candidate at an offset in metres from a POI, so distance gates are exercised for real. */
function candidateAt(
  name: string,
  origin: { lat: number; lng: number },
  metresNorth: number,
  primaryType = 'lodging',
  id = 'ChIJtest',
): PlaceCandidate {
  return {
    id,
    displayName: { text: name, languageCode: 'it' },
    location: { latitude: origin.lat + metresNorth / 111_320, longitude: origin.lng },
    googleMapsUri: `https://maps.google.com/?cid=123&g_mp=Cidnb29nbGU`,
    primaryType,
  };
}

function makeStore(overrides: Partial<PlaceStore> = {}): PlaceStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    reserveCall: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function mockSearchResponses(...bodies: unknown[]): ReturnType<typeof vi.spyOn> {
  let spy = vi.spyOn(global, 'fetch');
  for (const body of bodies) {
    spy = spy.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  }
  return spy;
}

beforeEach(() => { process.env.GOOGLE_PLACES_API_KEY = 'test-key'; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.GOOGLE_PLACES_API_KEY; });

// ── Normalization ────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases and strips accents', () => {
    expect(tokenize('Rifugio Antonio Curò')).toEqual(['rifugio', 'antonio', 'curo']);
  });

  it('splits on hyphens — Google writes "Bivacco Resnati-Tempesti" for OSM "Bivacco Resnati"', () => {
    expect(tokenize('Bivacco Resnati-Tempesti')).toEqual(['bivacco', 'resnati', 'tempesti']);
  });

  it('splits on apostrophes', () => {
    expect(tokenize("Baita dell'Alpe")).toEqual(['baita', 'dell', 'alpe']);
  });

  it('drops empty tokens from punctuation runs', () => {
    expect(tokenize('Rifugio  Curò / Barbellino.')).toEqual(['rifugio', 'curo', 'barbellino']);
  });
});

describe('distinctiveTokens', () => {
  it('removes kind-of-building words, keeping what identifies the place', () => {
    expect(distinctiveTokens(tokenize('Rifugio Antonio Curò'))).toEqual(['antonio', 'curo']);
    expect(distinctiveTokens(tokenize('Bivacco Resnati'))).toEqual(['resnati']);
  });
});

// ── Geometry ─────────────────────────────────────────────────────────────────

describe('haversineMeters', () => {
  it('measures the real 71m gap between Rifugio Antonio Curò and Ostello al Curò', () => {
    const d = haversineMeters(46.061855, 10.047776, 46.061431, 10.047097);
    expect(Math.round(d)).toBeGreaterThan(65);
    expect(Math.round(d)).toBeLessThan(80);
  });

  it('is zero for the same point', () => {
    expect(haversineMeters(46, 10, 46, 10)).toBe(0);
  });
});

describe('buildRectangle', () => {
  it('spans roughly ±300m and widens in longitude with latitude', () => {
    const rect = buildRectangle(46.0, 10.0);
    const northSouth = haversineMeters(rect.low.latitude, 10, rect.high.latitude, 10);
    const eastWest = haversineMeters(46, rect.low.longitude, 46, rect.high.longitude);
    expect(Math.round(northSouth)).toBeGreaterThan(590);
    expect(Math.round(northSouth)).toBeLessThan(610);
    expect(Math.round(eastWest)).toBeGreaterThan(590);
    expect(Math.round(eastWest)).toBeLessThan(610);
  });
});

// ── URL construction ─────────────────────────────────────────────────────────

describe('buildMapsUrl', () => {
  it('uses the documented place-id form and encodes the name', () => {
    expect(buildMapsUrl('Rifugio Antonio Curò', 'ChIJabc123')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Rifugio%20Antonio%20Cur%C3%B2&query_place_id=ChIJabc123',
    );
  });

  it('never emits the API telemetry parameter', () => {
    expect(buildMapsUrl('Rifugio Mirtillo', 'ChIJxyz')).not.toContain('g_mp');
  });
});

// ── Candidate selection ──────────────────────────────────────────────────────

describe('selectCandidate', () => {
  it('accepts an exact name match', () => {
    const match = selectCandidate([candidateAt('Rifugio Antonio Curò', CURO, 2)], CURO, []);
    expect(match?.displayName?.text).toBe('Rifugio Antonio Curò');
  });

  it('accepts a nested name — "Rifugio Curò" for OSM "Rifugio Antonio Curò"', () => {
    const match = selectCandidate([candidateAt('Rifugio Curò', CURO, 20)], CURO, []);
    expect(match).not.toBeNull();
  });

  it('accepts the hyphenated Google name for Bivacco Resnati', () => {
    const match = selectCandidate([candidateAt('Bivacco Resnati-Tempesti', RESNATI, 4)], RESNATI, []);
    expect(match?.displayName?.text).toBe('Bivacco Resnati-Tempesti');
  });

  it('accepts a lone synonym-prefixed match — "Baita Mirtillo" for "Rifugio Mirtillo"', () => {
    const match = selectCandidate([candidateAt('Baita Mirtillo', MIRTILLO, 40)], MIRTILLO, []);
    expect(match?.displayName?.text).toBe('Baita Mirtillo');
  });

  it('rejects "Ostello al Curò" as the hut — a real neighbour 71m away', () => {
    const match = selectCandidate([candidateAt('Ostello al Curò', CURO, 71)], CURO, []);
    expect(match).toBeNull();
  });

  it('rejects a bivouac name when the POI is a hut', () => {
    const match = selectCandidate([candidateAt('Bivacco Curò', CURO, 50)], CURO, []);
    expect(match).toBeNull();
  });

  it('rejects a hut name when the POI is a bivouac', () => {
    const match = selectCandidate([candidateAt('Rifugio Resnati', RESNATI, 30)], RESNATI, []);
    expect(match).toBeNull();
  });

  it('rejects a parking lot even when it carries the POI name', () => {
    const match = selectCandidate([candidateAt('Bivacco Resnati', RESNATI, 60, 'parking')], RESNATI, []);
    expect(match).toBeNull();
  });

  it('accepts a restaurant — Google types real rifugi that way', () => {
    const match = selectCandidate([candidateAt('Rifugio Mirtillo', MIRTILLO, 9, 'restaurant')], MIRTILLO, []);
    expect(match).not.toBeNull();
  });

  it('rejects anything beyond 300m', () => {
    const match = selectCandidate([candidateAt('Rifugio Antonio Curò', CURO, 450)], CURO, []);
    expect(match).toBeNull();
  });

  it('rejects a candidate with no location', () => {
    const noLocation: PlaceCandidate = { id: 'x', displayName: { text: 'Rifugio Antonio Curò' } };
    expect(selectCandidate([noLocation], CURO, [])).toBeNull();
  });

  it('prefers the stronger tier over the nearer candidate', () => {
    const weakButClose = candidateAt('Baita Mirtillo', MIRTILLO, 5, 'lodging', 'ChIJweak');
    const exactButFar = candidateAt('Rifugio Mirtillo', MIRTILLO, 120, 'lodging', 'ChIJexact');
    const match = selectCandidate([weakButClose, exactButFar], MIRTILLO, []);
    expect(match?.id).toBe('ChIJexact');
  });

  it('breaks ties inside a tier by distance', () => {
    const far = candidateAt('Rifugio Mirtillo', MIRTILLO, 200, 'lodging', 'ChIJfar');
    const near = candidateAt('Rifugio Mirtillo', MIRTILLO, 10, 'lodging', 'ChIJnear');
    expect(selectCandidate([far, near], MIRTILLO, [])?.id).toBe('ChIJnear');
  });

  it('refuses to guess between two weak matches', () => {
    const a = candidateAt('Baita Mirtillo', MIRTILLO, 30, 'lodging', 'ChIJa');
    const b = candidateAt('Chalet Mirtillo', MIRTILLO, 60, 'lodging', 'ChIJb');
    expect(selectCandidate([a, b], MIRTILLO, [])).toBeNull();
  });

  it('accepts a listing-category word like "Ristorante" — real rifugi are listed that way', () => {
    const match = selectCandidate([candidateAt('Ristorante Mirtillo', MIRTILLO, 20)], MIRTILLO, []);
    expect(match?.displayName?.text).toBe('Ristorante Mirtillo');
  });

  it('rejects the English "Bivouac" for a hut, not just the Italian spelling', () => {
    expect(selectCandidate([candidateAt('Bivouac Mirtillo', MIRTILLO, 20)], MIRTILLO, [])).toBeNull();
  });

  it('rejects any hut word for a bivouac, including ones absent from the old hand-written list', () => {
    for (const name of ['Capanna Resnati', 'Chalet Resnati', 'Casera Resnati']) {
      expect(selectCandidate([candidateAt(name, RESNATI, 20)], RESNATI, [])).toBeNull();
    }
  });

  it('records a verdict for every candidate it considers', () => {
    const debug: string[] = [];
    selectCandidate([candidateAt('Parcheggio Curò', CURO, 100, 'parking')], CURO, debug);
    expect(debug.join('\n')).toContain('deny-list');
  });
});

// ── resolveGooglePlace ───────────────────────────────────────────────────────

describe('resolveGooglePlace', () => {
  const key = 'cache-key';

  it('skips peaks and ferrata without calling the API', async () => {
    const spy = vi.spyOn(global, 'fetch');
    for (const type of ['peak', 'ferrata'] as const) {
      const result = await resolveGooglePlace({ name: 'Pizzo Coca', type, lat: 46, lng: 10 }, makeStore(), key);
      expect(result.status).toBe('unavailable');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips when coordinates are missing', async () => {
    const spy = vi.spyOn(global, 'fetch');
    const result = await resolveGooglePlace({ name: 'Rifugio X', type: 'hut' }, makeStore(), key);
    expect(result.status).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips when the API key is not configured', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const spy = vi.spyOn(global, 'fetch');
    const result = await resolveGooglePlace(CURO as AgentInput, makeStore(), key);
    expect(result.status).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns a built link on a first-pass match and caches the place id', async () => {
    mockSearchResponses({ places: [candidateAt('Rifugio Antonio Curò', CURO, 2, 'lodging', 'ChIJcuro')] });
    const store = makeStore();

    const result = await resolveGooglePlace(CURO as AgentInput, store, key);

    expect(result.status).toBe('found');
    expect(result.placeId).toBe('ChIJcuro');
    expect(result.url).toContain('query_place_id=ChIJcuro');
    expect(result.url).not.toContain('g_mp');
    expect(store.save).toHaveBeenCalledWith(key, 'Rifugio Antonio Curò', 'ChIJcuro');
  });

  it('runs a second pass without the kind-of-building word when the first finds nothing', async () => {
    const spy = mockSearchResponses(
      { places: [] },
      { places: [candidateAt('Baita Mirtillo', MIRTILLO, 40, 'lodging', 'ChIJbaita')] },
    );

    const result = await resolveGooglePlace(MIRTILLO as AgentInput, makeStore(), key);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body)).textQuery).toBe('Rifugio Mirtillo');
    expect(JSON.parse(String((spy.mock.calls[1][1] as RequestInit).body)).textQuery).toBe('mirtillo');
    expect(result.status).toBe('found');
  });

  it('does not run a second pass when the first one matched', async () => {
    const spy = mockSearchResponses({ places: [candidateAt('Rifugio Mirtillo', MIRTILLO, 9)] });
    await resolveGooglePlace(MIRTILLO as AgentInput, makeStore(), key);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('records a verified absence so the description can say so', async () => {
    mockSearchResponses({ places: [] }, { places: [] });
    const store = makeStore();

    const result = await resolveGooglePlace(RESNATI as AgentInput, store, key);

    expect(result.status).toBe('not_found');
    expect(store.save).toHaveBeenCalledWith(key, 'Bivacco Resnati', null);
  });

  it('serves a cached hit without calling the API', async () => {
    const spy = vi.spyOn(global, 'fetch');
    const store = makeStore({
      get: vi.fn().mockResolvedValue({ placeId: 'ChIJcached', poiName: 'Rifugio Antonio Curò' }),
    });

    const result = await resolveGooglePlace(CURO as AgentInput, store, key);

    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe('found');
    expect(result.url).toBe(buildMapsUrl('Rifugio Antonio Curò', 'ChIJcached'));
  });

  it('serves a cached absence without calling the API', async () => {
    const spy = vi.spyOn(global, 'fetch');
    const store = makeStore({ get: vi.fn().mockResolvedValue({ placeId: null, poiName: 'Bivacco Resnati' }) });

    const result = await resolveGooglePlace(RESNATI as AgentInput, store, key);

    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe('not_found');
  });

  it('stops at the spend limit without calling the API, and does not claim absence', async () => {
    const spy = vi.spyOn(global, 'fetch');
    const store = makeStore({ reserveCall: vi.fn().mockResolvedValue(false) });

    const result = await resolveGooglePlace(CURO as AgentInput, store, key);

    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe('unavailable');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('counts one call per pass, not one per POI', async () => {
    mockSearchResponses({ places: [] }, { places: [] });
    const store = makeStore();
    await resolveGooglePlace(MIRTILLO as AgentInput, store, key);
    expect(store.reserveCall).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable — never absent — when the API errors', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { message: 'API key not valid' } }),
    } as Response);
    const store = makeStore();

    const result = await resolveGooglePlace(CURO as AgentInput, store, key);

    expect(result.status).toBe('unavailable');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('reports unavailable when the request times out', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('The operation was aborted'));
    const result = await resolveGooglePlace(CURO as AgentInput, makeStore(), key);
    expect(result.status).toBe('unavailable');
  });

  it('sends the Pro field mask and a strict rectangle restriction', async () => {
    const spy = mockSearchResponses({ places: [] }, { places: [] });
    await resolveGooglePlace(CURO as AgentInput, makeStore(), key);

    const init = spy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toContain('places.googleMapsUri');
    expect(headers['X-Goog-Api-Key']).toBe('test-key');

    const body = JSON.parse(String(init.body));
    expect(body.locationRestriction.rectangle).toBeDefined();
    expect(body.locationBias).toBeUndefined();
    expect(body.pageSize).toBe(20);
  });
});
