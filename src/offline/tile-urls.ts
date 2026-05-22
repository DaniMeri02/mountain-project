import mapboxgl from 'mapbox-gl';
import { enumerateTiles } from '../tile-math';

const OPENTOPO_SUBDOMAINS = ['a', 'b', 'c'];
const OSM_SUBDOMAINS = ['a', 'b', 'c'];
const MAPBOX_STYLE = 'mapbox/outdoors-v12';
const GLYPH_RANGES: [number, number][] = [
  [0, 255],
  // Mapbox glyph PBFs are stored in 256-unit ranges. Keep Latin only by default.
];

function opentopoUrl(z: number, x: number, y: number, idx: number): string {
  const sub = OPENTOPO_SUBDOMAINS[idx % OPENTOPO_SUBDOMAINS.length];
  return `https://${sub}.tile.opentopomap.org/${z}/${x}/${y}.png`;
}

export interface FetchFailure {
  url: string;
  status?: number;
  error?: string;
}

// Throttled fetch queue. concurrency = max in-flight, minIntervalMs = floor between dispatches.
export async function throttledFetchAll(
  urls: string[],
  concurrency: number,
  minIntervalMs: number,
  onProgress?: (done: number, total: number) => void
): Promise<{ failures: FetchFailure[] }> {
  let cursor = 0;
  let done = 0;
  let lastDispatch = 0;
  const failures: FetchFailure[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= urls.length) return;

      const wait = Math.max(0, lastDispatch + minIntervalMs - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastDispatch = Date.now();

      const url = urls[idx];
      try {
        const res = await fetch(url, { mode: 'cors', referrerPolicy: 'origin' });
        if (!res.ok && res.status !== 0) failures.push({ url, status: res.status });
      } catch (err) {
        failures.push({ url, error: err instanceof Error ? err.message : String(err) });
      }
      done++;
      if (onProgress) onProgress(done, urls.length);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return { failures };
}

export function buildOpentopoUrls(bbox: [number, number, number, number], zMin: number, zMax: number): string[] {
  const urls: string[] = [];
  let i = 0;
  for (const { z, x, y } of enumerateTiles(bbox, zMin, zMax)) {
    urls.push(opentopoUrl(z, x, y, i++));
  }
  return urls;
}

function osmUrl(z: number, x: number, y: number, idx: number): string {
  const sub = OSM_SUBDOMAINS[idx % OSM_SUBDOMAINS.length];
  return `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

export function buildOsmUrls(bbox: [number, number, number, number], zMin: number, zMax: number): string[] {
  const urls: string[] = [];
  let i = 0;
  for (const { z, x, y } of enumerateTiles(bbox, zMin, zMax)) {
    urls.push(osmUrl(z, x, y, i++));
  }
  return urls;
}

function withToken(url: string): string {
  const u = new URL(url);
  u.searchParams.set('access_token', mapboxgl.accessToken);
  return u.toString();
}

function httpsify(url: string): string {
  return url.replace(/^http:\/\//, 'https://');
}

function fillTileTemplate(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

function uniqueFontstacks(styleJson: Record<string, unknown>): string[] {
  const stacks = new Set<string>();
  const layers = styleJson.layers;
  if (!Array.isArray(layers)) return Array.from(stacks);
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    const layout = (layer as Record<string, unknown>).layout;
    if (!layout || typeof layout !== 'object') continue;
    const stack = (layout as Record<string, unknown>)['text-font'];
    if (Array.isArray(stack)) {
      stacks.add((stack as string[]).join(','));
    }
  }
  return Array.from(stacks);
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// Resolve a `mapbox://fonts/{user}/{fontstack}/{range}.pbf` template into HTTPS form,
// preserving the {user} segment from the style (avoids dropping the username prefix).
function glyphsTemplateToHttps(glyphsUrl: unknown): string | null {
  if (!glyphsUrl || typeof glyphsUrl !== 'string') return null;
  if (glyphsUrl.startsWith('mapbox://fonts/')) {
    return 'https://api.mapbox.com/fonts/v1/' + glyphsUrl.slice('mapbox://fonts/'.length);
  }
  return httpsify(glyphsUrl);
}

export async function buildMapboxUrls(bbox: [number, number, number, number], zMin: number, zMax: number): Promise<string[]> {
  const urls = new Set<string>();

  // 1. Style JSON
  const styleUrl = withToken(`https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}`);
  urls.add(styleUrl);
  const styleJson = await fetchJson(styleUrl);

  // 2. Tile sources (vector / raster / raster-dem) — resolve TileJSON, enumerate tiles.
  // Mapbox TileJSON returns templates on `*.tiles.mapbox.com` over HTTP — must be rewritten
  // to HTTPS or the page (served HTTPS) blocks them as mixed content.
  const sources = styleJson.sources;
  if (sources && typeof sources === 'object') {
    for (const sourceId of Object.keys(sources as Record<string, unknown>)) {
      const src = (sources as Record<string, Record<string, unknown>>)[sourceId];
      if (!src || typeof src !== 'object') continue;
      if (!['vector', 'raster', 'raster-dem'].includes(src.type as string)) continue;
      const srcUrl = src.url;
      if (!srcUrl || typeof srcUrl !== 'string' || !srcUrl.startsWith('mapbox://')) continue;
      const id = srcUrl.replace('mapbox://', '');
      const tileJsonUrl = withToken(`https://api.mapbox.com/v4/${id}.json`);
      urls.add(tileJsonUrl);
      const tileJson = await fetchJson(tileJsonUrl);
      const tilesArr = tileJson.tiles;
      const rawTemplate = Array.isArray(tilesArr) ? (tilesArr[0] as string | undefined) : undefined;
      if (!rawTemplate) continue;
      const template = httpsify(rawTemplate);
      const sourceMin = Math.max(zMin, typeof tileJson.minzoom === 'number' ? tileJson.minzoom : 0);
      const sourceMax = Math.min(zMax, typeof tileJson.maxzoom === 'number' ? tileJson.maxzoom : zMax);
      if (sourceMin > sourceMax) continue;
      for (const { z, x, y } of enumerateTiles(bbox, sourceMin, sourceMax)) {
        urls.add(fillTileTemplate(template, z, x, y));
      }
    }
  }

  // 3. Sprite (1x + 2x, png + json)
  const sprite = styleJson.sprite;
  if (sprite && typeof sprite === 'string') {
    const spriteBase = sprite.startsWith('mapbox://sprites/')
      ? `https://api.mapbox.com/styles/v1/${sprite.replace('mapbox://sprites/', '')}/sprite`
      : httpsify(sprite);
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
      urls.add(withToken(spriteBase + suffix));
    }
  }

  // 4. Glyphs — Latin range only. Use the style's own glyphs template so the
  // `{user}` segment (e.g. `mapbox/`) is preserved instead of dropped.
  const glyphsTemplate = glyphsTemplateToHttps(styleJson.glyphs);
  if (glyphsTemplate) {
    const fontstacks = uniqueFontstacks(styleJson);
    for (const stack of fontstacks) {
      for (const [start, end] of GLYPH_RANGES) {
        const filled = glyphsTemplate
          .replace('{fontstack}', encodeURIComponent(stack))
          .replace('{range}', `${start}-${end}`);
        urls.add(withToken(filled));
      }
    }
  }

  return Array.from(urls);
}
