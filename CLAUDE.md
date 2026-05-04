# Mountain Portal — Project Context for Claude Code

## What this project is

A local web portal for exploring mountain huts, bivouacs, peaks, and via ferrata in the Italian Alps (focus: Bergamo/Lombardy area). The user is learning TypeScript through this project.

## Tech stack

- **Backend**: Node.js + Fastify v5 + TypeScript (tsx for dev, esbuild for build)
- **Database**: PostgreSQL (port 5433, db: `mountain_db`, user: `mountain_worker`) + PostGIS
- **Frontend**: Vanilla JS (ES modules) + Mapbox GL JS v3 + PWA (service worker + manifest)
- **AI Agent**: Groq / Gemini / OpenRouter (OpenAI-compatible API) — 8-model cascade in `agent/orchestrator.ts`
- **Testing**: Vitest (unit/integration) + Playwright (E2E)

## Running the project

```bash
npm run dev           # start dev server at http://localhost:3000
npm run build         # esbuild → dist/server.js
npm run start         # node dist/server.js (production)
npm run migrate:ai    # create ai_description_cache table (run once per DB instance)
npm run fetch:data    # fetch POIs from Overpass API
npm run fetch:ferrata # fetch via ferrata routes
npm run import:ferrata # import via ferrata into DB
npm run export:ferrata # snapshot via ferrata to JSON
npm run test          # vitest run
npm run test:watch    # vitest watch
npm run test:coverage # coverage report
npm run typecheck     # tsc --noEmit
```

## PostgreSQL tables

| Table | Content |
|---|---|
| `pois` | Peaks, huts, bivouacs — id, osm_id, type, name, elevation, geom (Point) |
| `trails` | Hiking paths — id, osm_id, name, sac_scale, geom (LineString) |
| `via_ferrata` | Via ferrata routes — id, osm_id, name, via_ferrata_scale, sac_scale, source_type, geom |
| `ai_description_cache` | AI-generated descriptions — cache_key (SHA256), poi_name, poi_type, description, sources (JSONB), generated_at, expires_at (48h TTL) |

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/pois` | POIs in bbox |
| GET | `/api/trails` | Trails in bbox |
| GET | `/api/ferrata` | Via ferrata in bbox |
| GET | `/api/search` | Autocomplete search (20 results max) |
| GET | `/api/offline/bundle` | Single round-trip download: all 3 datasets for offline mode (max 0.5° bbox) |
| GET | `/api/ai/models` | List available AI models `[{ slug, label }]` |
| POST | `/api/ai/research` | Generate AI description (cache-first) |
| POST | `/api/ai/research/regenerate` | Force-regenerate AI description (bypasses cache) |

`POST /api/ai/research` body: `{ name, type, elevation?, osm_id?, lat?, lng?, modelSlug? }`
Response: `{ description, fromCache, sources[], generatedAt, expiresAt, modelUsed? }`

## AI agent architecture

```
agent/
  types.ts                ← all TypeScript interfaces (no 'any')
  cache.ts                ← AiDescriptionCache class (get/set/invalidate)
  prompt-loader.ts        ← reads ai-agent-conf/agent-prompt.md (memory-cached per process)
  orchestrator.ts         ← main flow: parallel sources → AI cascade → cache → response
  sources/
    http.ts               ← shared fetchHtml() + SCRAPER_HEADERS utility
    wikidata.ts           ← Wikidata SPARQL (elevation, Wikipedia, description)
    overpass.ts           ← OSM extra tags via Overpass API (phone, hours, operator…)
    rifugi-scraper.ts     ← Cheerio scraper for rifugi.lombardia/bergamo/brescia/lecco
    ferrate365-scraper.ts ← Cheerio scraper for ferrate365.it
    youtube.ts            ← YouTube Data API v3 (skipped if YOUTUBE_API_KEY missing)
    reddit.ts             ← Reddit OAuth2 client credentials (skipped if keys missing)
    komoot.ts             ← Komoot native API: highlights, tours, tips (no auth required)
    apify.ts              ← runApifyActor() with 6-hour in-process cache
    facebook.ts           ← DISABLED — Apify credits exhausted
    tripadvisor.ts        ← DISABLED — Apify per-run charges too high
```

**AI model cascade** (ranked fallback order, tries next on 429/5xx):
1. `gemini-2.5-flash` (Google) — key: GEMINI_API_KEY
2. `qwen/qwen3-32b` (Groq) — key: GROQ_API_KEY
3. `llama-3.3-70b-versatile` (Groq)
4. `meta-llama/llama-4-scout-17b-16e-instruct` (Groq)
5. `openai/gpt-oss-120b` (Groq)
6. `gemini-2.5-flash-lite` (Google)
7. `google/gemma-4-31b-it:free` (OpenRouter) — key: OPENROUTER_API_KEY
8. `meta-llama/llama-3.3-70b-instruct:free` (OpenRouter)

**Flow**: `POST /api/ai/research` → check cache → if miss: run 7 active sources in parallel via `Promise.allSettled` → build context → call AI model (cascade) with system prompt from `agent-prompt.md` → store in DB cache → return `AgentResponse`.

Each source fails gracefully (`success: false`) without blocking the others. Debug dump written to `agent-sources-dump.txt` on each request.

## Environment variables (.env)

```
GROQ_API_KEY=          # required — free at console.groq.com
GEMINI_API_KEY=        # optional — Google Gemini (first in cascade)
OPENROUTER_API_KEY=    # optional — OpenRouter fallback
YOUTUBE_API_KEY=       # optional — YouTube Data API v3
REDDIT_CLIENT_ID=      # optional — Reddit script app
REDDIT_CLIENT_SECRET=  # optional — Reddit script app
APIFY_TOKEN=           # optional — Facebook/TripAdvisor (currently disabled sources)
DB_USER=mountain_worker
DB_PASSWORD=mountain_secret_123
DB_HOST=localhost
DB_PORT=5433
DB_NAME=mountain_db
```

Copy `.env.example` → `.env` and fill in keys. `.env` is gitignored.

## Editable AI prompt

`ai-agent-conf/agent-prompt.md` is the system prompt. Edit it freely to change what the AI searches for, the output format, tone, etc. Changes take effect immediately (no server restart needed).

## Frontend structure

```
public/
  index.html              ← single page app
  manifest.webmanifest    ← PWA manifest
  sw.js                   ← service worker (offline tile + asset caching)
  css/style.css
  icons/icon-192.png, icon-512.png
  js/
    main.js               ← Mapbox map init, fullscreen toggle
    map.js                ← layers, data fetching, interactivity
    search.js             ← autocomplete search bar
    ui.js                 ← panel rendering, AI Guide section
    nav.js                ← navigation drawer open/close
    icons.js              ← custom map marker icons
    offline.js            ← IndexedDB offline area manager + downloader
    elevation.js          ← elevation profile handling
    tile-math.js          ← tile coordinate calculations for offline caching
```

The AI Guide section in `ui.js` (`updatePanel` function):
- "Genera AI Guide" button → calls `/api/ai/research`
- "Rigenera descrizione" button → calls `/api/ai/research/regenerate`
- Shows cache status (📦 Da cache / ✨ Generato ora), sources used, expiry time
- Passes `osm_id`, `lat`, `lng`, `elevation`, `name`, `type`, optional `modelSlug` to the API

## Testing

```
tests/
  server.test.ts            ← server endpoint integration tests
  orchestrator.test.ts      ← AI agent flow tests
  cache.test.ts             ← cache unit tests
  offline-bundle.spec.ts    ← offline bundle tests
  offline-tile-math.spec.ts ← tile math tests
  sources/
    wikidata.test.ts
    komoot.test.ts
  e2e/
    basemap.spec.ts           ← Playwright basemap tests
    search-placeholder.spec.ts ← Playwright search tests
  fixtures/                   ← JSON fixtures for mocked API responses
```

## Coding rules (important)

- **No `any` in TypeScript** — always use explicit types
- Follow existing code style (no semicolons policy is NOT in effect here — server.ts uses semicolons)
- Keep code lean: no speculative abstractions, no unused helpers
- The project uses `"type": "commonjs"` — backend imports have no `.js` extension

## What's planned / not yet done

- Google Places API integration (waiting for user to enable billing)
- Facebook + TripAdvisor sources re-enable when Apify credits are replenished
- No authentication — this is a local personal tool

## Key files to read when starting a new task

- `server.ts` — entry point, all routes
- `agent/orchestrator.ts` — AI agent main flow + model cascade
- `agent/types.ts` — all TypeScript types
- `public/js/ui.js` — frontend panel and AI interaction
- `public/js/offline.js` — offline area management
