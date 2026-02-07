import Fastify from 'fastify';
import fetch from 'node-fetch';
import cheerio from 'cheerio';

interface QueryRequest {
  query?: string;
  imdb?: string;
  type?: 'movie' | 'series' | 'any';
  limit?: number;
}

interface Stream {
  id: string;
  title?: string;
  url: string;
  quality?: string;
  source?: string;
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
const BASE_URL = process.env.REZKA_BASE_URL ?? 'https://rezka.ag';
const USER_AGENT = process.env.REZKA_USER_AGENT ?? 'StreamHubBot/0.1 (+https://github.com/)';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, limit = 10 } = request.body ?? {};
  if (!query) {
    reply.code(400);
    return { error: 'Provide query for rezka search' };
  }

  try {
    const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&q=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`Search failed with ${response.status}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    const items: Item[] = [];

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
        streams: [], // Stream extraction requires detail page parsing (TODO)
      });
    });

    return { items, streams: [] };
  } catch (error) {
    request.log.error({ err: error }, 'Rezka search failed');
    reply.code(502);
    return { error: (error as Error).message };
  }
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start rezka provider');
    process.exit(1);
  });
