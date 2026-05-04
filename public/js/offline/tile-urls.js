import { enumerateTiles } from '../tile-math.js';

const OPENTOPO_SUBDOMAINS = ['a', 'b', 'c'];
const OSM_SUBDOMAINS = ['a', 'b', 'c'];
const MAPBOX_STYLE = 'mapbox/outdoors-v12';
const GLYPH_RANGES = [
  [0, 255],
  // Mapbox glyph PBFs are stored in 256-unit ranges. Keep Latin only by default.
];

function opentopoUrl(z, x, y, idx) {
  const sub = OPENTOPO_SUBDOMAINS[idx % OPENTOPO_SUBDOMAINS.length];
  return `https://${sub}.tile.opentopomap.org/${z}/${x}/${y}.png`;
}

// Throttled fetch queue. concurrency = max in-flight, minIntervalMs = floor between dispatches.
export async function throttledFetchAll(urls, concurrency, minIntervalMs, onProgress) {
  let cursor = 0;
  let done = 0;
  let lastDispatch = 0;
  const failures = [];

  async function worker() {
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
        failures.push({ url, error: err && err.message ? err.message : String(err) });
      }
      done++;
      if (onProgress) onProgress(done, urls.length);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return { failures };
}

export function buildOpentopoUrls(bbox, zMin, zMax) {
  const urls = [];
  let i = 0;
  for (const { z, x, y } of enumerateTiles(bbox, zMin, zMax)) {
    urls.push(opentopoUrl(z, x, y, i++));
  }
  return urls;
}

function osmUrl(z, x, y, idx) {
  const sub = OSM_SUBDOMAINS[idx % OSM_SUBDOMAINS.length];
  return `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

export function buildOsmUrls(bbox, zMin, zMax) {
  const urls = [];
  let i = 0;
  for (const { z, x, y } of enumerateTiles(bbox, zMin, zMax)) {
    urls.push(osmUrl(z, x, y, i++));
  }
  return urls;
}

function withToken(url) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'access_token=' + mapboxgl.accessToken;
}

function httpsify(url) {
  return url.replace(/^http:\/\//, 'https://');
}

function fillTileTemplate(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function uniqueFontstacks(styleJson) {
  const stacks = new Set();
  for (const layer of styleJson.layers || []) {
    const stack = layer.layout && layer.layout['text-font'];
    if (Array.isArray(stack)) {
      stacks.add(stack.join(','));
    }
  }
  return Array.from(stacks);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.json();
}

// Resolve a `mapbox://fonts/{user}/{fontstack}/{range}.pbf` template into HTTPS form,
// preserving the {user} segment from the style (avoids dropping the username prefix).
function glyphsTemplateToHttps(glyphsUrl) {
  if (!glyphsUrl) return null;
  if (glyphsUrl.startsWith('mapbox://fonts/')) {
    return 'https://api.mapbox.com/fonts/v1/' + glyphsUrl.slice('mapbox://fonts/'.length);
  }
  return httpsify(glyphsUrl);
}

export async function buildMapboxUrls(bbox, zMin, zMax) {
  const urls = new Set();

  // 1. Style JSON
  const styleUrl = withToken(`https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}`);
  urls.add(styleUrl);
  const styleJson = await fetchJson(styleUrl);

  // 2. Tile sources (vector / raster / raster-dem) — resolve TileJSON, enumerate tiles.
  // Mapbox TileJSON returns templates on `*.tiles.mapbox.com` over HTTP — must be rewritten
  // to HTTPS or the page (served HTTPS) blocks them as mixed content.
  const sources = styleJson.sources || {};
  for (const sourceId of Object.keys(sources)) {
    const src = sources[sourceId];
    if (!['vector', 'raster', 'raster-dem'].includes(src.type)) continue;
    if (!src.url || !src.url.startsWith('mapbox://')) continue;
    const id = src.url.replace('mapbox://', '');
    const tileJsonUrl = withToken(`https://api.mapbox.com/v4/${id}.json`);
    urls.add(tileJsonUrl);
    const tileJson = await fetchJson(tileJsonUrl);
    const rawTemplate = tileJson.tiles && tileJson.tiles[0];
    if (!rawTemplate) continue;
    const template = httpsify(rawTemplate);
    const sourceMin = Math.max(zMin, tileJson.minzoom ?? 0);
    const sourceMax = Math.min(zMax, tileJson.maxzoom ?? zMax);
    if (sourceMin > sourceMax) continue;
    for (const { z, x, y } of enumerateTiles(bbox, sourceMin, sourceMax)) {
      urls.add(fillTileTemplate(template, z, x, y));
    }
  }

  // 3. Sprite (1x + 2x, png + json)
  if (styleJson.sprite) {
    const spriteBase = styleJson.sprite.startsWith('mapbox://sprites/')
      ? `https://api.mapbox.com/styles/v1/${styleJson.sprite.replace('mapbox://sprites/', '')}/sprite`
      : httpsify(styleJson.sprite);
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
