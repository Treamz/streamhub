# StreamHub – Architecture & Agent Instructions

You are an autonomous coding agent working on **StreamHub**.

## Project Overview

StreamHub is a modular backend platform that aggregates video streams from multiple sources
and exposes a unified canonical API.

The system is based on **Variant B architecture**:
- Core service (API Gateway)
- External modules as separate services (Docker containers)

There are **two types of modules**:

---

## 1. Module Types

### A) Source Providers
Examples: rezka, youtube, torrents, local-hls

Responsibilities:
- Accept canonical QueryRequest
- Fetch / scrape / resolve content from a specific source
- Return results in canonical format (Items + Streams)

Rules:
- Providers MUST NOT expose public endpoints
- Providers MUST NOT know about clients (Stremio, Lampa, etc.)
- Providers MUST NOT change API schema

Endpoint:
- POST /query

---

### B) Integration Adapters
Examples: stremio-adapter, lampa-adapter, plex-adapter

Responsibilities:
- Adapt StreamHub canonical API to external client ecosystems
- Define their own endpoints required by the target platform
- Call StreamHub Core internally

Rules:
- Adapters DO NOT fetch content directly
- Adapters NEVER scrape sources
- Adapters ONLY transform data

Endpoints are adapter-specific.

---

## 2. Canonical API (Core Contract)

### QueryRequest
```json
{
  "query": "Matrix",
  "imdb": "tt0133093",
  "type": "movie|series|any",
  "limit": 10
}
