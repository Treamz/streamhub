import { VideoLinks } from 'kodikwrapper';

const input = process.argv[2] || 'https://kodik.info/serial/72967/3742b08c6bb199e002d704dfd8197cc5/720p';

function variantsFromLink(link) {
  const out = [link];
  const m = /^(?:https?:)?\/\/([a-z0-9.-]+)\/([a-z]+)\/(\d+)\/([0-9a-z]+)\/(\d+p)/i.exec(link);
  if (!m) return out;
  const [, host, , id, hash, quality] = m;
  out.push(`https://${host}/video/${id}/${hash}/${quality}`);
  out.push(`https://aniqit.com/video/${id}/${hash}/${quality}`);
  return [...new Set(out)];
}

async function getLinksWithActualEndpoint(link) {
  const parsedLink = await VideoLinks.parseLink({ link, extended: true });

  if (!parsedLink.ex?.playerSingleUrl) {
    throw new Error('не могу получить ссылку на чанк с плеером');
  }

  const endpoint = await VideoLinks.getActualVideoInfoEndpoint(parsedLink.ex.playerSingleUrl);
  const links = await VideoLinks.getLinks({ link, videoInfoEndpoint: endpoint });

  return { parsedLink, endpoint, links };
}

(async () => {
  const attempts = variantsFromLink(input);

  for (const link of attempts) {
    console.log('\n=== TRY ===');
    console.log('link:', link);
    try {
      const res = await getLinksWithActualEndpoint(link);
      console.log('endpoint:', res.endpoint);
      console.log('playerSingleUrl:', res.parsedLink.ex.playerSingleUrl);
      console.log('qualities:', Object.keys(res.links || {}));
      console.log('links:', JSON.stringify(res.links, null, 2));
      return;
    } catch (err) {
      console.error('error:', err?.message || err);
    }
  }

  process.exitCode = 1;
})();
