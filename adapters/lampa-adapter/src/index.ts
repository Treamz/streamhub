import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT ?? 7011);
const CORE_URL = process.env.CORE_URL ?? 'http://core:8080';

interface Stream {
  id: string;
  title?: string;
  url: string;
  quality?: string;
  source?: string;
  subtitles?: { url: string; lang?: string; label?: string }[];
}

interface CoreResponse {
  items?: any[];
  streams?: Stream[];
}

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: '*',
});

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.get('/plugin.js', async (_req, reply) => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'plugin.js');
  const js = fs.readFileSync(file, 'utf-8');
  reply.type('application/javascript').send(js);
});

fastify.get('/online_mod.js', async (_req, reply) => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'online_mod.js');
  const js = fs.readFileSync(file, 'utf-8');
  reply.type('application/javascript').send(js);
});

fastify.get('/streams', async (request, reply) => {
  const { imdb, query, season, episode } = request.query as Record<string, string | undefined>;
  if (!imdb && !query) {
    // Gracefully return empty to avoid client errors when plugin lacks context
    return { streams: [] };
  }
  try {
    const payload = {
      imdb,
      query,
      season: season ? Number(season) : undefined,
      episode: episode ? Number(episode) : undefined,
    };
    const res = await fetch(`${CORE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Core responded with ${res.status}`);
    }
    const data = (await res.json()) as CoreResponse;
    return { streams: data.streams ?? [] };
  } catch (err) {
    request.log.error({ err }, 'streams failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start lampa adapter');
    process.exit(1);
  });
