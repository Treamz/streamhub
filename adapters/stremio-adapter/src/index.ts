import Fastify from 'fastify';
import fetch from 'node-fetch';

const PORT = Number(process.env.PORT ?? 7000);
const CORE_URL = process.env.CORE_URL ?? 'http://core:8080';
const ADDON_ID = process.env.STREMIO_ID ?? 'org.streamhub';
const ADDON_NAME = process.env.STREMIO_NAME ?? 'StreamHub';
const LOGO = process.env.STREMIO_LOGO ?? '';

const fastify = Fastify({ logger: true });

interface CanonicalItem {
  id: string;
  title: string;
  type: 'movie' | 'series';
  year?: number;
  poster?: string;
}

interface CanonicalStream {
  id: string;
  title?: string;
  url: string;
  quality?: string;
  source?: string;
}

const manifest = {
  id: ADDON_ID,
  version: '0.1.0',
  name: ADDON_NAME,
  description: 'StreamHub canonical to Stremio adapter',
  logo: LOGO,
  resources: ['catalog', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { id: 'streamhub-any', type: 'movie', name: 'StreamHub Movies', extra: [{ name: 'search', isRequired: true }] },
    { id: 'streamhub-any', type: 'series', name: 'StreamHub Series', extra: [{ name: 'search', isRequired: true }] },
  ],
  behaviorHints: { configurable: true },
  config: [
    {
      key: 'debridProvider',
      title: 'Debrid provider',
      type: 'select',
      options: ['none', 'realdebrid'],
      default: 'none',
      required: false,
    },
    {
      key: 'debridToken',
      title: 'Debrid API token',
      type: 'text',
      required: false,
    },
  ],
};

fastify.get('/manifest.json', async () => manifest);

fastify.get('/stremio/configure', async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  const debridProvider = (query.debridProvider ?? 'realdebrid').toLowerCase();
  const debridToken = query.debridToken ?? query.token;

  if (!debridToken) {
    reply.code(400);
    return {
      err: 'debridToken (or token) query parameter required',
      example: '/stremio/configure?debridProvider=realdebrid&debridToken=YOUR_TOKEN',
    };
  }

  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  const proto = (request.headers['x-forwarded-proto'] as string) ?? request.protocol ?? 'http';
  const baseHttp = `${proto}://${host}/manifest.json`;
  const withParams = `${baseHttp}?debridProvider=${encodeURIComponent(debridProvider)}&debridToken=${encodeURIComponent(debridToken)}`;
  const stremioLink = `stremio://${withParams.replace(/^https?:\/\//, '')}`;

  // For browsers: show a tiny HTML page with the clickable stremio:// link and the plain HTTP URL.
  const html = `
    <html><body style="font-family: sans-serif">
      <p>Click to install in Stremio:</p>
      <p><a href="${stremioLink}">${stremioLink}</a></p>
      <p>If the link does not open, copy this URL into Stremio add-on install:</p>
      <code>${withParams}</code>
    </body></html>
  `;

  reply.type('text/html').send(html);
});

fastify.get('/catalog/:type/:id.json', async (request, reply) => {
  const { type, id } = request.params as { type: string; id: string };
  const query = request.query as Record<string, string>;
  const search = query.search;
  const year = query.year ? Number(query.year) : undefined;
  if (!search) {
    reply.code(400);
    return { err: 'search is required' };
  }

  const items = await queryCoreItems({ query: search, type, year });
  return {
    metas: items.map((item) => ({
      id: item.id,
      name: item.title,
      type: item.type,
      poster: item.poster,
      posterShape: 'poster',
      year: item.year,
    })),
  };
});

fastify.get('/stream/:type/:id.json', async (request, reply) => {
  const { id, type } = request.params as { id: string; type: string };
  const query = request.query as Record<string, string | undefined>;
  const season = query.season ? Number(query.season) : undefined;
  const episode = query.episode ? Number(query.episode) : undefined;
  const debridProvider = (query.debridProvider ?? 'none').toLowerCase();
  const debridToken = query.debridToken;
  const imdb = id.startsWith('tt') ? id : undefined;
  if (!imdb) {
    reply.code(400);
    return { err: 'Only imdb ids supported (tt...)' };
  }

  const streams = await queryCoreStreams({ imdb, type, season, episode });
  const processed = await maybeDebridStreams(streams, debridProvider, debridToken, request.log);

  return {
    streams: processed.map((stream) => ({
      name: stream.source ?? 'StreamHub',
      title: stream.title,
      url: stream.url,
      description: stream.quality,
    })),
  };
});

async function queryCoreItems(payload: { query?: string; imdb?: string; imdbId?: string; type?: string; season?: number; episode?: number; year?: number }) {
  const response = await fetch(`${CORE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Core responded with ${response.status}`);
  }
  const data = (await response.json()) as { items?: CanonicalItem[] };
  return data.items ?? [];
}

async function queryCoreStreams(payload: { query?: string; imdb?: string; imdbId?: string; type?: string; season?: number; episode?: number; year?: number }) {
  const response = await fetch(`${CORE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Core responded with ${response.status}`);
  }
  const data = (await response.json()) as { streams?: CanonicalStream[] };
  return data.streams ?? [];
}

async function maybeDebridStreams(streams: CanonicalStream[], provider: string, token: string | undefined, log: any) {
  if (!token || provider === 'none') return streams;
  if (provider !== 'realdebrid') return streams;

  const out: CanonicalStream[] = [];
  for (const stream of streams) {
    if (!stream.url?.startsWith('magnet:')) {
      out.push(stream);
      continue;
    }

    try {
      const debrided = await debridMagnetRealDebrid(stream.url, token);
      if (debrided) {
        out.push({
          ...stream,
          url: debrided,
          source: `${stream.source ?? 'StreamHub'} (RD)`,
        });
        continue;
      }
    } catch (err) {
      log.warn({ err }, 'debrid failed');
    }
    out.push(stream);
  }
  return out;
}

async function debridMagnetRealDebrid(magnet: string, token: string): Promise<string | undefined> {
  // 1) Add magnet, get torrent id
  const addRes = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ magnet }),
  });
  if (!addRes.ok) throw new Error(`RD addMagnet ${addRes.status}`);
  const { id } = (await addRes.json()) as { id: string };

  // 2) Fetch files to pick the largest video
  const info = await rdInfo(id, token);
  const videoFiles = info.files.filter((f) => f.path.match(/\.(mp4|mkv|avi|mov|m4v)$/i));
  if (!videoFiles.length) throw new Error('RD no video files');
  const target = videoFiles.sort((a, b) => b.bytes - a.bytes)[0];

  // 3) Select file
  await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ files: String(target.id) }),
  });

  // 4) Refresh info to get generated links
  const infoAfter = await rdInfo(id, token);
  const link = infoAfter.links?.[0];
  if (!link) throw new Error('RD no generated link');

  // 5) Unrestrict to direct URL
  const unRes = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ link }),
  });
  if (!unRes.ok) throw new Error(`RD unrestrict ${unRes.status}`);
  const un = (await unRes.json()) as { download?: string };
  return un.download;
}

async function rdInfo(id: string, token: string) {
  const res = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`RD info ${res.status}`);
  return (await res.json()) as { files: { id: number; path: string; bytes: number }[]; links?: string[] };
}

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    fastify.log.error(err, 'Failed to start stremio adapter');
    process.exit(1);
  });
