import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

interface QueryRequest {
  query?: string;
  imdb?: string;
  imdbId?: string;
  imdbid?: string; // allow camel or lower
  type?: 'movie' | 'series' | 'any';
  year?: number;
  season?: number;
  episode?: number;
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

interface ProviderResponse {
  items?: Item[];
  streams?: Stream[];
}

const PORT = Number(process.env.PORT ?? 8080);
const PROVIDER_ENDPOINTS = (process.env.PROVIDERS ?? 'http://sample-provider:4000/query,http://rezka-provider:4100/query,http://eneyida-provider:4200/query,http://uaflix-provider:4300/query')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

const fastify = Fastify({ logger: true });

await fastify.register(swagger, {
  openapi: {
    info: {
      title: 'StreamHub Core API',
      version: '0.1.0',
      description: 'Canonical /query endpoint used by adapters and providers',
    },
  },
});

await fastify.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: false,
  },
});

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', {
  schema: {
    summary: 'Canonical query',
    body: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        imdb: { type: 'string' },
        imdbId: { type: 'string' },
        imdbid: { type: 'string' },
        type: { type: 'string', enum: ['movie', 'series', 'any'] },
        year: { type: 'integer' },
        season: { type: 'integer' },
        episode: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                type: { type: 'string' },
                year: { type: 'integer' },
                imdb: { type: 'string' },
                overview: { type: 'string' },
                poster: { type: 'string' },
              },
            },
          },
          streams: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                url: { type: 'string' },
                quality: { type: 'string' },
                source: { type: 'string' },
              },
            },
          },
          providerErrors: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
      },
      400: { type: 'object', properties: { error: { type: 'string' } } },
      502: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
}, async (request, reply) => {
  const payload = request.body ?? {};
  const imdbNormalized = payload.imdb ?? payload.imdbId ?? payload.imdbid;

  if (!payload.query && !imdbNormalized) {
    reply.code(400);
    return { error: 'Provide at least query or imdb/imdbId' };
  }

  const normalizedPayload: QueryRequest = {
    ...payload,
    imdb: imdbNormalized,
  };

  const providerResults = await Promise.all(
    PROVIDER_ENDPOINTS.map(async (endpoint) => {
      // per-provider timeout to avoid hanging requests
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(normalizedPayload),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Provider ${endpoint} responded with ${response.status}`);
        }
        const data = (await response.json()) as ProviderResponse;
        return { endpoint, data };
      } catch (error) {
        const message = (error as Error).name === 'AbortError'
          ? 'Timed out after 8s'
          : (error as Error).message;
        request.log.error({ err: error, endpoint }, 'Provider call failed');
        return { endpoint, error: message };
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  const items: Item[] = [];
  const streams: Stream[] = [];
  const errors: Record<string, string> = {};

  for (const result of providerResults) {
    if ('data' in result && result.data) {
      items.push(...(result.data.items ?? []));
      streams.push(...(result.data.streams ?? []));
    }
    if ('error' in result && result.error) {
      errors[result.endpoint] = result.error;
    }
  }

  return {
    items,
    streams,
    providerErrors: Object.keys(errors).length ? errors : undefined,
  } satisfies ProviderResponse & { providerErrors?: Record<string, string> };
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start server');
    process.exit(1);
  });
