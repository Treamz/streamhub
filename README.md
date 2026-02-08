# StreamHub

Modular backend platform that aggregates video streams from multiple sources and exposes a canonical API. Architecture follows Variant B: a Core API Gateway plus external provider and adapter services running as separate containers.

## Layout
- `core/` — API gateway exposing canonical `/query` endpoint and dispatching to providers.
- `providers/` — source provider services implementing `/query` and returning canonical Items + Streams.
- `providers/rezka-provider/` — scraper for rezka (default mirror `https://rezkaproxy.treamz.me`), accepts `query` or direct `href`, extracts streams/subtitles from player config.
- `providers/eneyida-provider/` — scraper for eneyida (`https://eneyida.tv`), accepts `query` or `href`, extracts streams from common player tags.
- `providers/uaflix-provider/` — scraper for uafix/uaflix (`https://uafix.net`), accepts `query` or `href`, parses iframe players (Ashdi/m3u8), supports `season`/`episode` when JSON is present.
- `adapters/` — client-facing adapters.
- `adapters/stremio-adapter/` — Stremio addon that proxies requests to the core; supports per-user debrid (Real-Debrid) via manifest config and `/stremio/configure` helper endpoint.
- `adapters/lampa-adapter/` — serves Lampa plugin JS (`/plugin.js`) and `/streams`; extra `online_mod.js` plugin mimics popular online_mod UI.
- Compose files: `docker-compose.yml` (baseline), `docker-compose.prod.yml` (Traefik + HTTPS subdomains), `docker-compose.dev.yml` (bind mounts + nodemon for live dev).

## Quickstart
1. Install Node.js >= 20.
2. From the repo root run `npm install` to install dev tooling (lint/test tasks).
3. Start baseline stack: `docker compose up --build`.
4. Dev hot reload: `docker compose -f docker-compose.dev.yml up core stremio-adapter lampa-adapter rezka-provider eneyida-provider uaflix-provider`.
5. Prod with subdomains/HTTPS (Traefik): set `CORE_HOST`, `STREMIO_HOST`, `LAMPA_HOST`, `ACME_EMAIL`, then `docker compose -f docker-compose.prod.yml up -d --build`.
6. Query the core: `curl -X POST http://localhost:8080/query -d '{"query":"Matrix"}' -H 'Content-Type: application/json'`.
7. Open Swagger UI: http://localhost:8080/docs
8. Lampa plugin URL: http://localhost:7011/plugin.js
9. Lampa online_mod-compatible: http://localhost:7011/online_mod.js
10. Stremio manifest: http://localhost:7010/manifest.json
11. Stremio configure helper: http://localhost:7010/stremio/configure?debridProvider=realdebrid&debridToken=TOKEN
12. Eneyida provider health: http://localhost:4200/health
13. UAFlix provider health: http://localhost:4300/health

## Canonical QueryRequest
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

## Roadmap
- Harden Rezka scraper (mirrors, UA/cookies).
- Add more providers (torrents, others).
- Extend adapters (Plex etc.).
- Auth/rate limiting, tracing, observability.
- Contract tests between core and providers.
