# Mountain Portal — Project Context for Claude Code

## What this project is

A local web portal for exploring mountain huts, bivouacs, peaks, and via ferrata in the Italian Alps (focus: Bergamo/Lombardy area). The user is learning TypeScript through this project.

## Tech stack

- **Backend**: Node.js + Fastify v5 + TypeScript (tsx for dev, esbuild for build)
- **Database**: PostgreSQL (port 5433, db: `mountain_db`, user: `mountain_worker`) + PostGIS
- **Frontend**: Vanilla JS (ES modules) + Mapbox GL JS v3
- **AI Agent**: Groq / OpenRouter (OpenAI-compatible API) — model list in `agent/orchestrator.ts`

## Running the project

```bash
npm run dev          # start dev server at http://localhost:3000
npm run migrate:ai   # create ai_description_cache table (run once per DB instance)
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
| GET | `/api/search` | Autocomplete search |
| POST | `/api/ai/research` | Generate AI description (cache-first) |
| POST | `/api/ai/research/regenerate` | Force-regenerate AI description (bypasses cache) |

## AI agent architecture

```
agent/
  types.ts              ← all TypeScript interfaces (no 'any')
  cache.ts              ← AiDescriptionCache class (get/set/invalidate)
  prompt-loader.ts      ← reads ai-agent-conf/agent-prompt.md (memory-cached per process)
  orchestrator.ts       ← main flow: parallel sources → AI model (Groq/OpenRouter) → cache → response
  sources/
    wikidata.ts         ← Wikidata SPARQL (elevation, Wikipedia, description)
    overpass.ts         ← OSM extra tags via Overpass API (phone, hours, operator…)
    rifugi-scraper.ts   ← Cheerio scraper for rifugi.lombardia/bergamo/brescia/lecco
    ferrate365-scraper.ts ← Cheerio scraper for ferrate365.it
    youtube.ts          ← YouTube Data API v3 (skipped if YOUTUBE_API_KEY missing)
    reddit.ts           ← Reddit OAuth2 client credentials (skipped if keys missing)
```

**Flow**: `POST /api/ai/research` → check cache → if miss: run all sources in parallel via `Promise.allSettled` → build context → call AI model (Groq/OpenRouter) with system prompt from `agent-prompt.md` → store in DB cache → return `AgentResponse`.

Each source fails gracefully (returns `success: false`) without breaking the others.

## Environment variables (.env)

```
GROQ_API_KEY=          # required — free at console.groq.com → API Keys
OPENROUTER_API_KEY=    # optional — free at openrouter.ai/keys (OpenRouter fallback)
YOUTUBE_API_KEY=       # optional — YouTube Data API v3
REDDIT_CLIENT_ID=      # optional — Reddit script app
REDDIT_CLIENT_SECRET=  # optional — Reddit script app
# GOOGLE_PLACES_API_KEY=  # future — enable when billing is ready
```

Copy `.env.example` → `.env` and fill in keys. `.env` is gitignored.

## Editable AI prompt

`ai-agent-conf/agent-prompt.md` is the system prompt. Edit it freely to change what the AI searches for, the output format, tone, etc. Changes take effect immediately (no server restart needed).

## Frontend structure

```
public/
  index.html            ← single page app
  css/style.css
  js/
    main.js             ← Mapbox map init, fullscreen toggle
    map.js              ← layers, data fetching, interactivity
    search.js           ← autocomplete search bar
    ui.js               ← panel rendering, AI Guide section
    icons.js            ← custom map marker icons
```

The AI Guide section in `ui.js` (`updatePanel` function):
- "Genera AI Guide" button → calls `/api/ai/research`
- "Rigenera descrizione" button → calls `/api/ai/research/regenerate`
- Shows cache status (📦 Da cache / ✨ Generato ora), sources used, expiry time
- Passes `osm_id`, `lat`, `lng`, `elevation`, `name`, `type` to the API

## Coding rules (important)

- **No `any` in TypeScript** — always use explicit types
- Follow existing code style (no semicolons policy is NOT in effect here — server.ts uses semicolons)
- Keep code lean: no speculative abstractions, no unused helpers
- The project uses `"type": "commonjs"` — backend imports have no `.js` extension

## What's planned / not yet done

- Google Places API integration (waiting for user to enable billing)
- The AI sources are all "best effort" — if a scraper fails it doesn't block generation
- No authentication — this is a local personal tool

## Key files to read when starting a new task

- `server.ts` — entry point, all routes
- `agent/orchestrator.ts` — AI agent main flow
- `agent/types.ts` — all TypeScript types
- `public/js/ui.js` — frontend panel and AI interaction
