import fetch from 'node-fetch';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/get-direct-links.mjs <kodik_url>');
  process.exit(1);
}

const USER_AGENT = process.env.KODIK_USER_AGENT ?? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

function normalizeHttp(url) {
  const value = String(url || '').trim().replace(/\\\//g, '/');
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function decodeBase64MaybeUrlSafe(value) {
  try {
    let normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4 !== 0) normalized += '=';
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function rotateLatin(input, shift) {
  return String(input).replace(/[a-zA-Z]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const upper = code >= 65 && code <= 90;
    const base = upper ? 65 : 97;
    const pos = code - base;
    const newPos = (pos + 26 - shift) % 26;
    return String.fromCharCode(base + newPos);
  });
}

function decodeKodikSource(source) {
  if (!source) return null;
  if (/^https?:\/\//i.test(source) || source.startsWith('//')) {
    return source.replace(':hls:manifest.m3u8', '');
  }

  for (let shift = 1; shift <= 25; shift += 1) {
    const decoded = decodeBase64MaybeUrlSafe(rotateLatin(source, shift));
    if (!decoded) continue;
    if (!/^https?:\/\//i.test(decoded) && !decoded.startsWith('//')) continue;
    return decoded.replace(':hls:manifest.m3u8', '');
  }

  return null;
}

function parseVideoInfo(html) {
  const type = /(?:videoInfo|vInfo)\.type\s*=\s*'([^']+)'/i.exec(html)?.[1];
  const hash = /(?:videoInfo|vInfo)\.hash\s*=\s*'([^']+)'/i.exec(html)?.[1];
  const id = /(?:videoInfo|vInfo)\.id\s*=\s*'([^']+)'/i.exec(html)?.[1];
  if (!type || !hash || !id) return null;
  return { type, hash, id };
}

function extractPlayerScriptUrl(html, pageUrl) {
  const path = /<script\s*type="text\/javascript"\s*src="\/(assets\/js\/app\.(?:player_single|serial)[^"]*)"/i.exec(html)?.[1]
    ?? /src=['"]([^"']*app\.(?:player_single|serial)[^"']+\.js[^"']*)['"]/i.exec(html)?.[1];
  if (!path) return null;

  if (path.startsWith('//')) return `https:${path}`;
  if (/^https?:\/\//i.test(path)) return path;

  const absolutePath = path.startsWith('/') ? path : `/${path}`;
  return new URL(absolutePath, pageUrl).toString();
}

function extractApiEndpointPath(playerJs) {
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

function parseLinks(linksObject) {
  const out = [];
  const seen = new Set();

  for (const [qualityRaw, sources] of Object.entries(linksObject || {})) {
    if (!Array.isArray(sources)) continue;
    const quality = `${String(qualityRaw).replace(/p$/i, '')}p`;

    for (const item of sources) {
      const src = item?.src;
      if (!src) continue;
      const decoded = decodeKodikSource(src);
      const normalized = normalizeHttp(decoded);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push({ quality, url: normalized });
    }
  }

  return out;
}

async function getDirectLinks(kodikUrl) {
  const pageUrl = new URL(kodikUrl);
  if (!pageUrl.searchParams.has('min_age')) pageUrl.searchParams.set('min_age', '16');
  if (!pageUrl.searchParams.has('first_url')) pageUrl.searchParams.set('first_url', 'false');

  const pageRes = await fetch(pageUrl.toString(), {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: kodikUrl,
    },
  });
  if (!pageRes.ok) throw new Error(`page status ${pageRes.status}`);
  const html = await pageRes.text();

  const videoInfo = parseVideoInfo(html);
  if (!videoInfo) throw new Error('video info not found (videoInfo/vInfo)');

  const playerScriptUrl = extractPlayerScriptUrl(html, pageUrl.toString());
  if (!playerScriptUrl) throw new Error('player script URL not found');

  const playerRes = await fetch(playerScriptUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: pageUrl.toString(),
    },
  });
  if (!playerRes.ok) throw new Error(`player script status ${playerRes.status}`);
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
  if (!infoRes.ok) throw new Error(`video info status ${infoRes.status}`);

  const json = await infoRes.json().catch(() => null);
  if (!json || typeof json !== 'object' || typeof json.links !== 'object') {
    throw new Error('invalid video info response');
  }

  return parseLinks(json.links);
}

getDirectLinks(input)
  .then((links) => {
    if (!links.length) {
      console.log('No direct links found');
      process.exit(2);
    }

    for (const link of links) {
      console.log(`${link.quality}: ${link.url}`);
    }
  })
  .catch((err) => {
    console.error(`Error: ${err?.message || err}`);
    process.exit(1);
  });
