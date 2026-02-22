import Fastify from 'fastify';
import fetch from 'node-fetch';

interface QueryRequest {
  query?: string;
  imdb?: string;
  kinopoisk?: string | number;
  season?: number;
  episode?: number;
  type?: 'movie' | 'series' | 'any';
  year?: number;
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
  poster?: string;
  streams?: Stream[];
}

interface KodikResult {
  id: string;
  title?: string;
  title_orig?: string;
  imdb_id?: string;
  kinopoisk_id?: string;
  year?: number;
  link?: string;
  type?: string;
  translation?: { title?: string };
  material_data?: { poster_url?: string; title?: string; anime_title?: string };
  episodes?: Record<string, Record<string, string | { link: string }>>;
}

interface KodikSearchResponse {
  results?: KodikResult[];
}

type DirectLink = { url: string; quality?: string };

const PORT = Number(process.env.PORT ?? 4400);
const API_URL = (process.env.KODIK_API_URL ?? 'https://kodikapi.com').replace(/\/+$/, '');
const KODIK_TOKEN = process.env.KODIK_TOKEN ?? '';
const USER_AGENT = process.env.KODIK_USER_AGENT ?? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const DIRECT_CACHE_TTL_MS = Number(process.env.KODIK_DIRECT_CACHE_TTL_MS ?? 10 * 60 * 1000);

const directCache = new Map<string, { expiresAt: number; links: DirectLink[] }>();

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, imdb, kinopoisk, season, episode, year, limit = 10 } = request.body ?? {};

  if (!query && !imdb && !kinopoisk) {
    reply.code(400);
    return { error: 'Provide query or imdb or kinopoisk' };
  }

  if (!KODIK_TOKEN) {
    reply.code(500);
    return { error: 'KODIK_TOKEN not set' };
  }

  try {
    const results = await searchKodik({ query, imdb, kinopoisk, season, episode, limit }, request);
    const filteredResults = year ? results.filter((r) => r.year === year) : results;
    if (!filteredResults.length) return { items: [], streams: [] };

    const groups = groupResultsByTitle(filteredResults);
    const items: Item[] = await Promise.all(groups.map(async (group) => {
      const item = toItem(group[0]);
      item.streams = await extractStreams(group, season, episode, request);
      return item;
    }));

    return { items, streams: items[0]?.streams ?? [] };
  } catch (err) {
    request.log.error({ err }, 'kodik failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

async function searchKodik(
  opts: { query?: string; imdb?: string; kinopoisk?: string | number; season?: number; episode?: number; limit: number },
  request: any,
): Promise<KodikResult[]> {
  const params = new URLSearchParams();
  params.set('token', KODIK_TOKEN);
  params.set('limit', String(opts.limit));
  params.set('with_episodes', 'true');
  params.set('with_seasons', 'true');
  params.set('with_material_data', 'true');
  if (opts.imdb) params.set('imdb_id', opts.imdb);
  if (opts.kinopoisk) params.set('kinopoisk_id', String(opts.kinopoisk));
  if (opts.query) params.set('title', opts.query);
  if (opts.season) params.set('season', String(opts.season));
  if (opts.episode) params.set('episode', String(opts.episode));

  const url = `${API_URL}/search?${params.toString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`kodik status ${res.status}`);

  const data = (await res.json()) as KodikSearchResponse;
  request.log.info({ url, count: data.results?.length ?? 0 }, 'kodik search');
  return data.results ?? [];
}

function toItem(r: KodikResult): Item {
  const title = r.title || r.title_orig || 'Unknown';
  const poster = r.material_data?.poster_url;
  const type: Item['type'] = r.type?.includes('serial') ? 'series' : 'movie';
  return { id: r.id || r.link || title, title, type, year: r.year, poster, streams: [] };
}

function groupResultsByTitle(results: KodikResult[]): KodikResult[][] {
  const grouped = new Map<string, KodikResult[]>();
  const orderedKeys: string[] = [];

  for (const row of results) {
    const key = groupKey(row);
    if (!grouped.has(key)) {
      grouped.set(key, []);
      orderedKeys.push(key);
    }
    grouped.get(key)!.push(row);
  }

  return orderedKeys.map((key) => grouped.get(key)!).filter((group) => group.length > 0);
}

function groupKey(r: KodikResult): string {
  if (r.imdb_id) return `imdb:${r.imdb_id}`;
  if (r.kinopoisk_id) return `kinopoisk:${r.kinopoisk_id}`;
  const materialTitle = normalizeTitle(r.material_data?.anime_title || r.material_data?.title);
  const title = normalizeTitle(r.title);
  const originalTitle = normalizeTitle(r.title_orig);
  return `title:${materialTitle}|${title}|${originalTitle}`;
}

function normalizeTitle(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeHttp(url: string): string | null {
  const value = String(url || '').trim().replace(/\\\//g, '/');
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function qualityFrom(url: string): string | undefined {
  const m = url.match(/(2160|1080|720|480|360)p?/);
  return m ? `${m[1]}p` : undefined;
}

function pushStream(acc: Stream[], url?: string, title?: string, source?: string, quality?: string) {
  if (!url) return;
  const normalized = normalizeHttp(url);
  if (!normalized) return;
  const q = quality || qualityFrom(normalized);
  acc.push({ id: `kodik-${acc.length}`, title: title || q || 'Stream', url: normalized, quality: q, source: source || 'kodik' });
}

async function extractStreams(
  group: KodikResult[],
  season: number | undefined,
  episode: number | undefined,
  request: any,
): Promise<Stream[]> {
  const streams: Stream[] = [];
  const seen = new Set<string>();

  for (const row of group) {
    let candidate: string | undefined;

    if (row.episodes && season && episode) {
      const seasonKey = String(season);
      const ep = row.episodes[seasonKey]?.[String(episode)];
      if (typeof ep === 'string') candidate = ep;
      else if (ep?.link) candidate = ep.link;
    }

    if (!candidate && row.link) candidate = row.link;
    if (!candidate) continue;

    const normalizedCandidate = normalizeHttp(candidate);
    if (!normalizedCandidate) continue;

    const resolved = await resolveDirectLinks(normalizedCandidate, request);
    const voice = row.translation?.title?.trim();

    for (const direct of resolved) {
      const streamUrl = normalizeHttp(direct.url);
      if (!streamUrl || seen.has(streamUrl)) continue;
      seen.add(streamUrl);

      const title = season && episode
        ? `S${season}E${episode}${voice ? ` • ${voice}` : ''}`
        : (voice || direct.quality || 'Kodik');

      pushStream(streams, streamUrl, title, 'kodik-provider', direct.quality);
    }
  }

  return streams;
}

async function resolveDirectLinks(candidateUrl: string, request: any): Promise<DirectLink[]> {
  const now = Date.now();
  const cached = directCache.get(candidateUrl);
  if (cached && cached.expiresAt > now) return cached.links;

  const links = await resolveDirectViaScriptFlow(candidateUrl, request);
  directCache.set(candidateUrl, { expiresAt: now + DIRECT_CACHE_TTL_MS, links });
  return links;
}

async function resolveDirectViaScriptFlow(candidateUrl: string, request: any): Promise<DirectLink[]> {
  try {
    const pageUrl = new URL(candidateUrl);
    if (!pageUrl.searchParams.has('min_age')) pageUrl.searchParams.set('min_age', '16');
    if (!pageUrl.searchParams.has('first_url')) pageUrl.searchParams.set('first_url', 'false');

    const pageRes = await fetch(pageUrl.toString(), {
      headers: { 'User-Agent': USER_AGENT, Referer: candidateUrl },
    });
    if (!pageRes.ok) {
      request.log.warn({ candidateUrl, status: pageRes.status }, 'kodik script-flow page non-200');
      return [];
    }

    const html = await pageRes.text();
    const videoInfo = parseVideoInfo(html);
    if (!videoInfo) {
      request.log.warn({ candidateUrl }, 'kodik script-flow videoInfo not found');
      return [];
    }

    const playerScriptUrl = extractPlayerScriptUrl(html, pageUrl.toString());
    if (!playerScriptUrl) {
      request.log.warn({ candidateUrl }, 'kodik script-flow player script not found');
      return [];
    }

    const playerRes = await fetch(playerScriptUrl, {
      headers: { 'User-Agent': USER_AGENT, Referer: pageUrl.toString() },
    });
    if (!playerRes.ok) {
      request.log.warn({ candidateUrl, playerScriptUrl, status: playerRes.status }, 'kodik script-flow player script non-200');
      return [];
    }

    const playerJs = await playerRes.text();
    const endpointPath = extractApiEndpointPath(playerJs) ?? '/ftor';
    const postUrl = new URL(endpointPath, pageUrl.origin).toString();

    const form = new URLSearchParams({
      type: videoInfo.type,
      hash: videoInfo.hash,
      id: videoInfo.id,
      bad_user: 'True',
      info: '{}',
      cdn_is_working: 'True',
    });

    const infoRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Origin: pageUrl.origin,
        Referer: pageUrl.origin,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: form.toString(),
    });

    if (!infoRes.ok) {
      request.log.warn({ candidateUrl, postUrl, status: infoRes.status }, 'kodik script-flow video-info non-200');
      return [];
    }

    const json = await infoRes.json().catch(() => null) as any;
    if (!json || typeof json !== 'object' || typeof json.links !== 'object') {
      request.log.warn({ candidateUrl, postUrl }, 'kodik script-flow invalid response');
      return [];
    }

    const links = parseLinks(json.links as Record<string, Array<{ src?: string }>>);
    request.log.info({ candidateUrl, postUrl, parsed: links.length }, 'kodik script-flow parsed');
    return links;
  } catch (err) {
    request.log.warn({ err, candidateUrl }, 'kodik script-flow failed');
    return [];
  }
}

function parseVideoInfo(html: string): { type: string; hash: string; id: string } | null {
  const type = /(?:videoInfo|vInfo)\.type\s*=\s*'([^']+)'/i.exec(html)?.[1];
  const hash = /(?:videoInfo|vInfo)\.hash\s*=\s*'([^']+)'/i.exec(html)?.[1];
  const id = /(?:videoInfo|vInfo)\.id\s*=\s*'([^']+)'/i.exec(html)?.[1];
  if (!type || !hash || !id) return null;
  return { type, hash, id };
}

function extractPlayerScriptUrl(html: string, pageUrl: string): string | null {
  const path = /<script\s*type="text\/javascript"\s*src="\/(assets\/js\/app\.(?:player_single|serial)[^"]*)"/i.exec(html)?.[1]
    ?? /src=['"]([^"']*app\.(?:player_single|serial)[^"']+\.js[^"']*)['"]/i.exec(html)?.[1];
  if (!path) return null;

  if (path.startsWith('//')) return `https:${path}`;
  if (/^https?:\/\//i.test(path)) return path;

  const absolutePath = path.startsWith('/') ? path : `/${path}`;
  return new URL(absolutePath, pageUrl).toString();
}

function extractApiEndpointPath(playerJs: string): string | null {
  const b64 = /\$\.ajax\([^)]*url\s*:\s*atob\(["']([^"']+)["']\)/i.exec(playerJs)?.[1]
    ?? /type\s*:\s*["']POST["']\s*,\s*url\s*:\s*atob\(["']([^"']+)["']\)/i.exec(playerJs)?.[1]
    ?? /url\s*:\s*atob\(["']([^"']+)["']\)/i.exec(playerJs)?.[1];
  if (!b64) return null;

  const decoded = decodeBase64MaybeUrlSafe(b64);
  if (!decoded) return null;

  try {
    const u = new URL(decoded, 'https://kodik.info');
    return u.pathname || null;
  } catch {
    return decoded.startsWith('/') ? decoded : null;
  }
}

function parseLinks(linksObject: Record<string, Array<{ src?: string }>>): DirectLink[] {
  const out: Array<DirectLink & { qNum: number }> = [];
  const seen = new Set<string>();

  for (const [qualityRaw, sources] of Object.entries(linksObject || {})) {
    if (!Array.isArray(sources)) continue;
    const quality = `${String(qualityRaw).replace(/p$/i, '')}p`;

    for (const item of sources) {
      const src = item?.src;
      if (!src) continue;
      const decoded = decodeKodikSource(src);
      const normalized = decoded ? normalizeHttp(decoded) : null;
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const qNum = Number.parseInt(String(quality).replace(/p$/i, ''), 10);
      out.push({ quality, url: normalized, qNum: Number.isFinite(qNum) ? qNum : 0 });
    }
  }

  if (!out.length) return [];
  out.sort((a, b) => b.qNum - a.qNum);
  const best = out[0];
  return [{ url: best.url, quality: best.quality }];
}

function decodeKodikSource(source: string): string | null {
  if (!source) return null;
  if (/^https?:\/\//i.test(source) || source.startsWith('//')) {
    return source.replace(':hls:manifest.m3u8', '');
  }

  for (let shift = 1; shift <= 25; shift += 1) {
    const decoded = decodeBase64MaybeUrlSafe(rotateLatinDecrypt(source, shift));
    if (!decoded) continue;
    if (!/^https?:\/\//i.test(decoded) && !decoded.startsWith('//')) continue;
    return decoded.replace(':hls:manifest.m3u8', '');
  }

  return null;
}

function rotateLatinDecrypt(input: string, shift: number): string {
  return String(input).replace(/[a-zA-Z]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const upper = code >= 65 && code <= 90;
    const base = upper ? 65 : 97;
    const pos = code - base;
    const newPos = (pos + 26 - shift) % 26;
    return String.fromCharCode(base + newPos);
  });
}

function decodeBase64MaybeUrlSafe(value: string): string | null {
  try {
    let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4 !== 0) normalized += '=';
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  fastify.log.error(err, 'Failed to start kodik provider');
  process.exit(1);
});
