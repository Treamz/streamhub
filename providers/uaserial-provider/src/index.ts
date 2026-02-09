import Fastify from 'fastify';
import fetch from 'node-fetch';
import { load } from 'cheerio';

interface QueryRequest {
  query?: string;
  imdb?: string;
  href?: string;
  year?: number;
  season?: number;
  episode?: number;
  type?: 'movie' | 'series' | 'any';
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
  imdb?: string;
  poster?: string;
  streams?: Stream[];
}

interface SearchMovie {
  name: string;
  link: string;
  poster?: string;
  year?: number;
}

interface SearchResponseJson {
  movies: SearchMovie[];
}

interface PlayerVoice {
  title?: string;
  file?: string;
  folder?: PlayerSeason[];
}

interface PlayerSeason {
  title?: string; // "1 сезон"
  folder?: PlayerEpisode[];
}

interface PlayerEpisode {
  title?: string; // "1 серія"
  file?: string;
  subtitle?: string;
  poster?: string;
}

const PORT = Number(process.env.PORT ?? 4500);
const BASE_URL = (process.env.UASERIAL_BASE_URL ?? 'https://uaserial.tv').replace(/\/+$/, '');
const USER_AGENT =
  process.env.UASERIAL_USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, imdb, href, year, season, episode, limit = 10, type } = request.body ?? {};
  const normalizedQuery = query ?? (imdb && !imdb.startsWith('http') ? imdb : undefined);
  const normalizedHref = href ?? (imdb && imdb.startsWith('http') ? imdb : undefined);

  if (!normalizedQuery && !normalizedHref) {
    reply.code(400);
    return { error: 'Provide query or imdb or href' };
  }

  try {
    const items: Item[] = [];

    if (normalizedHref) {
      const detail = await loadDetail(normalizedHref, request, season, episode);
      if (detail) items.push(detail);
    }

    if (normalizedQuery) {
      const searchItems = await search(normalizedQuery, request, limit);
      items.push(...searchItems);
    }

    const filtered = year ? items.filter((i) => i.year === year) : items;

    // When season/episode requested, try to fetch detail for first candidate if streams missing
    if (filtered[0] && (!filtered[0].streams || !filtered[0].streams.length) && filtered[0].id.startsWith('http')) {
      try {
        const detail = await loadDetail(filtered[0].id, request, season, episode);
        if (detail?.streams?.length) filtered[0].streams = detail.streams;
      } catch (err) {
        request.log.warn({ err }, 'uaserial enrich failed');
      }
    }

    const streams = filtered[0]?.streams ?? [];
    return { items: filtered, streams };
  } catch (err) {
    request.log.error({ err }, 'uaserial failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

async function search(query: string, request: any, limit: number): Promise<Item[]> {
  try {
    const url = `${BASE_URL}/search-ajax?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Referer: BASE_URL } });
    if (!res.ok) throw new Error(`search status ${res.status}`);
    const json = (await res.json()) as SearchResponseJson;
    const movies = json.movies ?? [];
    const results: Item[] = [];
    for (const m of movies.slice(0, limit)) {
      const id = absolute(m.link);
      if (!id) continue;
      results.push({
        id,
        title: m.name,
        type: 'movie',
        year: m.year,
        poster: m.poster ? absolute(m.poster) : undefined,
        streams: [],
      });
    }
    return results;
  } catch (err) {
    request.log.warn({ err, query }, 'uaserial search error');
    return [];
  }
}

async function loadDetail(url: string, request: any, season?: number, episode?: number): Promise<Item | null> {
  const detailUrl = absolute(url);
  if (!detailUrl) throw new Error('invalid detail url');
  const res = await fetch(detailUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`detail status ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const title = $('div.name').first().text().trim() || $('h1').first().text().trim() || detailUrl;
  const poster = absolute($('img.cover').attr('src'));
  const year = $('div.release div a').first().text() ? Number($('div.release div a').first().text()) : undefined;
  const type: Item['type'] = season !== undefined || episode !== undefined ? 'series' : 'movie';

  // iframe extraction
  let iframeSrc = $('.player iframe').attr('src') || $('iframe').attr('src') || '';
  if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;
  if (iframeSrc && iframeSrc.startsWith('/')) iframeSrc = BASE_URL + iframeSrc;

  let playerHtml = '';
  if (iframeSrc) {
    try {
      const origin = new URL(iframeSrc).origin;
      const p = await fetch(iframeSrc, { headers: { 'User-Agent': USER_AGENT, Referer: detailUrl, Origin: origin } });
      if (p.ok) playerHtml = await p.text();
      request.log.info({ iframeSrc, status: p.status }, 'uaserial iframe');
    } catch (err) {
      request.log.warn({ err, iframeSrc }, 'uaserial iframe error');
    }
  }

  const streams = extractStreams(playerHtml || html, season, episode, request);

  return { id: detailUrl, title, type, year, poster, streams };
}

function extractStreams(html: string, season: number | undefined, episode: number | undefined, request: any): Stream[] {
  const streams: Stream[] = [];
  const filePart = pickConfigValue(html, 'file') ?? pickConfigValue(html, 'link');
  const subtitlesRaw = pickConfigValue(html, 'subtitle') ?? '';

  if (filePart) {
    const raw = decodeEntities(filePart);
    addFromFilePayload(raw, season, episode, streams, request);
  }

  if (!streams.length) {
    const $ = load(html);
    $('source').each((_, el) => {
      const src = $(el).attr('src');
      if (src) pushStream(streams, src, 'source');
    });
  }

  if (!streams.length) {
    const m = html.match(/https?:[^"'\s]+\.m3u8/gi);
    if (m && m.length) m.forEach((u) => pushStream(streams, u, undefined, 'uaserial'));
  }

  if (subtitlesRaw && streams.length) {
    const subs = parseSubtitles(subtitlesRaw);
    if (subs.length) streams[0].subtitles = subs;
  }

  if (!streams.length) request?.log?.warn({ msg: 'no streams parsed', snippet: html.slice(0, 300) });
  return streams;
}

function addFromFilePayload(raw: string, season: number | undefined, episode: number | undefined, acc: Stream[], request: any) {
  const cleaned = raw.trim().replace(/;$/, '');
  const parsed = tryJson(cleaned, request);
  if (parsed) {
    addFromPlayerJson(parsed, season, episode, acc);
    return;
  }
  const urls = Array.from(cleaned.matchAll(/https?:\/\/[^\s'"}]+/g)).map((m) => m[0]);
  urls.forEach((u) => pushStream(acc, u, undefined, 'uaserial'));
}

function tryJson(text: string, request: any): any | null {
  try {
    const normalized = decodeEntities(text).replace(/'/g, '"');
    return JSON.parse(normalized);
  } catch (err) {
    request?.log?.warn({ err, raw: text.slice(0, 200) }, 'uaserial json parse failed');
    return null;
  }
}

function addFromPlayerJson(parsed: any, season: number | undefined, episode: number | undefined, acc: Stream[]) {
  if (Array.isArray(parsed)) {
    for (const voice of parsed as PlayerVoice[]) {
      if (voice.folder && voice.folder.length) {
        const ep = pickEpisode(voice.folder, season, episode);
        if (ep) {
          pushStream(acc, ep.file, voice.title || ep.title || 'episode', voice.title || 'uaserial');
          addSubs(acc, ep.subtitle);
        }
      }
      if (voice.file) {
        pushStream(acc, voice.file, voice.title, voice.title);
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const values = Object.values(parsed as Record<string, any>);
    values.forEach((v) => {
      if (typeof v === 'string') pushStream(acc, v, undefined, 'uaserial');
      else if (v && typeof v === 'object' && 'file' in v) pushStream(acc, (v as any).file, (v as any).title, 'uaserial');
    });
  }
}

function pickEpisode(folders: PlayerSeason[], season?: number, episode?: number): PlayerEpisode | null {
  const seasons = season !== undefined ? folders.filter((f) => numberFromTitle(f.title) === season) : folders;
  const s = seasons[0] ?? folders[0];
  if (!s) return null;
  const eps = s.folder ?? [];
  if (!eps.length) return null;
  if (episode !== undefined) {
    const match = eps.find((e) => numberFromTitle(e.title) === episode);
    if (match) return match;
  }
  return eps[0];
}

function pushStream(acc: Stream[], urlRaw?: string, title?: string, source?: string) {
  if (!urlRaw) return;
  let url = urlRaw.replace(/\\\//g, '/');
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https?:\/\//i.test(url)) return;
  const quality = qualityFrom(url) || qualityFrom(title);
  acc.push({
    id: `uaserial-${acc.length}`,
    title: title || quality || 'Stream',
    url,
    quality,
    source: source || 'uaserial',
  });
}

function addSubs(acc: Stream[], raw?: string) {
  if (!raw || !acc.length) return;
  const subs = parseSubtitles(raw);
  if (subs.length) acc[0].subtitles = subs;
}

function parseSubtitles(raw: string): { url: string; lang?: string; label?: string }[] {
  const subs: { url: string; lang?: string; label?: string }[] = [];
  const parts = raw.split(',').map((s) => s.trim());
  for (const part of parts) {
    const m = part.match(/\[([^\]]+)\](https?:\/\/\S+)/);
    if (m) subs.push({ url: m[2], lang: m[1], label: m[1] });
  }
  return subs;
}

function pickConfigValue(html: string, key: string): string | null {
  const quoted = new RegExp(`${key}\\s*[:=]\\s*(['"])([\\s\\S]*?)\\1`, 'i').exec(html);
  if (quoted) return quoted[2];
  const unquoted = new RegExp(`${key}\\s*[:=]\\s*([^,;\\n]+)`, 'i').exec(html);
  if (unquoted) return unquoted[1].trim();
  return null;
}

function numberFromTitle(title?: string) {
  if (!title) return undefined;
  const m = title.match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function qualityFrom(value?: string) {
  if (!value) return undefined;
  const m = value.match(/(2160|1080|720|480|360)p?/);
  return m ? `${m[1]}p` : undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function absolute(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (!url.startsWith('/')) return BASE_URL + '/' + url;
  return BASE_URL + url;
}

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start uaserial provider');
    process.exit(1);
  });
