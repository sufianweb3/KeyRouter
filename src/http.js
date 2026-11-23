// Shared front door for both platforms: serves the dashboard files and passes everything else to the router.
// Cloudflare (src/index.js) and Vercel (api/index.js) only differ in how they reach the router and its storage.
import { json } from './router.js';

const PAGE_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://fonts.cdnfonts.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-api-key', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

// assets: { html, app }. route(request): the router's answer for /admin and /v1 calls.
export async function handle(request, assets, route) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (request.method === 'GET' && (p === '/' || p === '/index.html'))
    return new Response(assets.html, { headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, PAGE_HEADERS) });
  if (request.method === 'GET' && p === '/app.js')
    return new Response(assets.app, { headers: Object.assign({ 'content-type': 'text/javascript; charset=utf-8' }, PAGE_HEADERS) });
  if (p === '/health') return json(200, { ok: true });
  if (p === '/favicon.ico' || p === '/robots.txt') return new Response(p === '/robots.txt' ? 'User-agent: *\nDisallow: /\n' : null, { status: p === '/robots.txt' ? 200 : 204 });

  const isAdmin = p.startsWith('/admin/');
  if (request.method === 'OPTIONS') return isAdmin ? new Response(null, { status: 403 }) : new Response(null, { status: 204, headers: CORS });

  const res = await route(request);
  const out = new Response(res.body, res);
  if (isAdmin) out.headers.set('cache-control', 'no-store');
  else for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}
