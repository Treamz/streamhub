import Fastify from 'fastify';
import fetch from 'node-fetch';
import { load } from 'cheerio';

interface QueryRequest {
  query?: string;
  href?: string;
  limit?: number;
  season?: number;
  episode?: number;
  type?: 'movie' | 'series' | 'any';
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

const PORT = Number(process.env.PORT ?? 4300);
const BASE_URL = (process.env.UAFLIX_BASE_URL ?? 'https://uafix.net').replace(/\/+$/, '');
const USER_AGENT =
  process.env.UAFLIX_USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, href, limit = 10, season, episode, type, year } = request.body ?? {};
  if (!query && !href) {
    reply.code(400);
    return { error: 'Provide query or href' };
  }

  try {
    const items: Item[] = [];

    if (href) {
      const detail = await loadDetail(href, request, season, episode);
      if (detail) items.push(detail);
    }

    if (query) {
      const html = await search(query, request);
      if (html) items.push(...parseSearch(html, limit));
    }

    if (items[0] && (!items[0].streams || !items[0].streams.length) && items[0].id.startsWith('http')) {
      try {
        const detail = await loadDetail(items[0].id, request, season, episode);
        if (detail?.streams?.length) items[0].streams = detail.streams;
      } catch (err) {
        request.log.warn({ err }, 'uaflix enrich failed');
      }
    }

    const streams = items[0]?.streams ?? [];
    return { items, streams };
  } catch (err) {
    request.log.error({ err }, 'uaflix failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

async function search(query: string, request: any): Promise<string | null> {
  const url = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: baseHeaders() });
    if (!res.ok) {
      request.log.warn({ status: res.status }, 'uaflix search status');
      return null;
    }
    const html = await res.text();
    request.log.info({ query, len: html.length }, 'uaflix search html');
    return html;
  } catch (err) {
    request.log.warn({ err }, 'uaflix search error');
    return null;
  }
}

function parseSearch(html: string, limit: number): Item[] {
  const $ = load(html);
  const items: Item[] = [];
  $('.sres-wrap').each((_, el) => {
    if (items.length >= limit) return false;
    const title = $(el).find('.sres-text h2').text().trim();
    const href = $(el).attr('href');
    let poster = $(el).find('img').attr('src');
    if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
    const desc = $(el).text();
    const yearMatch = desc.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : undefined;
    if (href && title) {
      items.push({ id: href, title, type: 'movie', year, poster, streams: [] });
    }
  });
  return items;
}

async function loadDetail(url: string, request: any, season?: number, episode?: number): Promise<Item | null> {
  const res = await fetch(url, { headers: baseHeaders({ Referer: BASE_URL }) });
  if (!res.ok) throw new Error(`detail status ${res.status}`);
  const html = await res.text();
  const $ = load(html);

  const title = $('div.full_header-title h1').text().trim() || $('h1').first().text().trim() || url;
  let poster = $('meta[property="og:image"]').attr('content') || $('.full_content-poster img').attr('src') || $('img').attr('src');
  if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
  const yearMatch = html.match(/(19|20)\d{2}/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;

  const iframeSrcs: string[] = [];
  $('.tabs-b.video-box iframe, .video-box iframe').each((_, el) => {
    const src = $(el).attr('src');
    if (src) iframeSrcs.push(normalizeUrl(src));
  });

  const streams: Stream[] = [];
  for (const src of iframeSrcs) {
    const fetched = await fetchIframe(src, url, request, season, episode);
    streams.push(...fetched);
  }

  return {
    id: url,
    title,
    type: season !== undefined || episode !== undefined ? 'series' : 'movie',
    year,
    poster,
    streams,
  };
}

async function fetchIframe(src: string, referer: string, request: any, season?: number, episode?: number): Promise<Stream[]> {
  try {
    const res = await fetch(src, { headers: baseHeaders({ Referer: referer, Origin: new URL(src).origin }) });
    if (!res.ok) return [];
    const html = await res.text();

    // Ashdi JSON voices
    const ashdiJson = html.match(/file:\s*'\s*(\[\s*\{[\s\S]+?\}\s*\])'/);
    const fileVal = pickValue(html, 'file');
    const subsVal = pickValue(html, 'subtitle') || pickValue(html, 'subtitles') || '';

    const streams: Stream[] = [];

    if (ashdiJson) {
      const arr = safeJson(ashdiJson[1]);
      if (arr) addFromVoices(arr, season, episode, streams);
    } else if (fileVal) {
      const parsed = safeJson(fileVal);
      if (parsed) {
        addFromVoices(parsed, season, episode, streams);
      } else {
        // maybe direct m3u8
        const m3u8 = fileVal.match(/https?:[^'"\s]+\.m3u8/);
        if (m3u8) pushStream(streams, m3u8[0], undefined, src);
      }
    }

    // fallback: any m3u8 in iframe
    if (!streams.length) {
      const m = html.match(/https?:[^'"\s]+\.m3u8/);
      if (m) pushStream(streams, m[0], undefined, src);
    }

    // subtitles from subsVal
    if (subsVal && streams.length) {
      const subs = parseSubs(subsVal);
      if (subs.length) streams[0].subtitles = subs;
    }

    return streams;
  } catch (err) {
    request.log.warn({ err, src }, 'uaflix iframe fetch failed');
    return [];
  }
}

function addFromVoices(parsed: any, season: number | undefined, episode: number | undefined, acc: Stream[]) {
  if (Array.isArray(parsed)) {
    for (const voice of parsed as any[]) {
      const voiceName = voice.title || 'Voice';
      if (voice.folder && Array.isArray(voice.folder)) {
        const ep = pickEpisode(voice.folder, season, episode);
        if (ep?.file) {
          pushStream(acc, ep.file, ep.title || voiceName, voiceName);
          addSubs(acc, ep.subtitle);
          return;
        }
      }
      if (voice.file) {
        pushStream(acc, voice.file, voiceName, voiceName);
        return;
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
      pushStream(acc, v, k, 'uaflix');
    }
  }
}

function pickEpisode(folders: any[], season?: number, episode?: number) {
  const seasons = season !== undefined ? folders.filter((f) => numberFromTitle(f.title) === season) : folders;
  const s = seasons[0] ?? folders[0];
  if (!s) return null;
  const eps = s.folder || [];
  if (!eps.length) return null;
  if (episode !== undefined) {
    const match = eps.find((e: any) => numberFromTitle(e.title) === episode);
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
    id: `uaflix-${acc.length}`,
    title: title || quality || 'Stream',
    url,
    quality,
    source: source || 'uaflix',
  });
}

function addSubs(acc: Stream[], raw?: string) {
  if (!raw || !acc.length) return;
  const subs = parseSubs(raw);
  if (subs.length) acc[0].subtitles = subs;
}

function parseSubs(raw: string): { url: string; lang?: string; label?: string }[] {
  const out: { url: string; lang?: string; label?: string }[] = [];
  const regex = /\[([^\]]+)\](https?:[^,\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    out.push({ url: m[2], lang: m[1], label: m[1] });
  }
  return out;
}

function pickValue(html: string, key: string): string | null {
  const quoted = new RegExp(`${key}\\s*:\\s*['"]([^'"\\n]+)['"]`, 'i').exec(html);
  if (quoted) return quoted[1];
  const unquoted = new RegExp(`${key}\\s*:\\s*([^,;\\n]+)`, 'i').exec(html);
  if (unquoted) return unquoted[1].trim();
  return null;
}

function safeJson(str: string) {
  try {
    const normalized = str.replace(/\\'/g, "'").replace(/\\"/g, '"');
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function qualityFrom(val?: string) {
  if (!val) return undefined;
  const m = val.match(/(2160|1080|720|480|360)p?/);
  return m ? `${m[1]}p` : undefined;
}

function numberFromTitle(title?: string) {
  if (!title) return undefined;
  const m = title.match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function normalizeUrl(url: string) {
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return BASE_URL + url;
  return url;
}

function baseHeaders(extra: Record<string, string> = {}) {
  return { 'User-Agent': USER_AGENT, Referer: BASE_URL, ...extra };
}

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  fastify.log.error(err, 'Failed to start uaflix provider');
  process.exit(1);
});
