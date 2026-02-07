import Fastify from 'fastify';
import fetch from 'node-fetch';

const PORT = Number(process.env.PORT ?? 7000);
const CORE_URL = process.env.CORE_URL ?? 'http://core:8080';
const ADDON_ID = process.env.STREMIO_ID ?? 'org.streamhub';
const ADDON_NAME = process.env.STREMIO_NAME ?? 'StreamHub';
const LOGO = process.env.STREMIO_LOGO ?? '';

const fastify = Fastify({ logger: true });

interface CanonicalItem {
  id: string;
  title: string;
  type: 'movie' | 'series';
  year?: number;
  poster?: string;
}

interface CanonicalStream {
  id: string;
  title?: string;
  url: string;
  quality?: string;
  source?: string;
}

const manifest = {
  id: ADDON_ID,
  version: '0.1.0',
  name: ADDON_NAME,
  description: 'StreamHub canonical to Stremio adapter',
  logo: LOGO,
  resources: ['catalog', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { id: 'streamhub-any', type: 'movie', name: 'StreamHub Movies', extra: [{ name: 'search', isRequired: true }] },
    { id: 'streamhub-any', type: 'series', name: 'StreamHub Series', extra: [{ name: 'search', isRequired: true }] },
  ],
};

fastify.get('/manifest.json', async () => manifest);

fastify.get('/catalog/:type/:id.json', async (request, reply) => {
  const { type, id } = request.params as { type: string; id: string };
  const search = (request.query as Record<string, string>).search;
  if (!search) {
    reply.code(400);
    return { err: 'search is required' };
  }

  const items = await queryCoreItems({ query: search, type });
  return {
    metas: items.map((item) => ({
      id: item.id,
      name: item.title,
      type: item.type,
      poster: item.poster,
      posterShape: 'poster',
      year: item.year,
    })),
  };
});

fastify.get('/stream/:type/:id.json', async (request, reply) => {
  const { id, type } = request.params as { id: string; type: string };
  const imdb = id.startsWith('tt') ? id : undefined;
  if (!imdb) {
    reply.code(400);
    return { err: 'Only imdb ids supported (tt...)' };
  }

  const streams = await queryCoreStreams({ imdb, type });
  return {
    streams: streams.map((stream) => ({
      name: stream.source ?? 'StreamHub',
      title: stream.title,
      url: stream.url,
      description: stream.quality,
    })),
  };
});

async function queryCoreItems(payload: { query?: string; imdb?: string; type?: string }) {
  const response = await fetch(`${CORE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Core responded with ${response.status}`);
  }
  const data = (await response.json()) as { items?: CanonicalItem[] };
  return data.items ?? [];
}

async function queryCoreStreams(payload: { query?: string; imdb?: string; type?: string }) {
  const response = await fetch(`${CORE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Core responded with ${response.status}`);
  }
  const data = (await response.json()) as { streams?: CanonicalStream[] };
  return data.streams ?? [];
}

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start stremio adapter');
    process.exit(1);
  });
