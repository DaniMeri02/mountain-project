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
- **Route** — a path computed client-side over the trail graph between a start and end point, with
  optional **via** points and a **round-trip** option. The compute runs in a web worker
  (`src/routing/`); the result yields one or more **alternatives** the user can pick between, plus
  distance and a GPX export. Snapping ties each clicked point to the nearest trail node.
- **Basemap** — the map's tile style: Mapbox (outdoors / satellite 2D / satellite 3D), OpenStreetMap,
  or OpenTopoMap. Switching basemap calls Mapbox `setStyle`, which wipes custom layers/markers, so
  overlays and result markers are re-asserted on `style.load`.
- **Interface language / content language** — two different things, deliberately. Everything the
  portal itself says is **English**: buttons, labels, badges, errors. Everything the AI *generates*
  about a place is **Italian**, including its section headings, so it reads in the same language as
  the sources it draws on and stays usable by Italian visitors.
- **Verified Maps link** — a Google Maps link shown for a hut or bivouac only when the place was
  confirmed to be that POI: near enough, named compatibly, and not contradicted by the kind of
  building Google names. Distinct from a **verified absence** (Google was asked and had no matching
  listing, which the description states outright) and from an **unresolved lookup** (no answer was
  obtained — nothing is shown, because silence is not evidence of absence).
- **Offline area** — a user-saved bounding box whose trail/POI/ferrata overlays and map tiles are
  downloaded for offline use. Overlays live in IndexedDB; tiles are cached by the service worker
  under the basemap's workbox cache and ref-counted so deleting one area only evicts tiles no other
  area still needs.

## Decisions

See `docs/adr/` for architecture decision records.

- [0001](docs/adr/0001-structured-filter-json.md) — Smart search translates NL to a structured
  filter (validated JSON), not raw SQL.
