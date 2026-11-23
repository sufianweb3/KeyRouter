// Two Vercel function instances share one Redis: a change made through one must show up in the other.
// Also checks the cron endpoint and the message shown when no database is connected.
// Run: node test/vercel-multi.mjs (starts its own Redis stand-in through test/vercel-serve.mjs).
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';

const A = 'admin-secret-123';
// Instance 1: a full local server (it also hosts the Redis stand-in on port 9902).
const proc = spawn('node', ['test/vercel-serve.mjs', '9800'], { stdio: 'ignore', detached: true });
// A mock provider with one free model.
const mock = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'free-model:free', pricing: { prompt: '0', completion: '0' } }] }));
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })));
});
await new Promise((r) => mock.listen(9903, '127.0.0.1', r));

try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch('http://127.0.0.1:9800/health')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  // Instance 2: a second, separate copy of the handler module in this process, same Redis.
  process.env.ADMIN_KEY = A;
  process.env.KV_REST_API_URL = 'http://127.0.0.1:9902';
  process.env.KV_REST_API_TOKEN = 'test-token';
  const { default: two } = await import('../api/index.js?instance=2');
  const viaTwo = async (method, path, body, key = A) => {
    const r = await two.fetch(new Request('http://x' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
    return { status: r.status, body: await r.json() };
  };
  const viaOne = async (method, path, body, key = A) => {
    const r = await fetch('http://127.0.0.1:9800' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  // provider added on instance 1 is visible on instance 2
  await viaOne('PUT', '/admin/providers/demo', { baseUrl: 'http://127.0.0.1:9903', billing: 'per-model' });
  await viaOne('POST', '/admin/providers/demo/keys', { key: 'demo-key-1234', label: '' });
  const cfg = await viaTwo('GET', '/admin/config');
  assert.equal(cfg.status, 200);
  assert.ok(cfg.body.providers.demo && cfg.body.providers.demo.keys.length === 1, 'instance 2 sees the provider added on instance 1');
  console.log('ok a provider added on one instance shows on the other');

  // agent key made on instance 2 works on instance 1, and usage from instance 1 shows on instance 2
  const rk = await viaTwo('POST', '/admin/router-keys', { label: 'agent', dailyCap: 0 });
  const key = rk.body.key;
  const chat = await viaOne('POST', '/v1/chat/completions', { model: 'demo/free-model:free', messages: [{ role: 'user', content: 'hello' }] }, key);
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  await new Promise((r) => setTimeout(r, 300));
  const dash = await viaTwo('GET', '/admin/dashboard');
  assert.ok(dash.body.totals.today.req >= 1, 'usage from instance 1 counted on instance 2: ' + JSON.stringify(dash.body.totals.today));
  console.log('ok agent keys and usage are shared between instances');

  // cron endpoint answers and runs only when something is due
  const cron = await viaTwo('GET', '/__cron');
  assert.equal(cron.status, 200);
  assert.equal(typeof cron.body.ran, 'boolean');
  console.log('ok cron endpoint');

  // no database: a clear message instead of a crash
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  const { default: bare } = await import('../api/index.js?instance=3');
  const nodb = await bare.fetch(new Request('http://x/admin/config', { headers: { authorization: 'Bearer ' + A } }));
  const msg = await nodb.json();
  assert.equal(nodb.status, 503);
  assert.match(msg.error.message, /Upstash Redis/);
  assert.equal((await bare.fetch(new Request('http://x/'))).status, 200, 'dashboard page still loads');
  console.log('ok missing database explained');

  console.log('\nVERCEL MULTI-INSTANCE CHECKS PASSED');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-proc.pid);
  } catch {}
  mock.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
