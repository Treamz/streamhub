# StreamHub

Modular backend platform that aggregates video streams from multiple sources and exposes a canonical API. Architecture follows Variant B: a Core API Gateway plus external provider and adapter services running as separate containers.

## Layout
- `core/` — API gateway exposing canonical `/query` endpoint and dispatching to providers.
- `providers/` — source provider services implementing `/query` and returning canonical Items + Streams.
- `providers/rezka-provider/` — example scraper-based provider for rezka.ag search (streams extraction TODO).
- `adapters/` — client-facing adapters (planned). Each adapts canonical API to a specific client.
- `adapters/stremio-adapter/` — Stremio addon that proxies requests to the core and shapes responses.
- `docker-compose.yml` — local orchestration of core + sample provider.

## Quickstart
1. Install Node.js >= 20.
2. From the repo root run `npm install` to install dev tooling (lint/test tasks).
3. Start all services with `docker compose up --build`.
4. Query the core: `curl -X POST http://localhost:8080/query -d '{"query":"Matrix"}' -H 'Content-Type: application/json'`.

## Canonical QueryRequest
```json
{
  "query": "Matrix",
  "imdb": "tt0133093",
  "type": "movie|series|any",
  "limit": 10
}
```

## Roadmap
- Add real provider integrations (rezka, youtube, torrents).
- Implement adapters (Stremio, Lampa, Plex).
- Auth/rate limiting, tracing, observability.
- Contract tests between core and providers.
