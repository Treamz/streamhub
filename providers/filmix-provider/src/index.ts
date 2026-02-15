import Fastify from 'fastify';
import fetch from 'node-fetch';

interface QueryRequest {
  query?: string;
  imdb?: string;
  type?: 'movie' | 'series' | 'any';
  season?: number;
  episode?: number;
  year?: number;
}

interface Stream {
  id: string;
  title?: string;
  url: string;
  quality?: string;
  source?: string;
  subtitles?: { url: string; lang?: string; label?: string }[];
}

interface FilmixSearchItem {
  id: number;
  title?: string;
  original_title?: string;
  original_name?: string;
  year?: number;
  poster?: string;
}

interface FilmixPost {
  player_links: {
    movie?: Array<{ translation: string; link: string }> | null;
    playlist?: Record<string, any> | null; // season -> translations
  };
  quality?: string;
}

const PORT = Number(process.env.PORT ?? 4800);
// filmix mobile API is usually on filmixapp.cyou (HTTP). Allow override.
const API_HOST = (process.env.FILMIX_API_HOST ?? 'http://filmixapp.cyou').replace(/\/+$/, '');
const FALLBACK_HOST = 'https://api.filmix.tv';
const TOKEN = process.env.FILMIX_TOKEN ?? '';
const USER_DEV_APK = process.env.FILMIX_DEV_APK ?? '2.2.10.0';
const USER_DEV_ID = process.env.FILMIX_DEV_ID ?? randomId();
const USER_DEV_NAME = process.env.FILMIX_DEV_NAME ?? 'Xiaomi';
const USER_DEV_OS = process.env.FILMIX_DEV_OS ?? '14';
const USER_DEV_VENDOR = process.env.FILMIX_DEV_VENDOR ?? 'Xiaomi';
const HLS = process.env.FILMIX_HLS === 'true';
const RESERVE = process.env.FILMIX_RESERVE === 'true';

const fastify = Fastify({ logger: true });

function randomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function argsQuery() {
  const params = new URLSearchParams({
    app_lang: 'ru_RU',
    user_dev_apk: USER_DEV_APK,
    user_dev_id: USER_DEV_ID,
    user_dev_name: USER_DEV_NAME,
    user_dev_os: USER_DEV_OS,
    user_dev_token: TOKEN,
    user_dev_vendor: USER_DEV_VENDOR,
  });
  return params.toString();
}

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, season, episode, year } = request.body ?? {};
  const title = query?.trim();

  if (!title) {
    reply.code(400);
    return { error: 'query required' };
  }

  try {
    request.log.info({ title, season, episode, year }, 'filmix incoming');
    const searchItem = await searchFilmix(title, year, request.log);
    if (!searchItem) {
      request.log.warn('filmix search returned null');
      return { items: [], streams: [] };
    }

    const post = await fetchPost(searchItem.id, request.log);
    if (!post) {
      request.log.warn({ id: searchItem.id }, 'filmix post is null');
      return { items: [], streams: [] };
    }

    const streams = extractStreams(post, season, episode, request.log);
    request.log.info({ streams: streams.length }, 'filmix streams count');
    const items = [
      {
        id: String(searchItem.id),
        title: searchItem.title,
        year: searchItem.year,
        poster: searchItem.poster,
        streams,
      },
    ];

    return { items, streams };
  } catch (err) {
    request.log.error({ err }, 'filmix failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

async function searchFilmix(title: string, year: number | undefined, log: any): Promise<FilmixSearchItem | null> {
  const url = `${API_HOST}/api/v2/search?story=${encodeURIComponent(title)}&${argsQuery()}`;
  log.info({ url }, 'filmix search');
  let res = await fetch(url);
  if (!res.ok && TOKEN) {
    // if token fails, try without token
    const url2 = `${API_HOST}/api/v2/search?story=${encodeURIComponent(title)}&${argsQuery().replace(`user_dev_token=${TOKEN}`, 'user_dev_token=')}`;
    log.warn({ status: res.status }, 'filmix search retry without token');
    res = await fetch(url2);
  }
  if (!res.ok) {
    log.warn({ status: res.status }, 'filmix search status');
    return fallbackSearch(title, year, log);
  }
  const list = (await res.json()) as FilmixSearchItem[];
  if (!Array.isArray(list) || !list.length) return fallbackSearch(title, year, log);

  if (year) {
    const match = list.find((i) => i.year === year);
    if (match) return match;
  }
  return list[0];
}

async function fallbackSearch(title: string, year: number | undefined, log: any): Promise<FilmixSearchItem | null> {
  const url = `${FALLBACK_HOST}/api-fx/list?search=${encodeURIComponent(title)}&limit=48`;
  log.info({ url }, 'filmix fallback search');
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const items: FilmixSearchItem[] = json?.items ?? [];
    if (!items.length) return null;
    if (year) {
      const match = items.find((i) => i.year === year);
      if (match) return match;
    }
    return items[0];
  } catch {
    return null;
  }
}

async function fetchPost(id: number, log: any): Promise<FilmixPost | null> {
  const url = `${API_HOST}/api/v2/post/${id}?${argsQuery()}`;
  log.info({ url }, 'filmix post');
  const res = await fetch(url);
  if (!res.ok) {
    log.warn({ status: res.status }, 'filmix post status');
    return null;
  }
  const json = await res.text();
  try {
    // fix empty playlist/movie
    const fixed = json.replace('"playlist":[],', '"playlist":null,');
    const post = JSON.parse(fixed) as FilmixPost;
    return post;
  } catch (err) {
    log.warn({ err }, 'filmix post parse');
    return null;
  }
}

function extractStreams(post: FilmixPost, season?: number, episode?: number, log?: any): Stream[] {
  if (post.player_links?.movie && post.player_links.movie.length) {
    return extractMovieStreams(post.player_links.movie);
  }
  if (post.player_links?.playlist) {
    return extractSeriesStreams(post.player_links.playlist, season, episode, log);
  }
  return [];
}

function extractMovieStreams(movies: Array<{ translation: string; link: string }>): Stream[] {
  const out: Stream[] = [];
  for (const m of movies) {
    const qualities = parseQualitiesFromLink(m.link);
    for (const q of qualities) {
      const url = buildUrlForQuality(m.link, q);
      out.push({ id: `${m.translation}-${q}`, title: m.translation, url, quality: `${q}p`, source: 'filmix' });
    }
  }
  return out;
}

function extractSeriesStreams(playlist: Record<string, any>, season?: number, episode?: number, log?: any): Stream[] {
  const seasons = Object.keys(playlist).sort();
  const seasonKey = season ? String(season) : seasons[0];
  const translations = playlist[seasonKey];
  if (!translations) return [];
  const firstTranslation = Array.isArray(translations) ? translations[0] : Object.values(translations)[0];

  let episodes: Record<string, any> | null = null;
  // firstTranslation can be {"1": {qualities:[...], link:""}, ...}
  if (firstTranslation && typeof firstTranslation === 'object' && !Array.isArray(firstTranslation)) {
    episodes = firstTranslation as Record<string, any>;
  } else if (Array.isArray(firstTranslation)) {
    // array of episodes
    episodes = {} as Record<string, any>;
    firstTranslation.forEach((ep: any, idx: number) => { (episodes as any)[String(idx + 1)] = ep; });
  }
  if (!episodes) return [];

  const epKey = episode ? String(episode) : Object.keys(episodes).sort()[0];
  const ep = episodes[epKey];
  if (!ep) return [];
  const qualities: number[] = ep.qualities || [];
  const out: Stream[] = [];
  for (const q of qualities.sort((a: number, b: number) => b - a)) {
    const url = buildUrlForQuality(ep.link, q);
    out.push({ id: `s${seasonKey}e${epKey}-${q}`, title: `S${seasonKey}E${epKey}`, url, quality: `${q}p`, source: 'filmix' });
  }
  return out;
}

function parseQualitiesFromLink(link: string): number[] {
  const m = link.match(/_\[([0-9,]+)\]\.mp4/);
  if (m && m[1]) return m[1].split(',').map((x) => Number(x)).filter((n) => !Number.isNaN(n));
  const perc = link.match(/_%s\.mp4/);
  if (perc) return [2160, 1440, 1080, 720, 480].filter((n) => link.includes(String(n)) || n);
  return [1080, 720, 480];
}

function buildUrlForQuality(link: string, quality: number): string {
  let url = link;
  url = url.replace(/_\[[0-9,]+\]\.mp4/, `_${quality}.mp4`).replace(/_%s\.mp4/, `_${quality}.mp4`);
  if (HLS) {
    const m = url.match(/^(https?:\/\/[^/]+)\/s\/([^/]+)\/(.*)/);
    if (m) {
      url = `${m[1]}/hls/${m[3]}/index.m3u8?hash=${m[2]}`;
    }
  }
  return url;
}

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start filmix provider');
    process.exit(1);
  });
