import Fastify from 'fastify';

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

interface ProviderResponse {
  items?: Item[];
  streams?: Stream[];
}

const PORT = Number(process.env.PORT ?? 8080);
const PROVIDER_ENDPOINTS = (process.env.PROVIDERS ?? 'http://sample-provider:4000/query')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const payload = request.body ?? {};
  if (!payload.query && !payload.imdb) {
    reply.code(400);
    return { error: 'Provide at least query or imdb' };
  }

  const providerResults = await Promise.all(
    PROVIDER_ENDPOINTS.map(async (endpoint) => {
      // per-provider timeout to avoid hanging requests
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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
