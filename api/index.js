// KeyRouter on Vercel. Same router and dashboard as the Cloudflare version (src/index.js);
// storage is Upstash Redis instead of a Durable Object. vercel.json sends every path here.
import { readFileSync } from 'node:fs';
import { KeyRouter, json } from '../src/router.js';
import { handle } from '../src/http.js';
import { RedisStorage, redisConfig } from '../src/redis-storage.js';

const ASSETS = {
  html: readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8'),
  app: readFileSync(new URL('../src/ui/app.txt', import.meta.url), 'utf8'),
};

// Keep work going after the response is sent (saving usage, scheduled checks).
let keepAlive = (p) => p;
try {
  const vf = await import('@vercel/functions');
  if (vf && vf.waitUntil) keepAlive = (p) => (vf.waitUntil(p), p);
} catch {
  // Not on Vercel (local tests): the process stays up anyway.
}

const ALARM_LOCK_MS = 280000;
let storage = null;
let router = null;

function envOf() {
  const e = process.env;
  return { BENCH_URL: e.BENCH_URL, BENCH_OFF: e.BENCH_OFF, ADMIN_KEY: e.ADMIN_KEY, KV_REST_API_URL: e.KV_REST_API_URL, KV_REST_API_TOKEN: e.KV_REST_API_TOKEN, UPSTASH_REDIS_REST_URL: e.UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN: e.UPSTASH_REDIS_REST_TOKEN };
}

// One router per function instance, rebuilt when another instance changed the stored data.
async function getRouter(env) {
  if (!storage) storage = new RedisStorage(redisConfig(env), keepAlive);
  const changed = await storage.sync();
  if (!router || changed) {
    let ready = Promise.resolve();
    const ctx = { storage, blockConcurrencyWhile: (fn) => (ready = fn()) };
    const r = new KeyRouter(ctx, env);
    await ready;
    router = r;
  }
  return router;
}

// Cloudflare wakes the Durable Object on its alarm. Here the scheduled work runs when a request
// arrives after it is due, plus once a day from the Vercel cron in vercel.json.
async function runDue(r, force) {
  const at = storage.alarm;
  if (!force && (at == null || Date.now() < at)) return false;
  if (!(await storage.lock(ALARM_LOCK_MS))) return false;
  try {
    await storage.deleteAlarm();
    await r.alarm();
    await storage.idle();
  } finally {
    await storage.unlock();
  }
  return true;
}

export default {
  async fetch(request) {
    const env = envOf();
    const p = new URL(request.url).pathname;
    const needsData = p.startsWith('/admin/') || p.startsWith('/v1') || p === '/__cron';
    if (needsData && !redisConfig(env))
      return json(503, { error: { message: 'No database connected. In your Vercel project open Storage, add Upstash Redis (free), connect it to this project, then redeploy.' } });

    if (p === '/__cron') {
      const r = await getRouter(env);
      const secret = process.env.CRON_SECRET;
      const force = !!secret && request.headers.get('authorization') === 'Bearer ' + secret;
      const ran = await runDue(r, force);
      return json(200, { ok: true, ran });
    }

    return handle(request, ASSETS, async (req) => {
      const r = await getRouter(env);
      const res = await r.fetch(req);
      if (storage.alarm != null && Date.now() >= storage.alarm) keepAlive(runDue(r, false).catch((e) => console.error(JSON.stringify({ message: 'scheduled work failed', error: String(e) }))));
      return res;
    });
  },
};
