# 0001 — Smart search translates NL to a structured filter, not raw SQL

Status: accepted
Date: 2026-06-04

## Context

The smart-search feature turns a natural-language question into a database query. The translator is,
in the cheapest case, a small free LLM in an 8-model cascade. Two designs were considered:

- **(a) Structured filter** — the LLM emits a constrained JSON `SearchFilter` that the backend
  validates and compiles into a parameterized PostGIS query.
- **(b) Raw SQL** — the LLM emits SQL we execute directly (against a read-only role).

## Decision

The LLM emits **structured JSON only** (`SearchFilter` in `agent/types.ts`). It never produces SQL.
The backend validates every field against allow-lists (`agent/search-filter.ts: validateFilter`) and
builds a parameterized query (`agent/search-query.ts`); every user-derived value becomes a bound
parameter (`$n`).

## Consequences

- **Safe** — no SQL injection or destructive-query surface; the query shape is fixed by our code.
- **Reliable on weak models** — emitting a small constrained JSON object is far more dependable than
  correct SQL from a 32B free model. Unparseable output simply cascades to the next model.
- **Cacheable & paginatable** — the filter is a small serializable artifact, so pagination replays it
  with no second LLM call, and identical queries hit a 6h translation cache.
- **Testable** — the query builder is a pure function (15 unit tests); the validator is unit-tested.
- **Cost** — only filters expressible in the schema are supported (type, elevation, area, difficulty,
  name). Exotic questions need a schema extension — an accepted trade-off for safety and reliability.
