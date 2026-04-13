import type { AgentInput, OverpassResponse, SourceResult } from '../types';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * OSM tags that are actually useful for generating a description.
 * Everything else is silently dropped.
 */
const USEFUL_TAGS = new Set([
  'name', 'name:it', 'alt_name', 'official_name',
  'description', 'description:it', 'note', 'note:it',
  'ele', 'website', 'contact:website', 'url',
  'phone', 'contact:phone', 'email', 'contact:email',
  'opening_hours', 'seasonal', 'capacity',
  'operator', 'operator:it', 'owner',
  'access', 'access:description',
  'tourism', 'mountain_pass', 'natural',
  'via_ferrata_scale', 'sac_scale', 'trail_visibility',
  'osmc:symbol', 'network', 'route',
  'addr:street', 'addr:city', 'addr:province',
  'wikipedia', 'wikidata',
]);

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/:/g, ' › ');
}

function formatTags(tags: Record<string, string>): string {
  return Object.entries(tags)
    .filter(([key]) => USEFUL_TAGS.has(key))
    .map(([key, value]) => `${humanizeKey(key)}: ${value}`)
    .join('\n');
}

export async function fetchOverpassData(input: AgentInput): Promise<SourceResult> {
  if (input.osm_id == null) {
    return { sourceName: 'OpenStreetMap', content: '', success: false };
  }

  const osmId = Number(input.osm_id);
  if (!Number.isFinite(osmId)) {
    return { sourceName: 'OpenStreetMap', content: '', success: false };
  }

  // Try all element types: huts can be nodes (point) or ways (building outline)
  const overpassQuery = `[out:json][timeout:10];(node(${osmId});way(${osmId});relation(${osmId}););out tags;`;

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(overpassQuery)}`,
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      return { sourceName: 'OpenStreetMap', content: '', success: false };
    }

    const data = (await response.json()) as OverpassResponse;
    const element = data.elements?.[0];

    if (!element || !element.tags || Object.keys(element.tags).length === 0) {
      return { sourceName: 'OpenStreetMap', content: '', success: false };
    }

    const formatted = formatTags(element.tags);
    if (!formatted) {
      return { sourceName: 'OpenStreetMap', content: '', success: false };
    }

    const osmType = element.type === 'relation' ? 'relation' : element.type === 'way' ? 'way' : 'node';
    const osmUrl = `https://www.openstreetmap.org/${osmType}/${element.id}`;
    return { sourceName: 'OpenStreetMap (tags)', content: formatted, success: true, url: osmUrl };
  } catch {
    return { sourceName: 'OpenStreetMap', content: '', success: false };
  }
}
