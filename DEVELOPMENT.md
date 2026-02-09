# Development Guide

## Prerequisites
- Node.js 20+
- Docker + Docker Compose v2

## Local quick run (dev stack)
- Start core + providers + adapters with live reload:
  ```bash
  docker compose -f docker-compose.dev.yml up core stremio-adapter lampa-adapter rezka-provider eneyida-provider uaflix-provider kodik-provider uaserial-provider
  ```
  - Core swagger: http://localhost:8080/docs
  - Sample `/query`:
    ```bash
    curl -X POST http://localhost:8080/query \
      -H 'Content-Type: application/json' \
      -d '{"query":"Matrix"}'
    ```
  - Stremio manifest: http://localhost:7010/manifest.json
  - Lampa plugin: http://localhost:7011/plugin.js

## Running a single provider in dev
- Example (uaserial):
  ```bash
  docker compose -f docker-compose.dev.yml up uaserial-provider
  ```
  Ports:
  - sample 4000
  - rezka 4100
  - eneyida 4200
  - uaflix 4300
  - kodik 4400
  - uaserial 4500

## Local node (without Docker)
- Each service has dev scripts; from service dir run:
  ```bash
  npm install
  npm run dev
  ```
  (For providers using `tsc`, dev script builds then runs `dist`.)

## Production build
- Build and run all services:
  ```bash
  docker compose up --build
  ```
- With Traefik/HTTPS: set `CORE_HOST`, `STREMIO_HOST`, `LAMPA_HOST`, `ACME_EMAIL` then:
  ```bash
  docker compose -f docker-compose.prod.yml up -d --build
  ```

## Environment variables (provider-specific)
- REZKA_BASE_URL, REZKA_USER_AGENT
- ENEYIDA_BASE_URL, ENEYIDA_USER_AGENT
- UAFLIX_BASE_URL, UAFLIX_USER_AGENT
- UASERIAL_BASE_URL, UASERIAL_USER_AGENT
- KODIK_API_URL, KODIK_TOKEN, KODIK_USER_AGENT

## Contract
`POST /query` accepts (any provider/core):
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
Providers should filter by `year` when present and use `season`/`episode` to pick series episodes.

## Debug tips
- Enable a single provider + core to isolate failures.
- For scraping issues, log the iframe/player HTML and look for `file`/`link`/`.m3u8` entries.
- Per-provider timeouts: core uses 8s timeout per provider.

