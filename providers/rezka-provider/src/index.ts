import Fastify from 'fastify';
import fetch from 'node-fetch';
import { load } from 'cheerio';

interface QueryRequest {
  query?: string;
  imdb?: string;
  type?: 'movie' | 'series' | 'any';
  year?: number;
  season?: number;
  episode?: number;
  limit?: number;
  href?: string; // direct rezka URL (optional)
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
  overview?: string;
  poster?: string;
  streams?: Stream[];
}

const PORT = Number(process.env.PORT ?? 4100);
const BASE_URL = (process.env.REZKA_BASE_URL ?? 'https://rezkaproxy.treamz.me').replace(/\/+$/, '');
const USER_AGENT =
  process.env.REZKA_USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, imdb, limit = 10, href } = request.body ?? {};

  // Treat imdb as search string if no explicit query; also allow direct URL in imdb field.
  const normalizedQuery = query ?? (imdb && imdb.startsWith('http') ? undefined : imdb);
  const normalizedHref = href ?? (imdb && imdb.startsWith('http') ? imdb : undefined);

  if (!normalizedQuery && !normalizedHref) {
    reply.code(400);
    return { error: 'Provide query or imdb or href for rezka search' };
  }

  try {
    const items: Item[] = [];

    if (normalizedHref) {
      const detail = await scrapeDetail(normalizedHref);
      if (detail) items.push(detail);
    }

    if (normalizedQuery) {
      const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&q=${encodeURIComponent(normalizedQuery)}`;
      const response = await fetch(searchUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!response.ok) throw new Error(`Search failed with ${response.status}`);
      const html = await response.text();
      request.log.info({ searchUrl, status: response.status, len: html.length }, 'rezka search fetched');
      const $ = load(html);

      $('.b-content__inline_item').each((_, el) => {
        if (items.length >= limit) return false;
        const $el = $(el);
        const title = $el.find('.b-content__inline_item-link').text().trim();
        const url = $el.find('a').attr('href');
        const poster = $el.find('img').attr('src');
        const typeText = $el.find('.info li').first().text().toLowerCase();
        const year = Number($el.find('.info li').eq(1).text());

        const type: Item['type'] = typeText.includes('сериал') ? 'series' : 'movie';
        const id = url ?? title;

        items.push({
          id,
          title,
          type,
          year: Number.isNaN(year) ? undefined : year,
          poster,
          streams: [],
        });
      });
    }

    if (!items.length) {
      request.log.warn({ query, href }, 'rezka search returned 0 items');
    }

    // Best-effort: fetch streams for the first item
    if (items[0] && items[0].id.startsWith('http')) {
      try {
        const detail = await scrapeDetail(items[0].id);
        if (detail?.streams?.length) items[0].streams = detail.streams;
      } catch (e) {
        request.log.warn({ err: e }, 'Failed to enrich first item with streams');
      }
    }

    const streams = items[0]?.streams ?? [];
    return { items, streams };
  } catch (error) {
    request.log.error({ err: error }, 'Rezka search failed');
    reply.code(502);
    return { error: (error as Error).message };
  }
});

async function scrapeDetail(url: string): Promise<Item | null> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Detail fetch failed ${response.status}`);
  const html = await response.text();
  const $ = load(html);

  const title = $('.b-post__title').text().trim() || $('meta[property="og:title"]').attr('content') || url;
  const poster = $('.b-sidecover img').attr('src') || $('meta[property="og:image"]').attr('content');
  const typeText = $('.b-post__info').text().toLowerCase();
  const type: Item['type'] = typeText.includes('сериал') ? 'series' : 'movie';
  const year = Number($('.b-post__info span[itemprop="dateCreated"]').text()) || undefined;

  const streams = extractStreamsFromHtml(html);
  if (!streams.length) {
    fastify.log.warn({ url }, 'rezka detail: no streams parsed (file subtitle missing?)');
  }

  return {
    id: url,
    title,
    type,
    year: Number.isNaN(year) ? undefined : year,
    poster,
    streams,
  };
}

function extractStreamsFromHtml(html: string): Stream[] {
  const fileMatch = html.match(/["']file["']\s*:\s*"([^"]+)"/);
  const subsMatch = html.match(/["']subtitle["']\s*:\s*"([^"]*)"/);
  if (!fileMatch) return [];
  const fileRaw = fileMatch[1].replace(/\\\//g, '/');
  const parts = fileRaw.split(',').map((p) => p.trim()).filter(Boolean);
  const streams: Stream[] = [];

  for (const part of parts) {
    const m = part.match(/\[(\d{3,4}p?)\](.+)/i);
    if (m) {
      const quality = m[1].toLowerCase().includes('p') ? m[1] : `${m[1]}p`;
      let url = m[2].trim();
      if (url.startsWith('//')) url = 'https:' + url;
      streams.push({
        id: `rezka-${quality}`,
        title: quality.toUpperCase(),
        url,
        quality,
        source: 'rezka',
      });
    } else if (part.startsWith('http')) {
      streams.push({
        id: `rezka-${streams.length}`,
        url: part,
        source: 'rezka',
      });
    }
  }

  if (streams.length === 0 && fileRaw.startsWith('http')) {
    streams.push({ id: 'rezka-0', url: fileRaw, source: 'rezka' });
  }

  if (subsMatch) {
    const subsRaw = subsMatch[1].replace(/\\\//g, '/');
    const subsParts = subsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const subtitles = subsParts
      .map((s) => {
        const sm = s.match(/\[(.*?)\](.+)/);
        if (!sm) return null;
        let url = sm[2].trim();
        if (url.startsWith('//')) url = 'https:' + url;
        return { url, lang: sm[1], label: sm[1] };
      })
      .filter(Boolean) as { url: string; lang?: string; label?: string }[];
    if (subtitles.length && streams.length) {
      streams[0].subtitles = subtitles;
    }
  }

  return streams;
}

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start rezka provider');
    process.exit(1);
  });
