# Bug Tracker — Mountain Project (Second Audit, Post-Vite Refactor)

Full audit after BUGS-2.md fixes. All findings verified by reading the actual code — false positives from automated analysis excluded.

---

## 🟠 HIGH

### B-26 · `writeSourcesDump` if/else branches are identical — rotation logic dead
**Files**: `agent/orchestrator.ts:181–190`

**Problem**: Both branches of the if/else write identically:
```ts
if (fileStat && fileStat.size > DUMP_MAX_BYTES) {
  await writeFile(DUMP_FILE, content, 'utf8');  // ← same
} else {
  await writeFile(DUMP_FILE, content, 'utf8');  // ← same
}
```
The intent was to truncate/rotate the dump file when it grows too large. The rotation never triggers — both paths always overwrite. The file stays bounded only because overwrite is the default behavior, not because the size check does anything.

**Fix**:
```ts
// Only write if no file yet, or file has grown past the cap (rotate by overwrite)
if (!fileStat || fileStat.size > DUMP_MAX_BYTES) {
  await writeFile(DUMP_FILE, content, 'utf8');
} else {
  await appendFile(DUMP_FILE, content, 'utf8');  // keep history when small
}
```
Or, if the intent was always-overwrite: delete the if/else and just call `writeFile`.

**Status**: ✅ Fixed

---

### B-27 · `sanitizeAiHtml` XSS gap — `<iframe>`, `<embed>`, `data:` URIs not stripped
**Files**: `src/ui.ts:113–117`

**Problem**: The sanitizer only removes `<script>` tags and `on*=` event handlers:
```ts
function sanitizeAiHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, '')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '');
}
```
A malicious AI response can still inject:
- `<iframe src="https://attacker.com">` — loads external content
- `<embed src="data:text/html,...">` — executes arbitrary HTML
- `<img src="x" onerror="…">` — regex misses `onerror` at start of attribute list
- `javascript:` URIs in href/action attributes
- `<svg onload="…">` or `<video autoplay>` vectors

**Fix**: Replace the hand-rolled regex with [DOMPurify](https://github.com/cure53/DOMPurify):
```ts
import DOMPurify from 'dompurify';

function sanitizeAiHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
```
Install: `npm install dompurify @types/dompurify`

**Status**: ✅ Fixed

---

## 🟡 MEDIUM

### B-28 · `haversineMeters` duplicated between `graph.ts` and `highlight.ts`
**Files**: `src/routing/graph.ts`, `src/routing/highlight.ts:8–17`

**Problem**: `haversineMeters` is implemented twice with the same formula in two sibling files. If the implementation diverges (precision tweak, sign fix), routing distances and arrow-spacing will disagree silently.

**Fix**: Export from `graph.ts` (already done — it's exported) and import in `highlight.ts`:
```ts
// highlight.ts — remove local haversineMeters and add:
import { haversineMeters } from './graph';
```

**Status**: ✅ Fixed

---

### B-29 · `komoot.ts` fallback tour fetch is sequential — adds ~N×15s worst-case latency
**Files**: `agent/sources/komoot.ts:87–91`

**Problem**: `fetchNearbyFallbackTours` iterates up to 6 highlights and awaits each `fetchTours()` in sequence:
```ts
for (const h of ordered.slice(0, 6)) {
  const tours = await fetchTours(h.id);   // serial — blocks on each 15s timeout
  if (tours.length > 0) return { tours, sourceHighlight: h };
}
```
If the first 3 highlights return empty (no tours), 3 × 15s = 45s wasted before checking highlights 4-6. This blocks the entire AI source cascade.

**Fix**: Fetch all 6 in parallel with `Promise.all`, then pick the first non-empty result:
```ts
const results = await Promise.all(
  ordered.slice(0, 6).map(async h => ({ h, tours: await fetchTours(h.id) }))
);
const hit = results.find(r => r.tours.length > 0);
if (hit) return { tours: hit.tours, sourceHighlight: hit.h };
return { tours: [], sourceHighlight: null };
```

**Note**: This fetches all 6 concurrently even if the first succeeds. Acceptable tradeoff vs. serial blocking on timeouts.

**Status**: ✅ Fixed

---

### B-30 · `snapToNode` and `nearestNodes` are O(n) linear scans — no spatial index
**Files**: `src/routing/graph.ts:231–255`

**Problem**: Both functions iterate every node on every call:
```ts
for (const [key, node] of graph.nodes) {
  const d = haversineMeters(coord, node.coord);
  ...
}
```
For a typical Alpine trail network in this bbox (estimated 5k–50k nodes), each routing request triggers 1–2 full scans. At 50k nodes × 2 calls, that's ~100k haversine calculations per route request.

**Fix**: Build a spatial grid index in `buildGraph()` — bucket nodes by rounded lng/lat cell:
```ts
const GRID_DEG = 0.01; // ~1km cell
const spatialIndex = new Map<string, string[]>();
// on node insert:
const cell = `${Math.floor(coord[0]/GRID_DEG)}_${Math.floor(coord[1]/GRID_DEG)}`;
```
Then `snapToNode` only searches cells within radius instead of all nodes. For a 1km search radius the scan drops from O(n) to O(~16 cells × local density).

**Status**: ✅ Fixed (perf; low impact on small datasets, notable on large national imports)

---

### B-31 · `parseBBox` accepts out-of-range geographic coordinates
**Files**: `server.ts:46–61`

**Problem**: `parseBBox` validates ordering (`minLng < maxLng`, `minLat < maxLat`) but not geographic range. Values like `minLng = -999` pass silently and generate valid SQL queries against PostGIS, which clips or errors internally.

**Fix**:
```ts
if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) return null;
```

**Status**: ✅ Fixed (low exploit risk on local app; still incorrect input acceptance)

---

## 🟢 LOW

### B-32 · Fastify logger unconditional — logs sensitive query params and tokens in production
**Files**: `server.ts:9`

**Problem**: `Fastify({ logger: true })` logs every request including full URLs, query strings, and response bodies in plaintext. In production this means `/api/config` responses (containing `MAPBOX_TOKEN`) and `/api/search?q=...` queries appear in stdout/log files.

**Fix**:
```ts
const fastify = Fastify({
  logger: process.env.NODE_ENV !== 'production',
});
```
Or use Fastify's redact option to strip sensitive fields.

**Status**: ✅ Fixed

---

### B-33 · `withToken` builds Mapbox URLs by string concatenation — fragile against double-`?`
**Files**: `src/offline/tile-urls.ts:84–87`

**Problem**:
```ts
function withToken(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'access_token=' + mapboxgl.accessToken;
}
```
Manual `?`/`&` detection fails if a URL already has a fragment (`#`) or trailing `?`. URL construction should use the `URL` API:
```ts
function withToken(url: string): string {
  const u = new URL(url);
  u.searchParams.set('access_token', mapboxgl.accessToken);
  return u.toString();
}
```

**Status**: ✅ Fixed

---

### B-34 · `reloadPrompt()` exported but never called — dead export with stale comment
**Files**: `agent/prompt-loader.ts:17–20`

**Problem**:
```ts
/** Force re-read the file on the next call to loadAgentPrompt(). */
export function reloadPrompt(): void {
  cachedPrompt = null;
}
```
The comment says "Call reloadPrompt() if you want hot-reload without restarting the server" but no caller exists. Either wire it to a `POST /api/reload-prompt` endpoint or remove the export and comment.

**Status**: ✅ Fixed (dead code)

---

### B-35 · Map initial center/zoom not persisted — resets to Italian Alps on every reload
**Files**: `src/main.ts:71–78`

**Problem**: Map always initializes to hardcoded `center: [9.64, 46.26], zoom: 12`. If a user pans to a different area (e.g., Dolomites), the position is lost on page reload.

**Fix**: Persist/restore from `localStorage` on map `moveend`/`zoomend`:
```ts
// on moveend:
localStorage.setItem('map:center', JSON.stringify(map.getCenter()));
localStorage.setItem('map:zoom', String(map.getZoom()));

// on init:
const savedCenter = JSON.parse(localStorage.getItem('map:center') ?? 'null');
const savedZoom = Number(localStorage.getItem('map:zoom') ?? '12');
```

**Status**: ✅ Fixed (UX improvement)

---

## Files to modify

| File | Bug(s) |
|------|--------|
| `agent/orchestrator.ts` | B-26: fix writeSourcesDump rotation logic |
| `src/ui.ts` | B-27: replace sanitizeAiHtml with DOMPurify |
| `src/routing/highlight.ts` | B-28: import haversineMeters from graph.ts |
| `agent/sources/komoot.ts` | B-29: parallelize fetchTours fallback |
| `src/routing/graph.ts` | B-30: add spatial grid index to snapToNode |
| `server.ts` | B-31: add geographic bounds check in parseBBox; B-32: conditional logger |
| `src/offline/tile-urls.ts` | B-33: use URL API in withToken |
| `agent/prompt-loader.ts` | B-34: wire reloadPrompt to endpoint or remove |
| `src/main.ts` | B-35: persist map position to localStorage |
