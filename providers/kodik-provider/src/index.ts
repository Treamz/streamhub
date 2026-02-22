import Fastify from 'fastify';
import fetch from 'node-fetch';
import { VideoLinks } from 'kodikwrapper';

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
  last_season?: number;
  last_episode?: number;
  material_data?: { poster_url?: string; title?: string; anime_title?: string };
  episodes?: Record<string, Record<string, string | { link: string }>>; // season -> episode -> link | {link}
}

interface KodikSearchResponse {
  results?: KodikResult[];
}

const PORT = Number(process.env.PORT ?? 4400);
const API_URL = (process.env.KODIK_API_URL ?? 'https://kodikapi.com').replace(/\/+$/, '');
const KODIK_TOKEN = process.env.KODIK_TOKEN ?? '';
const USER_AGENT = process.env.KODIK_USER_AGENT ?? 'StreamHub/0.1';
const DIRECT_CACHE_TTL_MS = Number(process.env.KODIK_DIRECT_CACHE_TTL_MS ?? 10 * 60 * 1000);
const CDN_IS_WORKING = (process.env.KODIK_CDN_IS_WORKING ?? 'false').toLowerCase();
const KODIK_VIDEO_INFO_ENDPOINT = '/ftor';

const directCache = new Map<string, { expiresAt: number; links: DirectLink[] }>();
const endpointCache = new Map<string, string>();
let cachedShift: number | null = null;

type DirectLink = { url: string; quality?: string };

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: QueryRequest }>('/query', async (request, reply) => {
  const { query, imdb, kinopoisk, season, episode, type = 'any', year, limit = 10 } = request.body ?? {};
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

    if (items[0]) return { items, streams: items[0].streams ?? [] };

    return { items, streams: [] };
  } catch (err) {
    request.log.error({ err }, 'kodik failed');
    reply.code(502);
    return { error: (err as Error).message };
  }
});

async function searchKodik(opts: { query?: string; imdb?: string; kinopoisk?: string | number; season?: number; episode?: number; limit: number }, request: any) {
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

async function extractStreams(group: KodikResult[], season: number | undefined, episode: number | undefined, request: any): Promise<Stream[]> {
  const streams: Stream[] = [];
  const seen = new Set<string>();

  for (const r of group) {
    let candidate: string | undefined;

    if (r.episodes && season && episode) {
      const seasonKey = String(season);
      const episodes = r.episodes[seasonKey];
      const ep = episodes ? episodes[String(episode)] : undefined;
      if (typeof ep === 'string') candidate = ep;
      else if (ep?.link) candidate = ep.link;
    }

    if (!candidate && r.link) candidate = r.link;
    if (!candidate) continue;

    const normalized = normalizeHttp(candidate);
    if (!normalized) continue;

    const voice = r.translation?.title?.trim();
    const direct = await resolveDirectLinks(normalized, request);
    if (!direct.length) continue;
    const variants = direct;

    for (const variant of variants) {
      const streamUrl = normalizeHttp(variant.url);
      if (!streamUrl || seen.has(streamUrl)) continue;
      seen.add(streamUrl);

      const title = season && episode
        ? `${`S${season}E${episode}`}${voice ? ` • ${voice}` : ''}`
        : (voice || variant.quality || 'Kodik');

      pushStream(streams, streamUrl, title, 'kodik-provider', variant.quality);
    }
  }

  return streams;
}

function pushStream(acc: Stream[], url?: string, title?: string, source?: string, quality?: string) {
  if (!url) return;
  const u = normalizeHttp(url);
  if (!u) return;
  const q = quality || qualityFrom(u);
  acc.push({ id: `kodik-${acc.length}`, title: title || q || 'Stream', url: u, quality: q, source: source || 'kodik' });
}

function qualityFrom(url: string): string | undefined {
  const m = url.match(/(2160|1080|720|480|360)p?/);
  return m ? `${m[1]}p` : undefined;
}

function groupResultsByTitle(results: KodikResult[]): KodikResult[][] {
  const grouped = new Map<string, KodikResult[]>();
  const orderedKeys: string[] = [];

  for (const r of results) {
    const key = groupKey(r);
    if (!grouped.has(key)) {
      grouped.set(key, []);
      orderedKeys.push(key);
    }
    grouped.get(key)!.push(r);
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
  const value = url.trim().replace(/\\\//g, '/');
  const normalized = value.startsWith('//') ? `https:${value}` : value;
  if (!/^https?:\/\//i.test(normalized)) return null;
  return normalized;
}

function extractIframeUrl(html: string, baseHost: string): string | null {
  const src = /<iframe[^>]+src=['"]([^"']+)['"]/i.exec(html)?.[1];
  if (!src) return null;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `${baseHost}${src}`;
  if (/^https?:\/\//i.test(src)) return src;
  return null;
}

async function resolveDirectLinks(candidateUrl: string, request: any): Promise<DirectLink[]> {
  const now = Date.now();
  const cached = directCache.get(candidateUrl);
  if (cached && cached.expiresAt > now) return cached.links;

  const links = await resolveDirectLinksUncached(candidateUrl, request);
  directCache.set(candidateUrl, { expiresAt: now + DIRECT_CACHE_TTL_MS, links });
  return links;
}

async function resolveDirectLinksUncached(candidateUrl: string, request: any): Promise<DirectLink[]> {
  return resolveDirectViaScriptFlow(candidateUrl, request);
}

async function resolveDirectViaScriptFlow(candidateUrl: string, request: any): Promise<DirectLink[]> {
  try {
    const pageUrl = new URL(candidateUrl);
    if (!pageUrl.searchParams.has('min_age')) pageUrl.searchParams.set('min_age', '16');
    if (!pageUrl.searchParams.has('first_url')) pageUrl.searchParams.set('first_url', 'false');

    const pageRes = await fetch(pageUrl.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: candidateUrl,
      },
    });
    if (!pageRes.ok) {
      request.log.warn({ candidateUrl, status: pageRes.status }, 'kodik script-flow page non-200');
      return [];
    }

    const html = await pageRes.text();
    const videoInfo = parseVideoInfoScriptFlow(html);
    if (!videoInfo) {
      request.log.warn({ candidateUrl }, 'kodik script-flow videoInfo not found');
      return [];
    }

    const playerScriptUrl = extractPlayerScriptUrlScriptFlow(html, pageUrl.toString());
    if (!playerScriptUrl) {
      request.log.warn({ candidateUrl }, 'kodik script-flow player script not found');
      return [];
    }

    const playerRes = await fetch(playerScriptUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: pageUrl.toString(),
      },
    });
    if (!playerRes.ok) {
      request.log.warn({ candidateUrl, playerScriptUrl, status: playerRes.status }, 'kodik script-flow player script non-200');
      return [];
    }

    const playerJs = await playerRes.text();
    const endpointPath = extractApiEndpointPathScriptFlow(playerJs) ?? '/ftor';
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

    const links = parseLinksScriptFlow(json.links as Record<string, Array<{ src?: string }>>);
    request.log.info({ candidateUrl, postUrl, parsed: links.length }, 'kodik script-flow parsed');
    return links;
  } catch (err) {
    request.log.warn({ err, candidateUrl }, 'kodik script-flow failed');
    return [];
  }
}

function parseVideoInfoScriptFlow(html: string): { type: string; hash: string; id: string } | null {
  const type = /(?:videoInfo|vInfo)\.type\s*=\s*'([^']+)'/i.exec(html)?.[1];
  const hash = /(?:videoInfo|vInfo)\.hash\s*=\s*'([^']+)'/i.exec(html)?.[1];
  const id = /(?:videoInfo|vInfo)\.id\s*=\s*'([^']+)'/i.exec(html)?.[1];
  if (!type || !hash || !id) return null;
  return { type, hash, id };
}

function extractPlayerScriptUrlScriptFlow(html: string, pageUrl: string): string | null {
  const path = /<script\s*type="text\/javascript"\s*src="\/(assets\/js\/app\.(?:player_single|serial)[^"]*)"/i.exec(html)?.[1]
    ?? /src=['"]([^"']*app\.(?:player_single|serial)[^"']+\.js[^"']*)['"]/i.exec(html)?.[1];
  if (!path) return null;

  if (path.startsWith('//')) return `https:${path}`;
  if (/^https?:\/\//i.test(path)) return path;

  const absolutePath = path.startsWith('/') ? path : `/${path}`;
  return new URL(absolutePath, pageUrl).toString();
}

function extractApiEndpointPathScriptFlow(playerJs: string): string | null {
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

function rotateLatinDecryptScriptFlow(input: string, shift: number): string {
  return String(input).replace(/[a-zA-Z]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const upper = code >= 65 && code <= 90;
    const base = upper ? 65 : 97;
    const pos = code - base;
    const newPos = (pos + 26 - shift) % 26;
    return String.fromCharCode(base + newPos);
  });
}

function decodeKodikSourceScriptFlow(source: string): string | null {
  if (!source) return null;
  if (/^https?:\/\//i.test(source) || source.startsWith('//')) {
    return source.replace(':hls:manifest.m3u8', '');
  }

  for (let shift = 1; shift <= 25; shift += 1) {
    const decoded = decodeBase64MaybeUrlSafe(rotateLatinDecryptScriptFlow(source, shift));
    if (!decoded) continue;
    if (!/^https?:\/\//i.test(decoded) && !decoded.startsWith('//')) continue;
    return decoded.replace(':hls:manifest.m3u8', '');
  }

  return null;
}

function parseLinksScriptFlow(linksObject: Record<string, Array<{ src?: string }>>): DirectLink[] {
  const out: DirectLink[] = [];
  const seen = new Set<string>();

  for (const [qualityRaw, sources] of Object.entries(linksObject || {})) {
    if (!Array.isArray(sources)) continue;
    const quality = `${String(qualityRaw).replace(/p$/i, '')}p`;

    for (const item of sources) {
      const src = item?.src;
      if (!src) continue;
      const decoded = decodeKodikSourceScriptFlow(src);
      const normalized = decoded ? normalizeHttp(decoded) : null;
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push({ quality, url: normalized });
    }
  }

  return out;
}

function seasonFromCandidate(_url: string): number | undefined {
  return undefined;
}

function episodeFromCandidate(url: string): number | undefined {
  const m = /episode=(\d+)/i.exec(url);
  return m ? Number(m[1]) : undefined;
}

async function resolveDirectViaLegacyPageFlow(
  candidateUrl: string,
  season: number | undefined,
  episode: number | undefined,
  request: any,
): Promise<DirectLink[]> {
  try {
    const url = new URL(candidateUrl);
    if (!url.searchParams.has('min_age')) url.searchParams.set('min_age', '16');
    if (!url.searchParams.has('first_url')) url.searchParams.set('first_url', 'false');
    if (season) url.searchParams.set('season', String(season));
    if (episode) url.searchParams.set('episode', String(episode));

    const pageRes = await fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT, Referer: candidateUrl } });
    if (!pageRes.ok) return [];
    const html = await pageRes.text();

    const urlParamsRaw = /var\s+urlParams\s*=\s*'([^']+)'/i.exec(html)?.[1];
    const videoType = /videoInfo\.type\s*=\s*'([^']+)'/i.exec(html)?.[1];
    const videoHash = /videoInfo\.hash\s*=\s*'([^']+)'/i.exec(html)?.[1];
    const videoId = /videoInfo\.id\s*=\s*'([^']+)'/i.exec(html)?.[1];
    const scriptPath = /src=['"]([^"']*app\.player[^"']+\.js[^"']*)['"]/i.exec(html)?.[1];
    if (!urlParamsRaw || !videoType || !videoHash || !videoId || !scriptPath) return [];

    let urlParams: Record<string, string>;
    try {
      urlParams = JSON.parse(urlParamsRaw) as Record<string, string>;
    } catch {
      return [];
    }

    const scriptUrl = new URL(scriptPath, url.origin).toString();
    const scriptRes = await fetch(scriptUrl, { headers: { 'User-Agent': USER_AGENT, Referer: url.toString() } });
    if (!scriptRes.ok) return [];
    const script = await scriptRes.text();
    const b64 = /type\s*:\s*["']POST["']\s*,\s*url\s*:\s*atob\(["']([^"']+)["']\)/i.exec(script)?.[1]
      ?? /url\s*:\s*atob\(["']([^"']+)["']\)/i.exec(script)?.[1];
    const postPath = b64 ? decodeBase64MaybeUrlSafe(b64) : null;
    if (!postPath) return [];

    const form = new URLSearchParams({
      hash: videoHash,
      id: videoId,
      type: videoType,
      d: urlParams.d ?? '',
      d_sign: urlParams.d_sign ?? '',
      pd: urlParams.pd ?? '',
      pd_sign: urlParams.pd_sign ?? '',
      ref: urlParams.ref ?? '',
      ref_sign: urlParams.ref_sign ?? '',
      bad_user: 'true',
      cdn_is_working: 'true',
      info: '{}',
    });

    const postUrl = new URL(postPath, url.origin).toString();
    const res = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: url.toString(),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: form.toString(),
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null) as any;
    if (!json || typeof json !== 'object' || typeof json.links !== 'object') return [];

    const links = parseLinksObjectKodikWrapper(json.links as Record<string, Array<{ src?: string }>>);
    request.log.info({ candidateUrl, parsed: links.length }, 'kodik legacy parsed');
    return links;
  } catch (err) {
    request.log.warn({ err, candidateUrl }, 'kodik legacy failed');
    return [];
  }
}

async function resolveDirectViaWrapperLibrary(link: string, request: any): Promise<DirectLink[]> {
  return runWrapperLibraryAttempt(link, request);
}

async function runWrapperLibraryAttempt(link: string, request: any): Promise<DirectLink[]> {
  try {
    request.log.info({ link }, 'kodik wrapper-lib start');

    const parsed = await VideoLinks.parseLink({ link, extended: true });
    request.log.info({
      link,
      parsed: {
        host: (parsed as any)?.host,
        type: (parsed as any)?.type,
        id: (parsed as any)?.id,
        hash: (parsed as any)?.hash,
        quality: (parsed as any)?.quality,
      },
      hasEx: Boolean((parsed as any)?.ex),
      hasPlayerSingleUrl: Boolean((parsed as any)?.ex?.playerSingleUrl),
    }, 'kodik wrapper-lib parseLink ok');

    const playerSingleUrl = parsed.ex?.playerSingleUrl;
    if (!playerSingleUrl) {
      request.log.warn({ link }, 'kodik wrapper-lib parseLink missing playerSingleUrl');
      return [];
    }

    request.log.info({ link, playerSingleUrl }, 'kodik wrapper-lib getActualVideoInfoEndpoint start');
    const endpoint = await VideoLinks.getActualVideoInfoEndpoint(playerSingleUrl);
    request.log.info({ link, endpoint }, 'kodik wrapper-lib getActualVideoInfoEndpoint ok');

    request.log.info({ link, endpoint }, 'kodik wrapper-lib getLinks start');
    const links = await VideoLinks.getLinks({ link, videoInfoEndpoint: endpoint });
    request.log.info({
      link,
      endpoint,
      qualities: links && typeof links === 'object' ? Object.keys(links) : [],
    }, 'kodik wrapper-lib getLinks ok');

    const parsedLinks = parseLinksObjectKodikWrapper(links as Record<string, Array<{ src?: string }>>);
    request.log.info({
      link,
      endpoint,
      parsed: parsedLinks.length,
      sample: parsedLinks.slice(0, 3),
    }, 'kodik wrapper-lib parsed');
    return parsedLinks;
  } catch (err) {
    request.log.warn({ err, link }, 'kodik wrapper-lib failed');
    return [];
  }
}

function parseKodikPlayerLink(link: string): { host: string; type: string; id: string; hash: string; quality: string } | null {
  const normalized = normalizeHttp(link);
  if (!normalized) return null;
  const m = /^(?:https?:)?\/\/([a-z0-9.-]+)\/([a-z]+)\/(\d+)\/([0-9a-z]+)\/(\d+p)(?:[/?#].*)?$/i.exec(normalized);
  if (!m) return null;
  return { host: m[1], type: m[2], id: m[3], hash: m[4], quality: m[5] };
}

async function resolveDirectViaKodikWrapper(
  link: string,
  origin: string,
  html: string,
  referer: string,
  request: any,
): Promise<DirectLink[]> {
  const parsed = parseKodikPlayerLink(link);
  if (!parsed) return [];

  const playerSingleUrl = extractPlayerSingleUrl(html, origin);
  if (!playerSingleUrl) {
    request.log.warn({ link }, 'kodik wrapper missing playerSingleUrl');
    return [];
  }

  const endpointPath = await getActualVideoInfoEndpointPath(playerSingleUrl, referer, request);
  if (!endpointPath) {
    request.log.warn({ link, playerSingleUrl }, 'kodik wrapper missing actual endpoint');
    return [];
  }

  const endpointUrl = new URL(
    `${endpointPath}?${new URLSearchParams({ type: parsed.type, id: parsed.id, hash: parsed.hash }).toString()}`,
    `https://${parsed.host}`,
  ).toString();

  try {
    const res = await fetch(endpointUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: referer || link,
        Accept: 'application/json, */*',
      },
    });
    if (!res.ok) {
      request.log.warn({ link, endpointUrl, status: res.status }, 'kodik wrapper non-200');
      return [];
    }

    const json = await res.json().catch(() => null) as any;
    const linksObject = (json && typeof json === 'object' && json.links && typeof json.links === 'object')
      ? json.links as Record<string, Array<{ src?: string }>>
      : null;
    if (!linksObject) return [];

    const links = parseLinksObjectKodikWrapper(linksObject);
    request.log.info({ link, endpointUrl, parsed: links.length }, 'kodik wrapper parsed');
    return links;
  } catch (err) {
    request.log.warn({ err, link, endpointUrl }, 'kodik wrapper failed');
    return [];
  }
}

function extractPlayerSingleUrl(html: string, host: string): string | null {
  const path = /src=['"](?<link>\/assets\/js\/app\.player_single\.[a-z0-9._-]+\.js(?:\?[^"']*)?)['"]/i.exec(html)?.groups?.link
    ?? /(?<link>\/assets\/js\/app\.player_single\.[a-z0-9._-]+\.js(?:\?[^"']*)?)/i.exec(html)?.groups?.link;
  if (!path) return null;
  return new URL(path, host).toString();
}

async function getActualVideoInfoEndpointPath(playerSingleUrl: string, referer: string, request: any): Promise<string | null> {
  try {
    const response = await fetch(playerSingleUrl, { headers: { 'User-Agent': USER_AGENT, Referer: referer } });
    if (!response.ok) return null;
    const js = await response.text();
    const b64 = /type:\s*"POST",\s*url:\s*atob\("([^"]+)"\)/i.exec(js)?.[1]
      ?? /type:\s*'POST',\s*url:\s*atob\('([^']+)'\)/i.exec(js)?.[1]
      ?? /url:\s*atob\(["']([^"']+)["']\)/i.exec(js)?.[1];
    const decoded = b64 ? decodeBase64MaybeUrlSafe(b64) : null;
    if (!decoded) return '/kor';
    try {
      return new URL(decoded, playerSingleUrl).pathname || '/kor';
    } catch {
      return decoded.startsWith('/') ? decoded : '/kor';
    }
  } catch (err) {
    request.log.warn({ err, playerSingleUrl }, 'kodik wrapper endpoint fetch failed');
    return null;
  }
}

function parseLinksObjectKodikWrapper(linksObject: Record<string, Array<{ src?: string }>>): DirectLink[] {
  const links: DirectLink[] = [];
  const seen = new Set<string>();

  for (const [qualityRaw, sources] of Object.entries(linksObject)) {
    if (!Array.isArray(sources)) continue;
    const quality = `${String(qualityRaw).replace(/p$/i, '')}p`;
    for (const source of sources) {
      if (!source?.src) continue;
      const decoded = decodeKodikSourceShift18(source.src);
      const normalized = decoded ? normalizeHttp(decoded) : null;
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      links.push({ url: normalized, quality });
    }
  }

  return links;
}

function decodeKodikSourceShift18(source: string): string | null {
  if (!source) return null;
  const decryptedBase64 = source.replace(/[a-zA-Z]/g, (e) => {
    let code = e.charCodeAt(0);
    const limit = code <= 'Z'.charCodeAt(0) ? 90 : 122;
    code += 18;
    return String.fromCharCode(code <= limit ? code : code - 26);
  });
  const decoded = decodeBase64MaybeUrlSafe(decryptedBase64);
  if (!decoded) return null;
  return decoded.replace(':hls:manifest.m3u8', '');
}

async function resolveDirectViaGetEndpoint(
  origin: string,
  endpointPath: string,
  parsed: { type: string; id: string; hash: string },
  request: any,
  candidateUrl: string,
): Promise<DirectLink[]> {
  try {
    const endpointUrl = new URL(
      `${endpointPath}?${new URLSearchParams({ type: parsed.type, id: parsed.id, hash: parsed.hash }).toString()}`,
      origin,
    ).toString();
    const res = await fetch(endpointUrl, { headers: { 'User-Agent': USER_AGENT, Referer: candidateUrl, Accept: 'application/json, */*' } });
    if (!res.ok) {
      request.log.warn({ candidateUrl, endpointUrl, status: res.status }, 'kodik direct get-endpoint non-200');
      return [];
    }

    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    request.log.info({ candidateUrl, endpointUrl, contentType, bodyPreview: text.slice(0, 140) }, 'kodik direct get-endpoint response');
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      request.log.warn({ candidateUrl, endpointUrl }, 'kodik direct get-endpoint invalid json');
      return [];
    }

    const linksObject = (json && typeof json === 'object' && json.links && typeof json.links === 'object')
      ? json.links as Record<string, Array<{ src?: string }>>
      : (json as Record<string, Array<{ src?: string }>>);

    const parsedLinks = parseLinksObject(linksObject);
    request.log.info({ candidateUrl, endpointUrl, parsed: parsedLinks.length }, 'kodik direct parsed get-endpoint');
    return parsedLinks;
  } catch (err) {
    request.log.warn({ err, candidateUrl, endpointPath }, 'kodik direct get-endpoint failed');
    return [];
  }
}

function parseLinksObject(linksObject: Record<string, Array<{ src?: string }>>): DirectLink[] {
  if (!linksObject || typeof linksObject !== 'object') return [];
  const links: DirectLink[] = [];
  const seen = new Set<string>();

  for (const [q, sources] of Object.entries(linksObject)) {
    if (!Array.isArray(sources)) continue;
    const quality = `${String(q).replace(/p$/i, '')}p`;
    for (const source of sources) {
      const src = source?.src;
      if (!src) continue;
      const direct = decodeKodikSource(src);
      const normalized = direct ? normalizeHttp(direct) : null;
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      links.push({ url: normalized, quality: /^(240|360|480|720|1080|2160)p$/.test(quality) ? quality : qualityFrom(normalized) });
    }
  }

  return links;
}

function parseVideoInfo(html: string): { type: string; hash: string; id: string } | null {
  const type = /videoInfo\.type=['"]([^'"]+)['"]/.exec(html)?.[1]
    ?? /["']type["']\s*:\s*["']([^"']+)["']/.exec(html)?.[1];
  const hash = /videoInfo\.hash=['"]([^'"]+)['"]/.exec(html)?.[1]
    ?? /["']hash["']\s*:\s*["']([^"']+)["']/.exec(html)?.[1];
  const id = /videoInfo\.id=['"]([^'"]+)['"]/.exec(html)?.[1]
    ?? /["']id["']\s*:\s*["']([^"']+)["']/.exec(html)?.[1];
  if (!type || !hash || !id) return null;
  return { type, hash, id };
}

async function resolveVideoInfoEndpoint(host: string, html: string, referer: string): Promise<string | null> {
  const cached = endpointCache.get(host);
  if (cached) return cached;

  const playerPath = /src=['"]\/(assets\/js\/app\.player_[^"'?]+\.js(?:\?[^"']*)?)['"]/.exec(html)?.[1]
    ?? /\/(assets\/js\/app\.player_[^"' ]+\.js(?:\?[^"']*)?)/.exec(html)?.[1];
  if (!playerPath) return null;

  const playerUrl = `${host}/${playerPath}`;
  const jsRes = await fetch(playerUrl, { headers: { 'User-Agent': USER_AGENT, Referer: referer } });
  if (!jsRes.ok) return null;
  const js = await jsRes.text();

  const encoded = /type\s*:\s*["']POST["']\s*,\s*url\s*:\s*atob\(["']([^"']+)["']\)/.exec(js)?.[1]
    ?? /url:\s*atob\(["']([^"']+)["']\)/.exec(js)?.[1];
  if (!encoded) return null;

  const decoded = decodeBase64MaybeUrlSafe(encoded);
  const endpoint = decoded ? (new URL(decoded, host).toString()) : null;
  if (!endpoint) return null;

  endpointCache.set(host, endpoint);
  return endpoint;
}

async function resolveVideoInfoEndpointPath(host: string, html: string, referer: string): Promise<string | null> {
  const full = await resolveVideoInfoEndpoint(host, html, referer);
  if (!full) return null;
  try {
    const u = new URL(full);
    return u.pathname || null;
  } catch {
    return full.startsWith('/') ? full : null;
  }
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

function parseSources(raw: string): DirectLink[] {
  const links: DirectLink[] = [];
  const seen = new Set<string>();
  const re = /"([0-9]{3,4})p?":\[\{"src":"([^"]+)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(raw)) !== null) {
    const quality = `${m[1]}p`;
    const direct = decodeKodikSource(m[2]);
    const normalized = direct ? normalizeHttp(direct) : null;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    links.push({ url: normalized, quality });
  }

  return links;
}

function parseSourcesLoose(raw: string): DirectLink[] {
  const links: DirectLink[] = [];
  const seen = new Set<string>();
  const re = /"src":"([^"]+)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(raw)) !== null) {
    const direct = decodeKodikSource(m[1]);
    const normalized = direct ? normalizeHttp(direct) : null;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    links.push({ url: normalized, quality: qualityFrom(normalized) });
  }

  return links;
}

function parseSignedParams(html: string): Record<string, string | undefined> {
  return {
    d: /domain=['"]([^'"]+)['"]/.exec(html)?.[1],
    d_sign: /d_sign=['"]([^'"]+)['"]/.exec(html)?.[1],
    pd: /pd=['"]([^'"]+)['"]/.exec(html)?.[1],
    pd_sign: /pd_sign=['"]([^'"]+)['"]/.exec(html)?.[1],
    ref: /ref=['"]([^'"]+)['"]/.exec(html)?.[1],
    ref_sign: /ref_sign=['"]([^'"]+)['"]/.exec(html)?.[1],
  };
}

function decodeKodikSource(source: string): string | null {
  if (!source) return null;
  if (/^https?:\/\//i.test(source) || source.startsWith('//')) {
    return source.replace(':hls:manifest.m3u8', '');
  }

  const shifted18 = rotateLatin(source, 18);
  const decoded18 = decodeBase64MaybeUrlSafe(shifted18);
  if (decoded18 && /^https?:\/\//i.test(decoded18)) {
    cachedShift = 18;
    return decoded18.replace(':hls:manifest.m3u8', '');
  }

  if (cachedShift !== null) {
    const cachedDecoded = decodeBase64MaybeUrlSafe(rotateLatin(source, cachedShift));
    if (cachedDecoded && /^https?:\/\//i.test(cachedDecoded)) {
      return cachedDecoded.replace(':hls:manifest.m3u8', '');
    }
  }

  for (let shift = 1; shift <= 26; shift += 1) {
    const decoded = decodeBase64MaybeUrlSafe(rotateLatin(source, shift));
    if (!decoded || !/^https?:\/\//i.test(decoded)) continue;
    cachedShift = shift;
    return decoded.replace(':hls:manifest.m3u8', '');
  }

  return null;
}

function rotateLatin(input: string, shift: number): string {
  return input.replace(/[a-zA-Z]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const upper = code >= 65 && code <= 90;
    const base = upper ? 65 : 97;
    return String.fromCharCode(((code - base + shift) % 26) + base);
  });
}

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  fastify.log.error(err, 'Failed to start kodik provider');
  process.exit(1);
});
