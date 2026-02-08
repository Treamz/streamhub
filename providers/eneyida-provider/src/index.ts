import Fastify from 'fastify';
import fetch from 'node-fetch';
import { load } from 'cheerio';

interface QueryRequest {
  query?: string;
  imdb?: string;
  href?: string;
  limit?: number;
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

interface Item {
  id: string;
  title: string;
  type: 'movie' | 'series';
  year?: number;
  poster?: string;
  streams?: Stream[];
}

type PlayerVoice = {
  title?: string;
  file?: string;
  folder?: PlayerSeason[];
};

type PlayerSeason = {
  title?: string; // "1 сезон"
  folder?: PlayerEpisode[];
};

type PlayerEpisode = {
  title?: string; // "1 серія"
  file?: string;
  subtitle?: string;
  poster?: string;
};

const PORT = Number(process.env.PORT ?? 4200);
const BASE_URL = (process.env.ENEYIDA_BASE_URL ?? 'https://eneyida.tv').replace(/\/+$/, '');
const USER_AGENT =
  process.env.ENEYIDA_USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, imdb, href, limit = 10, season, episode, year } = request.body ?? {};
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
      const html = await search(normalizedQuery, request);
      if (html) {
        items.push(...parseSearch(html, limit));
      }
    }

    const filteredItems = year ? items.filter((i) => i.year === year) : items;

    // Enrich first result if streams are empty
    if (filteredItems[0] && (!filteredItems[0].streams || !filteredItems[0].streams.length) && filteredItems[0].id.startsWith('http')) {
      try {
        const detail = await loadDetail(filteredItems[0].id, request, season, episode);
        if (detail?.streams?.length) filteredItems[0].streams = detail.streams;
      } catch (err) {
        request.log.warn({ err }, 'eneyida enrich failed');
      }
    }

    const streams = filteredItems[0]?.streams ?? [];
    return { items: filteredItems, streams };
  } catch (err) {
    request.log.error({ err }, 'eneyida failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

async function search(query: string, request: any): Promise<string | null> {
  const searchUrl = `${BASE_URL}/index.php?do=search`;
  try {
    const res = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `do=search&subaction=search&story=${encodeURIComponent(query.replace(/ /g, '+'))}`,
    });
    if (!res.ok) {
      request.log.warn({ status: res.status }, 'eneyida search status');
      return null;
    }
    const html = await res.text();
    request.log.info({ query, len: html.length }, 'eneyida search html');
    return html;
  } catch (err) {
    request.log.warn({ err }, 'eneyida search error');
    return null;
  }
}

function parseSearch(html: string, limit: number): Item[] {
  const $ = load(html);
  const items: Item[] = [];

  $('article.short').each((_, el) => {
    if (items.length >= limit) return false;
    const title = $(el).find('a.short_title').text().trim();
    const href = $(el).find('a.short_title').attr('href');
    let poster = $(el).find('a.short_img img').attr('data-src') || $(el).find('img').attr('src');
    if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
    const yearMatch = $(el).text().match(/(19|20)\d{2}/);
    const year = yearMatch ? Number(yearMatch[0]) : undefined;
    if (href && title) {
      items.push({ id: href, title, type: 'movie', year, poster, streams: [] });
    }
  });

  if (!items.length) {
    const anchors = $('a.short_title, a[href*=".html"]').toArray().slice(0, limit);
    anchors.forEach((el) => {
      const link = $(el).attr('href');
      const title = ($(el).attr('title') || $(el).text() || '').trim();
      if (link && title) items.push({ id: link, title, type: 'movie', streams: [] });
    });
  }
  return items;
}

async function loadDetail(url: string, request: any, season?: number, episode?: number): Promise<Item | null> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`detail status ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const title = $('div.full_header-title h1').text().trim() || $('h1').first().text().trim() || url;
  let poster = $('.full_content-poster img').attr('src') || $('meta[property="og:image"]').attr('content') || $('img[itemprop="image"]').attr('src');
  if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
  const yearMatch = $('.full_info li').first().text().match(/(19|20)\d{2}/) || html.match(/(19|20)\d{2}/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;

  let iframeSrc = $('.tabs_b.visible iframe').attr('src') || $('iframe').attr('src') || '';
  if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;
  if (iframeSrc && iframeSrc.startsWith('/')) iframeSrc = BASE_URL + iframeSrc;

  let playerHtml = '';
  if (iframeSrc) {
    try {
      const origin = new URL(iframeSrc).origin;
      const p = await fetch(iframeSrc, { headers: { 'User-Agent': USER_AGENT, Referer: url, Origin: origin } });
      if (p.ok) playerHtml = await p.text();
      request.log.info({ iframeSrc, status: p.status }, 'eneyida iframe');
    } catch (err) {
      request.log.warn({ err, iframeSrc }, 'eneyida iframe error');
    }
  }

  const streams = extractStreams(playerHtml || html, season, episode, request);

  return {
    id: url,
    title,
    type: season !== undefined || episode !== undefined ? 'series' : 'movie',
    year,
    poster,
    streams,
  };
}

function extractStreams(html: string, season: number | undefined, episode: number | undefined, request: any): Stream[] {
  const streams: Stream[] = [];
  const filePart = pickConfigValue(html, 'file') ?? pickConfigValue(html, 'link');
  const subtitlesRaw = pickConfigValue(html, 'subtitle') ?? '';

  if (filePart) {
    const raw = filePart.replace(/&quot;/g, '"');
    addFromFilePayload(raw, season, episode, streams, request);
  }

  if (!streams.length) {
    const $ = load(html);
    $('source').each((_, el) => {
      const src = $(el).attr('src');
      if (src) pushStream(streams, src, 'source');
    });
  }

  // Fallback: capture any m3u8 links in page/iframe HTML
  if (!streams.length) {
    const m = html.match(/https?:[^"'\\s]+\\.m3u8/gi);
    if (m && m.length) {
      m.forEach((u) => pushStream(streams, u, undefined, 'eneyida'));
    }
  }
  // Fallback: capture any mp4 links
  if (!streams.length) {
    const m = html.match(/https?:[^"'\\s]+\\.(mp4|mkv|avi)/gi);
    if (m && m.length) m.forEach((u) => pushStream(streams, u, undefined, 'eneyida'));
  }

  if (subtitlesRaw && streams.length) {
    const subs = parseSubtitles(subtitlesRaw);
    if (subs.length) streams[0].subtitles = subs;
  }

  if (!streams.length) request?.log?.warn({ msg: 'no streams parsed', snippet: html.slice(0, 500) });
  return streams;
}

function addFromFilePayload(raw: string, season: number | undefined, episode: number | undefined, acc: Stream[], request: any) {
  const cleaned = raw.trim().replace(/;$/, '');
  const parsed = tryJson(cleaned, request);
  if (parsed) {
    addFromPlayerJson(parsed, season, episode, acc);
    return;
  }
  // If JSON failed, try to pull any http(s) links from the raw string
  const urls = Array.from(cleaned.matchAll(/https?:\/\/[^\s'"]+/g)).map((m) => m[0]);
  if (urls.length) {
    urls.forEach((u) => pushStream(acc, u, undefined, 'eneyida'));
  } else if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) {
    // only add as direct if it looks like a URL
    pushStream(acc, raw, undefined, 'eneyida');
  } else {
    request?.log?.warn({ msg: 'file payload not parsed', raw: raw.slice(0, 200) });
  }
}

function tryJson(text: string, request: any): any | null {
  try {
    const normalized = decodeEntities(text.trim()).replace(/'/g, '"');
    return JSON.parse(normalized);
  } catch (err) {
    request?.log?.warn({ err, raw: text.slice(0, 200) }, 'eneyida json parse failed');
    return null;
  }
}

function addFromPlayerJson(parsed: any, season: number | undefined, episode: number | undefined, acc: Stream[]) {
  if (Array.isArray(parsed)) {
    for (const voice of parsed as PlayerVoice[]) {
      if (voice.folder && voice.folder.length) {
        const ep = pickEpisode(voice.folder, season, episode);
        if (ep) {
          pushStream(acc, ep.file, voice.title || ep.title || 'episode', voice.title || 'eneyida');
          addSubs(acc, ep.subtitle);
          // don't return; continue to collect other voices
        }
      }
      if (voice.file) {
        pushStream(acc, voice.file, voice.title, voice.title);
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    // hdvb style: seasons/episodes keyed as S1E1, or voice map
    const values = Object.values(parsed as Record<string, any>);
    values.forEach((v) => {
      if (typeof v === 'string') pushStream(acc, v, undefined, 'eneyida');
      else if (v && typeof v === 'object' && 'file' in v) pushStream(acc, (v as any).file, v.title as string, 'eneyida');
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
    id: `eneyida-${acc.length}`,
    title: title || quality || 'Stream',
    url,
    quality,
    source: source || 'eneyida',
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

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function pickConfigValue(html: string, key: string): string | null {
  // Try quoted value, allowing nested quotes and newlines (lazy)
  const quoted = new RegExp(`${key}\\s*[:=]\\s*(['"])([\\s\\S]*?)\\1`, 'i').exec(html);
  if (quoted) return quoted[2];
  // Try unquoted JSON-like value until line break or comma/semicolon
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

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  fastify.log.error(err, 'Failed to start eneyida provider');
  process.exit(1);
});
