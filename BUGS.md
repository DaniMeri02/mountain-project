# Bug Tracker — Mountain Project

Complete audit findings. Each entry: severity, file:line, description, fix applied.

---

## 🔴 CRITICAL — Fixed

### B-01 · Missing `return` in server error handlers
**Files**: `server.ts:185, 207, 224, 406`  
**Problem**: `reply.status(500).send()` called without `return` in the catch blocks of `/api/trails`, `/api/ferrata`, `/api/pois`, and `/api/search`. In Fastify v5, the async handler's *return value* determines the response — calling `reply.send()` without returning it lets execution continue and Fastify attempts a second response, throwing "Reply was already sent."  
**Fix**: Added `return reply.status(500).send(...)` in all four handlers.  
**Status**: ✅ Fixed

---

### B-02 · Hardcoded Mapbox access token in source code
**Files**: `src/main.ts:19`  
**Problem**: `mapboxgl.accessToken = 'pk.eyJ1IjoiZGFuaW1lcmkiLCJhIjoiY21uZzFhaWdpMDIyajJyczY4YWFudzJ2ZyJ9.CbG1-cZKowq0cF8qCw2RDw'` — token hardcoded, committed to git. Anyone with repo access can use it for billable tile requests.  
**Fix**: Token moved to `MAPBOX_TOKEN` env var. Added `/api/config` endpoint. Frontend fetches token on init via async IIFE before creating the map.  
**Action needed**: Add `MAPBOX_TOKEN=<your token>` to your `.env` file.  
**Status**: ✅ Fixed

---

### B-03 · SQL injection pattern in cache.ts
**Files**: `agent/cache.ts:55, 62`  
**Problem**: `make_interval(hours => ${CACHE_TTL_HOURS})` — template literal interpolation in SQL string. Currently safe (constant), but the pattern is dangerous. If this constant ever becomes dynamic or user-controlled, it is directly injectable.  
**Fix**: Replaced with `INTERVAL '48 hours'` (literal, no interpolation). `RETURNING expires_at` added so the caller gets the DB-computed timestamp without a separate read.  
**Status**: ✅ Fixed

---

## 🟠 HIGH — Fixed

### B-04 · Redundant cache read-after-write in orchestrator
**Files**: `agent/orchestrator.ts:282-283`  
**Problem**: After writing to cache with `cache.set()`, a second DB query `cache.get(cacheKey)` was immediately issued to read back `expiresAt`. This extra round-trip is wasteful and, under concurrent writes, could race.  
**Fix**: `cache.set()` now returns `expiresAt` directly via `RETURNING expires_at`. The orchestrator uses the returned value — no second query.  
**Status**: ✅ Fixed

---

### B-05 · `writeFileSync` blocks event loop on every AI request
**Files**: `agent/orchestrator.ts:176`  
**Problem**: `writeFileSync(DUMP_FILE, ...)` is synchronous I/O called inside every AI generation request. This stalls the Node.js event loop for the duration of the disk write, blocking all concurrent requests.  
**Fix**: Replaced with `writeFile` from `fs/promises` (async, non-blocking). Added dev-only guard (`NODE_ENV !== 'production'`). Added 1 MB size cap before write to prevent unbounded disk growth.  
**Status**: ✅ Fixed

---

### B-06 · Null-unsafe accesses in reddit.ts
**Files**: `agent/sources/reddit.ts:84-85`  
**Problem**: `d.selftext.trim()` and `d.created_utc * 1000` — `selftext` is typed as `string` but the Reddit API can return `null` for deleted or removed posts. `created_utc` is `number` in types but API occasionally returns `null` for certain post types.  
**Fix**: `d.selftext?.trim() ?? ''` and `typeof d.created_utc === 'number' ? d.created_utc * 1000 : Date.now()`.  
**Status**: ✅ Fixed

---

### B-07 · XSS risk from AI description via `innerHTML`
**Files**: `src/ui.ts:269`  
**Problem**: `resultContent.innerHTML = data.description ?? ''` — AI response injected directly into the DOM. A jailbroken or intercepted AI response containing `<script>` tags would execute in the browser.  
**Fix**: Added `sanitizeAiHtml()` — strips `<script>` tags and inline event handlers (`on*` attributes) before `innerHTML` assignment. DOMPurify would be more complete but requires a dependency; this covers the main attack vectors for a personal tool.  
**Status**: ✅ Fixed

---

### B-08 · ResearchBody schema accepts any type for `elevation` and `osm_id`
**Files**: `server.ts:429-430`  
**Problem**: `elevation: {}` and `osm_id: {}` in the Fastify JSON schema validate as any type. Arrays, objects, booleans all pass through — no rejection at the boundary.  
**Fix**: `elevation: { type: ['number', 'null'] }` and `osm_id: { type: ['string', 'integer', 'null'] }`. Added `modelSlug` validation against known `AI_MODELS` slugs — returns 400 with valid options if slug is unknown.  
**Status**: ✅ Fixed

---

## 🟡 MEDIUM — Fixed

### B-09 · Missing AbortController in `fetchDynamicData`
**Files**: `src/map.ts`  
**Problem**: Pan/zoom events trigger `fetchDynamicData`. The old `latestFetchToken` approach correctly discards stale responses, but the underlying HTTP requests continue to completion — consuming server bandwidth and executing DB queries for data that will never be used.  
**Fix**: Replaced token pattern with `AbortController`. Each new call aborts the previous in-flight fetch. `AbortError` handled silently in the catch block.  
**Status**: ✅ Fixed

---

### B-10 · Missing env vars in vitest.setup.ts
**Files**: `vitest.setup.ts`  
**Problem**: Test setup sets `GEMINI_API_KEY` but `GROQ_API_KEY` (the primary model in cascade), `OPENROUTER_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`, and `REDDIT_CLIENT_SECRET` were missing. Tests ran with wrong model priority.  
**Fix**: Added all missing keys with `test-*` placeholder values.  
**Status**: ✅ Fixed

---

### B-11 · No coverage thresholds configured
**Files**: `vitest.config.ts`  
**Problem**: `npm run test:coverage` produced no threshold enforcement — 0% coverage would pass. No visibility into regression in test coverage.  
**Fix**: Added `coverage` block with `lines: 60`, `branches: 50` thresholds. Provider set to `v8`.  
**Status**: ✅ Fixed

---

## 🟡 MEDIUM — Documented (not changed)

### B-12 · Lazy orchestrator initialization
**Files**: `server.ts:438-447`  
**Notes**: Intentional design — the comment explains startup should not fail if AI keys are missing. `AgentOrchestrator` constructor is synchronous and doesn't check API keys, so Node.js single-threaded model makes the `if (!orchestrator)` check safe from race conditions. Low impact. Not changed.

---

### B-13 · No rate limiting on AI endpoints
**Files**: `server.ts:/api/ai/research, /api/ai/research/regenerate`  
**Notes**: No per-IP or global rate limiting. Malicious user can exhaust API credits. Personal local tool, no external exposure. Not changed; add `@fastify/rate-limit` if exposed publicly.

---

### B-14 · No ESLint / `@typescript-eslint/no-floating-promises`
**Notes**: Unhandled promise rejections can occur silently (e.g. `writeFile` in dump, various fire-and-forget patterns). Adding `eslint` + `@typescript-eslint/no-floating-promises` would catch these statically. Not added to avoid scope creep; worth adding if the project grows.

---

## Files Modified

| File | Changes |
|------|---------|
| `server.ts` | B-01: `return` in 4 catch blocks; B-02: `/api/config` endpoint + MAPBOX_TOKEN; B-08: schema types + model slug validation |
| `agent/cache.ts` | B-03: INTERVAL literal; B-04: `RETURNING expires_at`, return `Date` |
| `agent/orchestrator.ts` | B-04: use returned expiresAt; B-05: async dump + dev-only guard + size cap |
| `agent/sources/reddit.ts` | B-06: null-safe selftext + created_utc |
| `src/main.ts` | B-02: async init, fetch token from /api/config |
| `src/ui.ts` | B-07: `sanitizeAiHtml()` before innerHTML |
| `src/map.ts` | B-09: AbortController replaces latestFetchToken |
| `vitest.setup.ts` | B-10: added missing env vars |
| `vitest.config.ts` | B-11: coverage thresholds |
| `.env.example` | B-02: added MAPBOX_TOKEN |
