// Provider logos. Known brands use the LobeHub icon set (MIT, github.com/lobehub/lobe-icons);
// any other provider gets the icon its own website shows. Results are cached by the router.

// Provider name -> LobeHub icon name, where the two differ.
const ALIASES = {
  gemini: 'gemini', google: 'gemini', github: 'github', kilo: 'kilocode', agnes: 'agnesai', together: 'together',
  zai: 'zai', zhipu: 'zhipu', moonshot: 'moonshot', kimi: 'kimi', xai: 'xai', grok: 'grok', qwen: 'qwen', alibaba: 'alibabacloud',
  huggingface: 'huggingface', hf: 'huggingface', workersai: 'workersai', cloudflare: 'cloudflare', vercel: 'vercel',
  siliconflow: 'siliconcloud', silicon: 'siliconcloud', fireworks: 'fireworks', deepinfra: 'deepinfra', novita: 'novita',
  nebius: 'nebius', hyperbolic: 'hyperbolic', featherless: 'featherless', sambanova: 'sambanova', cerebras: 'cerebras',
  nvidia: 'nvidia', mistral: 'mistral', cohere: 'cohere', deepseek: 'deepseek', openrouter: 'openrouter', groq: 'groq',
  ollama: 'ollama', chutes: 'chutes', chutas: 'chutes', longcat: 'longcat', opencode: 'opencode', aimlapi: 'aimlapi',
  aionlabs: 'aionlabs', agnesai: 'agnesai', perplexity: 'perplexity', openai: 'openai', anthropic: 'anthropic',
  claude: 'claude', minimax: 'minimax', stepfun: 'stepfun', baidu: 'baidu', venice: 'venice', pollinations: 'pollinations',
  poe: 'poe', replicate: 'replicate', azure: 'azure', bedrock: 'bedrock', vertex: 'vertexai', inference: 'inference',
  ionet: 'ionet', targon: 'targon', parasail: 'parasail', baseten: 'baseten', lambda: 'lambda', upstage: 'upstage',
  ai21: 'ai21', reka: 'reka', infermatic: 'infermatic', kluster: 'kluster', friendli: 'friendli', ppio: 'ppio',
  modelscope: 'modelscope', volcengine: 'volcengine', doubao: 'doubao', cometapi: 'cometapi', llmapi: 'llmapi',
  zenmux: 'zenmux', worldrouter: 'worldrouter', glama: 'glama', aihubmix: 'aihubmix', ai302: 'ai302', newapi: 'newapi',
};
// Brand names whose icon is a mark in one colour; the coloured version is used when there is one.
const CDN = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1/icons/';
const MAX = 150000;

// "api.groq.com" -> "groq.com", "oai.endpoints.kepler.ai.cloud.ovh.net" -> "ovh.net".
export function rootDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  // co.uk, com.cn and the like keep three labels.
  if (/^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join('.');
  return two;
}

function b64(buf) {
  let s = '';
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

function sniff(u, ct) {
  if (u[0] === 0x89 && u[1] === 0x50) return 'image/png';
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg';
  if (u[0] === 0x47 && u[1] === 0x49) return 'image/gif';
  if (u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57) return 'image/webp';
  if (u[0] === 0 && u[1] === 0 && (u[2] === 1 || u[2] === 2)) return 'image/x-icon';
  const head = new TextDecoder().decode(u.subarray(0, 400)).toLowerCase();
  if (head.includes('<svg')) return 'image/svg+xml';
  return /^image\//.test(ct || '') && !/html/.test(ct) ? ct.split(';')[0] : null;
}

async function grab(url, get) {
  try {
    const r = await get(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; KeyRouter/1.0; +https://github.com/sufianweb3/KeyRouter)', accept: 'image/*,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX) return null;
    const buf = await r.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX) return null;
    const u = new Uint8Array(buf);
    const type = sniff(u, r.headers.get('content-type'));
    if (!type) return null;
    return 'data:' + type + ';base64,' + b64(buf);
  } catch {
    return null;
  }
}

// Best icon link on a page: an SVG, then the largest PNG, then any icon.
function iconLinks(html, base) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
    if (!/icon/i.test(rel) || /mask-icon/i.test(rel)) continue;
    const href = (tag.match(/\bhref\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (!href || /^data:/i.test(href)) continue;
    const sizes = (tag.match(/\bsizes\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
    const px = Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0));
    const svg = /\.svg(\?|$)/i.test(href) || /svg/i.test(tag);
    let url;
    try {
      url = new URL(href, base).href;
    } catch {
      continue;
    }
    if (!/^https:/.test(url)) continue;
    out.push({ url, rank: svg ? 1000 : /apple-touch/i.test(rel) ? 500 + px : px || 32 });
  }
  return out.sort((a, b) => b.rank - a.rank).map((x) => x.url);
}

// Returns a data: URL, or null when no icon could be found.
export async function resolveLogo(name, baseUrl, fetcher) {
  const get = fetcher || fetch;
  const n = String(name || '').toLowerCase();
  const slugs = [];
  if (ALIASES[n]) slugs.push(ALIASES[n]);
  if (/^[a-z0-9-]{2,30}$/.test(n) && !slugs.includes(n)) slugs.push(n);
  for (const s of slugs) {
    const hit = (await grab(CDN + s + '-color.svg', get)) || (await grab(CDN + s + '.svg', get));
    if (hit) return hit;
  }
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  if (!host || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(host) || !host.includes('.')) return null;
  const root = rootDomain(host);
  for (const site of root === host ? [root] : [root, host]) {
    try {
      const r = await get('https://' + site + '/', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; KeyRouter/1.0)', accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (r.ok && /html/.test(r.headers.get('content-type') || '')) {
        const html = (await r.text()).slice(0, 200000);
        for (const u of iconLinks(html, r.url || 'https://' + site + '/').slice(0, 3)) {
          const hit = await grab(u, get);
          if (hit) return hit;
        }
      }
    } catch {
      // try the plain favicon next
    }
    const ico = await grab('https://' + site + '/favicon.ico', get);
    if (ico) return ico;
  }
  return null;
}
