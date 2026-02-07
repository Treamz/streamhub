import Fastify from 'fastify';

interface QueryRequest {
  query?: string;
  imdb?: string;
  type?: 'movie' | 'series' | 'any';
  limit?: number;
}

const PORT = Number(process.env.PORT ?? 4000);
const fastify = Fastify({ logger: true });

const MOCK_ITEMS = [
  {
    id: 'tt0133093',
    imdb: 'tt0133093',
    title: 'The Matrix',
    type: 'movie',
    year: 1999,
    overview: 'A hacker learns about the true nature of his reality.',
    poster: 'https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
    streams: [
      {
        id: 'matrix-hd',
        title: 'HD',
        url: 'https://example.com/matrix/1080p.m3u8',
        quality: '1080p',
        source: 'sample-provider',
      },
    ],
  },
  {
    id: 'tt2911666',
    imdb: 'tt2911666',
    title: 'John Wick',
    type: 'movie',
    year: 2014,
    overview: 'An ex-hitman comes out of retirement.',
    poster: 'https://image.tmdb.org/t/p/w500/fZPSd91yGE9fCcCe6OoQr6E3Bev.jpg',
    streams: [
      {
        id: 'john-wick-hd',
        title: 'HD',
        url: 'https://example.com/johnwick/1080p.m3u8',
        quality: '1080p',
        source: 'sample-provider',
      },
    ],
  },
];

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, imdb, type, limit = 10 } = request.body ?? {};
  if (!query && !imdb) {
    reply.code(400);
    return { error: 'Provide at least query or imdb' };
  }

  let results = MOCK_ITEMS;
  if (imdb) {
    results = results.filter((item) => item.imdb === imdb);
  }
  if (query) {
    const lowered = query.toLowerCase();
    results = results.filter((item) => item.title.toLowerCase().includes(lowered));
  }
  if (type && type !== 'any') {
    results = results.filter((item) => item.type === type);
  }

  return {
    items: results.slice(0, limit),
    streams: results.flatMap((i) => i.streams ?? []),
  };
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start provider');
    process.exit(1);
  });
