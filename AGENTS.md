# StreamHub – Architecture & Agent Instructions

You are an autonomous coding agent working on **StreamHub**.

## Current Components (Variant B)
- `core/` — API gateway (Fastify, TS). Exposes canonical `POST /query`, fans out to providers (env `PROVIDERS`, comma-separated). Health: `GET /health`. Per-provider timeout 8s.
  - Swagger/OpenAPI available at `/docs` (also `/docs/json`).
- Providers (source modules, no public endpoints):
  - `providers/sample-provider/` — mock data for Matrix/John Wick, `POST /query`, health `/health`.
  - `providers/rezka-provider/` — scrapes rezka.ag search results. Needs `REZKA_BASE_URL` (default `https://rezka.ag`) and `REZKA_USER_AGENT` optional. Streams parsing TODO. Health `/health`.
- Adapters (client-facing, transform only):
  - `adapters/stremio-adapter/` — Stremio addon proxying core. Endpoints: `/manifest.json`, `/catalog/:type/:id.json` (requires `search` query), `/stream/:type/:id.json` (imdb ids). Health `/health`. Env: `CORE_URL` (default `http://core:8080`), `STREMIO_ID`, `STREMIO_NAME`, `PORT`.
    - Stremio manifest is configurable: behaviorHints.configurable, config keys `debridProvider` (`none|realdebrid`) and `debridToken`. `/stream` uses these query params to optionally debrid magnet links via Real-Debrid.
    - Helper endpoint `/stremio/configure` builds a `stremio://` install link with supplied `debridProvider`/`debridToken` query params.
  - `adapters/lampa-adapter/` — serves plugin JS (`/plugin.js`) and `/streams` (imdb + optional season/episode) proxying to core; health `/health`.
    - Additional `online_mod.js` plugin compatible with Lampa “online_mod” UI; calls adapter `/streams` and caches per-episode results.
- Docker: `docker-compose.yml` runs core + providers + stremio adapter. Ports exposed: core 8080, sample-provider 4000, rezka-provider 4100, stremio-adapter 7000.
  - `docker-compose.prod.yml` adds Traefik with HTTPS + host routing (env: `CORE_HOST`, `STREMIO_HOST`, `LAMPA_HOST`, `ACME_EMAIL`).
  - `docker-compose.dev.yml` runs all services with bind mounts and `nodemon` (`npm run dev`), avoiding image rebuilds during development.

## Dev notes
- Dev scripts use `nodemon` to watch `src/` (and `static/` for Lampa). Start dev stack: `docker compose -f docker-compose.dev.yml up core stremio-adapter lampa-adapter rezka-provider`.
- Rezka provider now accepts `href` or `query`, scrapes detail page to extract streams/subtitles from player config.

## Module Rules
### A) Source Providers
Responsibilities:
- Accept canonical QueryRequest.
- Fetch/scrape/resolve content from a specific source.
- Return canonical format (Items + Streams).

Rules:
- Providers MUST NOT expose public endpoints (only internal/core).
- Providers MUST NOT know about clients (Stremio, Lampa, etc.).
- Providers MUST NOT change API schema.
- Endpoint: `POST /query` (+ optional `/health` for ops).

### B) Integration Adapters
Responsibilities:
- Adapt StreamHub canonical API to external client ecosystems.
- Define their own endpoints required by the target platform.
- Call StreamHub Core internally.

Rules:
- Adapters DO NOT fetch content directly.
- Adapters NEVER scrape sources.
- Adapters ONLY transform data.
- Endpoints are adapter-specific.

## Canonical API (Core Contract)

### QueryRequest
```json
{
  "query": "Matrix",
  "imdb": "tt0133093",
  "imdbId": "tt0133093",
  "type": "movie|series|any",
  "year": 1999,
  "season": 1,
  "episode": 2,
  "limit": 10
}
```

### Canonical Response
```json
{
  "items": [
    {
      "id": "tt0133093",
      "title": "The Matrix",
      "type": "movie",
      "year": 1999,
      "imdb": "tt0133093",
      "poster": "https://...",
      "streams": [ /* optional */ ]
    }
  ],
  "streams": [
    {
      "id": "matrix-hd",
      "title": "HD",
      "url": "https://...",
      "quality": "1080p",
      "source": "sample-provider"
    }
  ],
  "providerErrors": { "provider-url": "error (optional)" }
}
```
