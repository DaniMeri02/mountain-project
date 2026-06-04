# Mountain Portal — Context

Domain glossary and language for the project. Keep terms here meaningful to domain experts,
not implementation detail.

## Glossary

- **POI** — a point of interest: a `peak`, `hut` (rifugio), or `bivouac` (bivacco). Stored in `pois`.
- **Via ferrata** — a protected climbing route; stored in `via_ferrata` (plus some name-matched
  `trails` recognised as ferrata).
- **Smart search / filtering search** — a natural-language question ("rifugi sopra i 2000m in
  bergamasca") turned into a validated **SearchFilter**, then a POI result set. Distinct from the
  plain name **autocomplete** search.
- **SearchFilter** — the constrained JSON the AI emits and the backend validates and executes
  (`agent/types.ts`). The only shape that crosses the LLM→backend boundary; the LLM never writes SQL.
- **Area kind** — how a place reference resolves: `province` / `region` (a polygon in `admin_areas`),
  `viewport` (the current map view), or `bbox`.
- **Result set** — the POIs a SearchFilter matches; shown as a list in the panel and as map markers.
- **DEM backfill** — POI elevations derived from a terrain model (Open-Elevation / OpenTopoData) for
  POIs whose OSM `ele` tag is missing. Such elevations are terrain-derived, not authoritative OSM.

## Decisions

See `docs/adr/` for architecture decision records.

- [0001](docs/adr/0001-structured-filter-json.md) — Smart search translates NL to a structured
  filter (validated JSON), not raw SQL.
