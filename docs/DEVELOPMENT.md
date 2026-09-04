# Development

Technical reference for running, extending and deploying Mountain Portal. For what the project *is*,
see the [README](../README.md); for the domain vocabulary, see [CONTEXT.md](../CONTEXT.md).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22+ | CI and the build target both pin node 22 |
| PostgreSQL | 14+ | with the **PostGIS** extension |
| Mapbox account | — | a free public token; the map will not render without one |

The database defaults to port **5433**, database `mountain_db`, user `mountain_worker`. Any local
Postgres works — override the values in `.env`.

```sql
CREATE DATABASE mountain_db;
CREATE USER mountain_worker WITH PASSWORD '<your-db-password>';
GRANT ALL PRIVILEGES ON DATABASE mountain_db TO mountain_worker;
\c mountain_db
CREATE EXTENSION IF NOT EXISTS postgis;
```

## Environment

Copy `.env.example` → `.env` and fill it in. `.env` is gitignored.

| Variable | Required | Purpose |
|---|---|---|
| `MAPBOX_TOKEN` | **yes** | Public Mapbox token. Served to the frontend by `GET /api/config` — never inlined in the bundle. |
| `DB_USER` `DB_PASSWORD` `DB_HOST` `DB_PORT` `DB_NAME` | **yes** | Postgres connection. The server refuses to start if any is missing. |
| `GEMINI_API_KEY` | one AI key | Cascade models 1–2 (`gemini-2.5-flash`, `-flash-lite`). |
| `GROQ_API_KEY` | one AI key | Cascade models 3–4 (`openai/gpt-oss-120b`, `-20b`). |
| `OPENROUTER_API_KEY` | one AI key | Cascade model 5 (`google/gemma-4-31b-it:free`). |
| `GOOGLE_PLACES_API_KEY` | no | Verified Maps links for huts/bivouacs. Omitted entirely when absent. |
| `YOUTUBE_API_KEY` | no | YouTube source; skipped when absent. |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | no | Reddit source; skipped when absent. |
| `APIFY_TOKEN` | no | Facebook/TripAdvisor sources — currently disabled in code. |
| `HOST` | no | Server bind address; defaults to `127.0.0.1`. |
| `DEM_API_URL` | no | Elevation provider; defaults to OpenTopoData SRTM30m. |

At least one AI key is needed for AI guides and smart search. The cascade skips any model whose key
is unset, so one provider is enough.

## First run

Run once per database, in order:

```bash
npm ci
npm run migrate:ai          # ai_description_cache
npm run migrate:search      # admin_areas + make pois.elevation nullable
npm run migrate:places      # google_place_cache + google_places_usage
npm run import:areas        # ISTAT/openpolis province + region polygons
npm run import:pois         # load public/data/pois.geojson into pois
npm run backfill:elevation  # optional — fill missing elevations from a DEM API

# The via-ferrata scripts are the odd ones out: they read PG* environment
# variables directly and ignore .env, and the importer needs the snapshot path.
PGHOST=localhost PGPORT=5433 PGUSER=mountain_worker PGPASSWORD=<your-db-password> \
PGDATABASE=mountain_db npm run import:ferrata -- exports/<snapshot>.json

npm run dev
```

`npm run dev` starts two processes via `concurrently`: the Fastify API on **:3000** (`tsx watch`)
and Vite on **:5173**, which proxies `/api` to the API. **Open [:5173](http://localhost:5173)** —
port 3000 alone serves the API and the built bundle, not the dev frontend.

The POI and ferrata datasets are committed (`public/data/pois.geojson`,
`exports/via-ferrata-snapshot-*.json`) so a clone works without hammering the Overpass API. The
`fetch:*` scripts regenerate them and take a long time.

## Scripts

| Script | Does |
|---|---|
| `dev` | API (tsx watch, :3000) + Vite (:5173) together |
| `build` | `build:server` + `build:frontend` + `build:conf` |
| `build:server` | esbuild bundle → `dist/server.js` |
| `build:frontend` | Vite build → `dist/public` (incl. the generated service worker) |
| `build:conf` | copy `ai-agent-conf/` → `dist/ai-agent-conf` — the server reads prompts from `process.cwd()` |
| `start` | `node dist/server.js` (production) |
| `typecheck` | `tsc --noEmit` for backend and `src/` separately |
| `test` / `test:watch` / `test:coverage` | Vitest |
| `migrate:ai` `migrate:search` `migrate:places` | one-time DDL, idempotent |
| `import:areas` | fetch + load administrative boundaries |
| `import:pois` | load `public/data/pois.geojson` into Postgres |
| `import:ferrata` `export:ferrata` `fetch:ferrata` | via-ferrata snapshot in/out. **`PG*` env only — these ignore `.env` and require `PGPASSWORD`**; the importer also takes a snapshot path after `--` |
| `fetch:data` `fetch:trails` | re-fetch from Overpass (slow, chunked, resumable) |
| `backfill:elevation` | fill missing POI elevations from a DEM API |
| `patch:tracks` | extend trail coverage over an extra area |

## Database

| Table | Content |
|---|---|
| `pois` | Peaks, huts, bivouacs — `id, osm_id, type, name, elevation, geom(Point)` |
| `trails` | Hiking paths — `id, osm_id, name, sac_scale, geom(LineString)` |
| `via_ferrata` | Ferrata routes — `id, osm_id, name, via_ferrata_scale, sac_scale, source_type, geom` |
| `ai_description_cache` | Generated descriptions keyed by SHA-256 `cache_key`, 48h TTL |
| `admin_areas` | Province/region polygons; powers area filters via GIST-indexed `ST_Intersects` |
| `google_place_cache` | Verified place IDs. `place_id NULL` = verified absence, re-checked after 7 days |
| `google_places_usage` | Spend guard — hard ceilings of 150 calls/day and 4,500/month |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/pois` `/api/trails` `/api/ferrata` | bbox query `?bbox=minLng,minLat,maxLng,maxLat` |
| GET | `/api/offline/bundle` | all three datasets in one round trip; bbox capped at 0.5° |
| GET | `/api/search?q=` | name autocomplete, 20 results max |
| POST | `/api/search/smart` | `{ q }` (LLM translates) or `{ filter, offset }` (pagination, no LLM). Optional `viewport` resolves "in questa zona" |
| POST | `/api/ai/research` | `{ name, type, elevation?, osm_id?, lat?, lng?, modelSlug? }` → cache-first description |
| POST | `/api/ai/research/regenerate` | same body, bypasses the cache |
| GET | `/api/ai/models` | `[{ slug, label }]` for the model picker |
| POST | `/api/ai/reload-prompt` | drop the in-process prompt cache |
| GET | `/api/config` | `{ mapboxToken }` |
| GET | `/api/elevation?lat=&lng=` | point elevation via DEM, LRU-capped at 1000 entries |

## AI agent

```
agent/
  orchestrator.ts       main flow: sources in parallel → model cascade → cache → response
  search-filter.ts      NL → validated SearchFilter (6h in-process cache)
  search-query.ts       SearchFilter → parameterized PostGIS query
  cache.ts              AiDescriptionCache (48h TTL, SHA-256 key)
  google-place-cache.ts place-id storage + Places API spend counters
  prompt-loader.ts      reads ai-agent-conf/*.md, memoized per process
  types.ts              every interface — no `any`
  sources/              wikidata · overpass · rifugi-scraper · ferrate365-scraper
                        youtube · reddit · komoot · google-places · http · apify
```

Seven sources run concurrently under `Promise.allSettled`; each failure is recorded as
`success: false` with its source name intact and never blocks the others. Each request writes a
debug dump to `agent-sources-dump.txt` (gitignored).

The model cascade lives in `AI_MODELS` in `agent/orchestrator.ts` and falls through on any failure
except a malformed request body (see `shouldCascade`). Providers retire slugs regularly — a 404
means the catalogue moved, so re-check each provider's `GET /models` rather than debugging the code.

`agent/sources/google-places.ts` is deliberately **not** in the `SOURCES` array. No model in the
cascade can browse, so a Maps URL written by an LLM is invented. The link is resolved server-side,
in parallel with the sources, and appended to the finished description; the URL never enters the
prompt.

Prompts are plain Markdown in `ai-agent-conf/` and take effect without a restart.

## Testing

```bash
npm test                                  # all vitest suites
npx vitest run tests/search-query.test.ts # one suite
npx playwright test                       # e2e (needs the dev server running)
npx playwright test tests/e2e/smart-search.spec.ts --headed
```

Vitest covers `agent/`, `server.ts` routes and the pure frontend modules; Playwright specs in
`tests/e2e/` drive the real UI. Network-facing sources are tested against fixtures in
`tests/fixtures/`, never live APIs.

## Deploy

`.github/workflows/ci.yml` runs typecheck, tests and a build on every push.

`.github/workflows/deploy.yml` builds on push to `main` and force-pushes `dist/` to an orphan
`deploy` branch. The target host (a 2 GB mini-pc) polls that branch and runs the prebuilt artifact —
it never builds. **Invariant: every file the server reads at runtime must live inside `dist/`.** The
workflow asserts this for the prompt files; anything else read from `process.cwd()` needs the same
treatment in `build:conf`. `scripts/setup-systemd.sh` provisions the box in one command.

## Repository docs

- [CONTEXT.md](../CONTEXT.md) — domain glossary
- [docs/adr/](adr/) — architecture decision records
- [CLAUDE.md](../CLAUDE.md) — how an AI coding agent should read this repo
- [docs/audits/](audits/) — closed audit reports (history, not a backlog)
- [docs/plans/](plans/) — implementation plans for past work
