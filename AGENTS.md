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
  - `adapters/lampa-adapter/` — serves plugin JS (`/plugin.js`) and `/streams` (imdb + optional season/episode) proxying to core; health `/health`.
- Docker: `docker-compose.yml` runs core + providers + stremio adapter. Ports exposed: core 8080, sample-provider 4000, rezka-provider 4100, stremio-adapter 7000.

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
