// Runs the Vercel entry point (api/index.js) on a local port, with an in-memory stand-in for the
// Upstash Redis REST API. Used by `npm run test:vercel`. Usage: node test/vercel-serve.mjs [port]
import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.argv[2] || 9800);
const REDIS_PORT = PORT + 102;

// ---- tiny Redis: just the commands KeyRouter's storage uses ----
const kv = new Map();
const hashes = new Map();
const expires = new Map();
const live = (k) => {
  const t = expires.get(k);
  if (t && Date.now() > t) (kv.delete(k), expires.delete(k));
  return kv.has(k);
};
function run([c, ...a]) {
  switch (String(c).toUpperCase()) {
    case 'GET':
      return live(a[0]) ? kv.get(a[0]) : null;
    case 'MGET':
      return a.map((k) => (live(k) ? kv.get(k) : null));
    case 'SET': {
      const opts = a.slice(2).map((x) => String(x).toUpperCase());
      if (opts.includes('NX') && live(a[0])) return null;
      kv.set(a[0], String(a[1]));
      const px = opts.indexOf('PX');
      if (px >= 0) expires.set(a[0], Date.now() + Number(a[2 + px + 1]));
      else expires.delete(a[0]);
      return 'OK';
    }
    case 'DEL':
      return a.reduce((n, k) => n + (kv.delete(k) ? 1 : 0), 0);
    case 'HGETALL':
      return [...(hashes.get(a[0]) || new Map())].flat();
    case 'HINCRBY': {
      const h = hashes.get(a[0]) || new Map();
      hashes.set(a[0], h);
      const v = Number(h.get(a[1]) || 0) + Number(a[2]);
      h.set(a[1], String(v));
      return v;
    }
    case 'HDEL': {
      const h = hashes.get(a[0]);
      return a.slice(1).reduce((n, f) => n + (h && h.delete(f) ? 1 : 0), 0);
    }
    default:
      throw new Error('unsupported command ' + c);
  }
}
const redis = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer test-token') return res.writeHead(401).end('{"error":"unauthorized"}');
    const cmds = JSON.parse(body);
    const out = (req.url === '/pipeline' ? cmds : [cmds]).map((c) => {
      try {
        return { result: run(c) };
      } catch (e) {
        return { error: String(e.message) };
      }
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url === '/pipeline' ? out : out[0]));
  });
});
await new Promise((r) => redis.listen(REDIS_PORT, '127.0.0.1', r));

process.env.ADMIN_KEY ||= 'admin-secret-123';
process.env.KV_REST_API_URL = 'http://127.0.0.1:' + REDIS_PORT;
process.env.KV_REST_API_TOKEN = 'test-token';
const { default: app } = await import('../api/index.js');

// ---- Node request -> web Request -> handler -> Node response ----
const server = http.createServer(async (req, res) => {
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request('http://127.0.0.1:' + PORT + req.url, {
      method: req.method,
      headers: Object.assign({}, req.headers, { 'x-real-ip': req.socket.remoteAddress }),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
    });
    const r = await app.fetch(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e));
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('vercel handler on http://127.0.0.1:' + PORT));
