# Data Source Access Summary (API vs Scraping)

Updated: 2026-04-10
Scope: sites in scraping-sites.txt plus additional platforms suggested in the last analysis.

## Legend

- Access mode:
  - API ready: official API exists and is the preferred method at scale
  - Scraping limited: possible only for public pages, low rate, and policy checks
  - Partnership required: no practical public bulk API; contact provider/licensing needed
  - Avoid scraping: high legal/policy risk for large-scale crawling
- Data types:
  - POI: static place info (name, coords, address, hours, category)
  - TRAIL: route or itinerary metadata/geometry
  - GPS: user-recorded tracks/activities
  - REV: ratings, reviews, comments
  - UGC: community posts/photos/forums
  - MEDIA: videos/channels/media metadata
  - GEO: geocoding, routing, elevation, map tiles
  - META: enrichment metadata (names, altitudes, admin areas, IDs)

## A) Sites from scraping-sites.txt

| Source | Access mode | Main infos available | Notes |
| --- | --- | --- | --- |
| komoot.com | Partnership required / Avoid scraping at scale | TRAIL, POI, UGC (public pages) | robots shows strong restrictions (including /api); no clear public bulk API for third-party ingestion |
| strava.com | API ready | GPS, TRAIL, limited social fields | use official OAuth API; scraping discouraged and many paths disallowed |
| wikiloc.com | Partnership required / Avoid scraping at scale | TRAIL, GPS (public trail pages), UGC | no clear public API for bulk use; AI/LLM crawlers blocked in robots |
| mountainmaps.it | Partnership required (no public API found) | TRAIL (app-level), POI, GEO features in app | public site is mainly product/app pages; no public developer API discovered |
| mapy.com | API ready | GEO (tiles, routing, geocoding, elevation), some POI context | official developer portal exists (developer.mapy.com) with quotas/pricing |
| facebook.com | API ready (strict, permissioned) / Avoid scraping | UGC, REV, POI/page data (only allowed scopes) | Graph API only with app review/scopes; robots and terms strongly restrict automated collection |
| rifugi.lombardia.it | Scraping limited | POI, TRAIL (itineraries), static refuge pages | no public API seen; robots mostly blocks admin paths |
| rifugi.bergamo.it | Scraping limited | POI, TRAIL, static content | appears tied to Rifugi Lombardia content stack; no public API seen |
| rifugi.brescia.it | Scraping limited | POI, TRAIL, static content | same as above |
| rifugi.lecco.it | Scraping limited | POI, TRAIL, static content | same as above |
| orobie.it | Scraping limited (policy-sensitive) | TRAIL/article metadata, UGC-like editorial content | no public API seen; content-signal/publisher restrictions require careful compliance |
| gulliver.it | Partnership required preferred / Avoid scraping at scale | TRAIL, GPS, UGC, REV/forum-like content | rich community data but no public API found; legal/policy risk if mass scraped |
| reddit.com | API ready | UGC, REV/comments, community metadata | robots blocks generic crawling; use official Reddit API and public-content policy |
| youtube.com | API ready | MEDIA, comments, channel/video metadata | use YouTube Data API; direct scraping paths heavily restricted |
| google.com | API ready (via Google APIs, not web scraping) | POI, REV, GEO (via Google Maps Platform APIs) | do not scrape Google web pages/SERP/maps HTML; use official APIs |
| ferrate365.it | Scraping limited (high caution) | TRAIL, POI (via ferrata pages), some static UGC text | no public API found; robots blocks many paths and downloadable traces |
| alltrails.com | Partnership required / Avoid scraping at scale | TRAIL, REV, UGC (public pages) | no public bulk API known; robots blocks API paths and broad crawler activity |

## B) Additional platforms suggested (not in txt)

| Source | Access mode | Main infos available | Notes |
| --- | --- | --- | --- |
| Google Places API | API ready | POI, REV, ratings, photos, location fields | best official source for place reviews/ratings at scale (billing and field masks apply) |
| Yelp API | API ready | POI, REV (review excerpts), ratings | official auth and plan limits apply |
| Foursquare Places API | API ready | POI, tips/UGC-like fields, categories, location intelligence | strong POI graph, commercial terms apply |
| Booking.com Demand API | API ready (partner onboarding) | POI (accommodations), availability, rating/review related endpoints | useful for huts/accommodation inventory and score signals |
| OpenRouteService | API ready | GEO (routing, matrix, isochrones, elevation, geocoding), some POI | good routing backbone for mountain use cases |
| OpenStreetMap data (planet/extracts) | API ready (data-native) | TRAIL, POI, GEO base map, path network | ideal for scale if you ingest data directly and/or self-host query stack |
| Nominatim (public instance) | Scraping/API limited (public infra) | GEO geocoding/reverse geocoding | strict usage policy and low-rate limits; not for heavy production traffic |
| Overpass API (public instance) | Scraping/API limited (public infra) | OSM feature queries for TRAIL/POI | public quota limits; self-host for heavy workloads |
| Wikidata | API ready | META (peak IDs, names, elevation, links, multilingual labels) | CC0 data; excellent enrichment layer |
| GeoNames | API ready | META (toponyms, admin units, timezone, elevation services) | useful secondary enrichment source |

## C) Practical recommendation for your project

1. Core mountain/trail base: OpenStreetMap data + OpenRouteService (+ Mapy API where useful).
2. Reviews layer: Google Places API first, then Yelp/Foursquare, plus Booking for huts/accommodations.
3. Community/social layer: Reddit API + YouTube Data API + Strava API (only consented/authorized data).
4. Avoid large-scale scraping of AllTrails, Wikiloc, Komoot, Facebook, and Gulliver unless you secure explicit partnership/licensing.
5. For local editorial sites (Rifugi/Orobie/Ferrate365): keep scraping low-frequency, policy-checked, and focused on clearly public static fields.

