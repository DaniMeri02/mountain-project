# Bug Tracker — Mountain Project (Post-Vite Refactor Audit)

Full audit after static→Vite frontend migration. TypeScript typecheck: clean. Backend: clean (all BUGS.md items confirmed fixed).

---

## 🔴 CRITICAL

### B-15 · Playwright E2E tests all timeout — dev-mode static path wrong
**Files**: `playwright.config.ts`, `server.ts:514–517`

**Problem**: Two related issues that together make all 49 E2E tests fail:

1. `playwright.config.ts` has no `webServer` config — tests assume a server is already running on port 3000. If it isn't, `page.goto('/')` hangs until the 30-second timeout.

2. In dev mode, the server resolves static files to:
   ```ts
   path.join(__dirname, '../public')  // → C:\Users\danim\Desktop\public  (WRONG)
   ```
   `__dirname` is the project root when running via `tsx`, so `'../public'` goes one level up. The correct dev-mode path is `path.join(__dirname, 'public')` (or no static serving at all, delegating to Vite on :5173).

**Evidence**: Running `npx playwright test` without a prior server start: all 49 tests failed at exactly 30 s (timeout). Test 31 (`reload state matches loaded state`) failed in 492 ms — fast enough to confirm the server responded but returned non-HTML content (likely a static-serve error or 404).

**Fix**:
```ts
// playwright.config.ts — add webServer block
webServer: {
  command: 'npm run build && npm run start',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
},

// server.ts — fix dev-mode path
const staticRoot =
  process.env.NODE_ENV === 'production'
    ? path.join(__dirname, 'public')
    : path.join(__dirname, 'public');   // same: serve from project-root/public
```

Or, for the cleaner Vite-proxy approach in dev, add a reverse-proxy from `:3000` to `:5173` when `NODE_ENV !== 'production'`.

**Status**: ✅ Fixed — commit `e6e3e4a`

---

## 🟠 HIGH

### B-16 · OSM/Topo style: `setStyle` misses `{diff:false}` → slow full rebuild + sprite warning
**Files**: `src/map.ts:595,597`

**Problem**: Switching to OSM or Topo calls:
```ts
map.setStyle(buildOsmStyle() as mapboxgl.StyleSpecification);
```
Mapbox GL JS v3 tries to diff the current style against the new one. The custom styles have different `glyphs`/`sprite` configuration, which triggers the unimplemented diff operations:
```
Unable to perform style diff: Unimplemented: setSprite, setGlyphs.. Rebuilding the style from scratch.
```
Mapbox then does a full rebuild anyway, but the warning is confusing and the transition is slower than necessary. The `ERR_NETWORK_CHANGED` tile errors reported by the user are separate (transient network issue), but the root cause of "OSM doesn't work" is this rebuild path being triggered unexpectedly.

Additionally, `buildOsmStyle()` and `buildTopoStyle()` omit a `sprite` field. Mapbox GL JS expects `sprite: ''` to signal "no sprite" on a custom style. Without it, symbol layers added by `addMapLayers` after `style.load` may miss their icon images on some Mapbox GL JS versions.

**Fix**:
```ts
// src/map.ts — pass {diff:false} and add sprite field to custom styles

export function buildOsmStyle(): object {
  return {
    version: 8,
    sprite: '',                          // ← add
    glyphs: '...mapbox...{fontstack}...?access_token=' + mapboxgl.accessToken,
    sources: { osm: { ... } },
    layers: [{ id: 'osm-raster', type: 'raster', source: 'osm' }],
  };
}

export function buildTopoStyle(): object {
  return {
    version: 8,
    sprite: '',                          // ← add
    glyphs: '...mapbox...{fontstack}...?access_token=' + mapboxgl.accessToken,
    sources: { opentopo: { ... } },
    layers: [{ id: 'opentopo-raster', type: 'raster', source: 'opentopo' }],
  };
}

// setupStyleSwitcher — force full rebuild, skip diff attempt
if (currentMode === 'opentopo') {
  map.setStyle(buildTopoStyle() as mapboxgl.StyleSpecification, { diff: false });
} else if (currentMode === 'osm') {
  map.setStyle(buildOsmStyle() as mapboxgl.StyleSpecification, { diff: false });
}
```

**Status**: ✅ Fixed — commit `ac9c0ba`

---

### B-17 · Routing debug functions attached to `window` in production
**Files**: `src/routing/index.ts:53–94`

**Problem**: `window.__debugRoute` and `window.__debugGaps` are attached unconditionally:
```ts
(window as Window & { __debugRoute?: unknown }).__debugRoute = async (...) => { ... };
(window as Window & { __debugGaps?: unknown }).__debugGaps = (...) => { ... };
```
This exposes internal routing graph state (node coordinates, edge count, component sizes) in the production bundle. Any user with DevTools can call these.

**Fix**:
```ts
if (import.meta.env.DEV) {
  (window as Window & { __debugRoute?: unknown }).__debugRoute = async (...) => { ... };
  (window as Window & { __debugGaps?: unknown }).__debugGaps = (...) => { ... };
}
```

**Status**: ✅ Fixed — commit `0a3ea8b`

---

## 🟡 MEDIUM

### B-18 · Event listener accumulation in `routing/mode.ts`
**Files**: `src/routing/mode.ts`

**Problem**: `startRoutingMode` attaches `map.on('click', _clickHandler)` and `document.addEventListener('keydown', _keyHandler)`. If `startRoutingMode` is called again (e.g. user re-opens routing without closing), handlers stack — each click fires the handler N times.

`cancelRoutingMode` does remove the handlers, but there is no guard that prevents `startRoutingMode` from running twice without a cancel in between.

**Fix**:
```ts
export function startRoutingMode(map: mapboxgl.Map, ...) {
  cancelRoutingMode();     // ← idempotent teardown before setup
  ...
}
```

**Status**: ✅ Fixed — commit `fa27f3f`

---

### B-19 · Non-null assertion on canvas `getContext` in `search.ts`
**Files**: `src/search.ts:82`

**Problem**:
```ts
const ctx = measureCanvas.getContext('2d')!;
```
`getContext('2d')` can return `null` (browser with canvas disabled, privacy mode, some headless environments). The `!` hides the failure; subsequent calls on `null` throw a `TypeError` that bubbles up through the placeholder-sync logic and silently breaks placeholder truncation.

**Fix**:
```ts
const ctx = measureCanvas.getContext('2d');
if (!ctx) return 0;
```

**Status**: ✅ Fixed — commit `3b40173`

---

### B-20 · Silent icon load failures — no `onerror` handler
**Files**: `src/icons.ts:18–20`

**Problem**:
```ts
const img = new Image();
img.src = customIcons[id];
img.onload = () => { if (!map.hasImage(id)) map.addImage(id, img); };
// No onerror
```
If any SVG icon fails to load (404, CORS, corrupt file), `map.addImage` is never called for that icon. The map renders without the corresponding marker type (huts, peaks, or bivouacs) with no error in the console.

**Fix**:
```ts
img.onerror = () => console.error(`[icons] Failed to load icon: ${id}`);
```

**Status**: ✅ Fixed — commit `40b7bd3`

---

### B-21 · Unhandled promise rejection on `navigator.permissions.query`
**Files**: `src/offline/area.ts:107–108`

**Problem**:
```ts
navigator.permissions.query({ name: 'geolocation' }).then((status) => { ... });
// No .catch()
```
`permissions.query` can reject (e.g. Firefox Private Browsing, some iOS versions). Without a catch, this is an unhandled promise rejection — shows a browser console warning and may bubble as an unhandled rejection event.

**Fix**:
```ts
navigator.permissions.query({ name: 'geolocation' })
  .then((status) => { ... })
  .catch(() => {});
```

**Status**: ✅ Fixed — pre-existing (area.ts already had catch)

---

### B-22 · `fetchAiModels` pre-warm is fire-and-forget without error handling
**Files**: `src/ui.ts:155`

**Problem**:
```ts
fetchAiModels(); // pre-warm on module load
```
If the server is not yet ready when the frontend initialises (race at startup), `fetchAiModels` rejects and `cachedAiModels` stays `null`. The first "Genera AI Guide" open then has no model list and falls back silently — the user sees an empty model selector.

**Fix**:
```ts
fetchAiModels().catch(() => {}); // silently pre-warm; caller re-fetches on first use
```
Or, tie the pre-warm call to `map.on('load')` so it fires after the server is confirmed ready.

**Status**: ✅ Fixed — commit `4cb2935`

---

## 🟡 MEDIUM — Architecture / Test coverage gap

### B-23 · No E2E test coverage for offline area flow, routing, or AI Guide panel
**Files**: `tests/e2e/`

**Problem**: After the Vite migration the test suite covers basemap switching, search, nav drawer, POI panel, and map pin. The following UI flows have **zero** Playwright coverage:

| Flow | Risk |
|------|------|
| Download offline area (modal → progress → saved list) | IDB + download logic changed |
| Routing (from→to selection, route rendered on map) | `src/routing/` is new TS |
| AI Guide generation (`/api/ai/research` full round-trip) | Sanitisation, cache indicator |
| Overlay toggle (trails/ferrata visibility) | Layer visibility after style change |

**Fix**: Add E2E specs for each flow, mocking external API calls (`page.route`).

**Status**: ❌ Open (test authoring needed)

---

## 🟢 LOW

### B-24 · `heapPop` in `routing/graph.ts` has no empty-heap guard
**Files**: `src/routing/graph.ts:269–286`

**Problem**:
```ts
function heapPop(heap: [number, string][]): [number, string] {
  const top = heap[0];   // undefined if heap is empty
  const last = heap.pop()!;  // non-null assertion hides potential undefined
  ...
  return top;  // returns undefined
}
```
Currently unreachable (Dijkstra only pops when the heap is non-empty). But a future caller bypassing that invariant would get `[undefined, undefined]` without a type error.

**Fix**:
```ts
if (heap.length === 0) return [Infinity, ''];
```

**Status**: ✅ Fixed — commit `3dbe077`

---

### B-25 · `incrTileRefs` IDB transaction may expire under slow iteration
**Files**: `src/offline/idb.ts:103–113`

**Problem**:
```ts
for (const url of urls) {
  const existing = await reqAsPromise<TileRef | undefined>(store.get(url));
  await reqAsPromise(store.put(next));
}
```
IndexedDB transactions auto-commit when the event loop drains with no pending IDB requests. In a `for…await` loop, each microtask handoff between `store.get` and `store.put` theoretically risks the transaction becoming inactive — though in practice V8 keeps it alive because the next `store.get` is created before the microtask queue is truly empty.

The risk is real on Safari (stricter IDB transaction lifetime). A safer pattern uses a single `readwrite` transaction created outside the loop and fires all requests without yielding.

**Fix**: Batch with a single transaction or use `Promise.all` on the requests rather than sequential `await`.

**Status**: ✅ Fixed — commit `5d895a4`

---

## Files to modify

| File | Bug(s) |
|------|--------|
| `playwright.config.ts` | B-15: add `webServer` |
| `server.ts` | B-15: fix dev-mode `staticRoot` |
| `src/map.ts` | B-16: `{diff:false}` + `sprite:''` |
| `src/routing/index.ts` | B-17: DEV guard on `window.__debug*` |
| `src/routing/mode.ts` | B-18: idempotent `cancelRoutingMode` on start |
| `src/search.ts` | B-19: null check on `getContext('2d')` |
| `src/icons.ts` | B-20: `img.onerror` handler |
| `src/offline/area.ts` | B-21: `.catch(()=>{})` on permissions query |
| `src/ui.ts` | B-22: `.catch(()=>{})` on pre-warm |
| `src/routing/graph.ts` | B-24: empty-heap guard in `heapPop` |
| `src/offline/idb.ts` | B-25: IDB transaction lifetime |
| `tests/e2e/` | B-23: new E2E specs |
