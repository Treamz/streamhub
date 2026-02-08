import Fastify from 'fastify';
import fetch from 'node-fetch';

interface QueryRequest {
  query?: string;
  imdb?: string;
  kinopoisk?: string | number;
  season?: number;
  episode?: number;
  type?: 'movie' | 'series' | 'any';
  year?: number;
  limit?: number;
}

interface Stream {
  id: string;
  title?: string;
  url: string;
  quality?: string;
  source?: string;
  subtitles?: { url: string; lang?: string; label?: string }[];
}

interface Item {
  id: string;
  title: string;
  type: 'movie' | 'series';
  year?: number;
  poster?: string;
  streams?: Stream[];
}

interface KodikResult {
  id: string;
  title?: string;
  title_orig?: string;
  year?: number;
  link?: string;
  type?: string;
  translation?: { title?: string };
  last_season?: number;
  last_episode?: number;
  material_data?: { poster_url?: string };
  episodes?: Record<string, Record<string, { link: string }>>; // season -> episode -> {link}
}

interface KodikSearchResponse {
  results?: KodikResult[];
}

const PORT = Number(process.env.PORT ?? 4400);
const API_URL = (process.env.KODIK_API_URL ?? 'https://kodikapi.com').replace(/\/+$/, '');
const KODIK_TOKEN = process.env.KODIK_TOKEN ?? '';
const USER_AGENT = process.env.KODIK_USER_AGENT ?? 'StreamHub/0.1';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, imdb, kinopoisk, season, episode, type = 'any', year, limit = 10 } = request.body ?? {};
  if (!query && !imdb && !kinopoisk) {
    reply.code(400);
    return { error: 'Provide query or imdb or kinopoisk' };
  }
  if (!KODIK_TOKEN) {
    reply.code(500);
    return { error: 'KODIK_TOKEN not set' };
  }

  try {
    const results = await searchKodik({ query, imdb, kinopoisk, season, type, limit }, request);
    const filteredResults = year ? results.filter((r) => r.year === year) : results;
    if (!filteredResults.length) return { items: [], streams: [] };

    const items: Item[] = filteredResults.map((r) => toItem(r));

    // attach streams for first item if season/episode specified or if movie
    if (items[0]) {
      const streams = extractStreams(filteredResults[0], season, episode);
      if (streams.length) items[0].streams = streams;
      return { items, streams: items[0].streams ?? [] };
    }

    return { items, streams: [] };
  } catch (err) {
    request.log.error({ err }, 'kodik failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

async function searchKodik(opts: { query?: string; imdb?: string; kinopoisk?: string | number; season?: number; type: string; limit: number }, request: any) {
  const params = new URLSearchParams();
  params.set('token', KODIK_TOKEN);
  params.set('limit', String(opts.limit));
  params.set('with_episodes', 'true');
  params.set('with_seasons', 'true');
  params.set('with_material_data', 'true');
  if (opts.imdb) params.set('imdb_id', opts.imdb);
  if (opts.kinopoisk) params.set('kinopoisk_id', String(opts.kinopoisk));
  if (opts.query) params.set('title', opts.query);
  if (opts.season) params.set('season', String(opts.season));
  if (opts.type && opts.type !== 'any') params.set('types', opts.type === 'series' ? 'serial' : 'movie');

  const url = `${API_URL}/search?${params.toString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`kodik status ${res.status}`);
  const data = (await res.json()) as KodikSearchResponse;
  request.log.info({ url, count: data.results?.length ?? 0 }, 'kodik search');
  return data.results ?? [];
}

function toItem(r: KodikResult): Item {
  const title = r.title || r.title_orig || 'Unknown';
  const poster = r.material_data?.poster_url;
  const type: Item['type'] = r.type?.includes('serial') ? 'series' : 'movie';
  return { id: r.id || r.link || title, title, type, year: r.year, poster, streams: [] };
}

function extractStreams(r: KodikResult, season?: number, episode?: number): Stream[] {
  const streams: Stream[] = [];
  // Series episodes if present
  if (r.episodes && season && episode) {
    const seasonKey = String(season);
    const episodes = r.episodes[seasonKey];
    const ep = episodes ? episodes[String(episode)] : undefined;
    if (ep?.link) {
      pushStream(streams, ep.link, `S${season}E${episode}`, r.translation?.title);
      return streams;
    }
  }

  // fallback: use main link
  if (r.link) {
    pushStream(streams, r.link, r.translation?.title ?? 'Kodik', r.translation?.title);
  }
  return streams;
}

function pushStream(acc: Stream[], url?: string, title?: string, source?: string) {
  if (!url) return;
  let u = url;
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u)) return;
  const quality = qualityFrom(u);
  acc.push({ id: `kodik-${acc.length}`, title: title || quality || 'Stream', url: u, quality, source: source || 'kodik' });
}

function qualityFrom(url: string): string | undefined {
  const m = url.match(/(2160|1080|720|480|360)p?/);
  return m ? `${m[1]}p` : undefined;
}

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  fastify.log.error(err, 'Failed to start kodik provider');
  process.exit(1);
});
