// End-to-end: mock providers + the real Worker under `wrangler dev`, configured only through the admin API.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const calls = [];
const MODELS = {
  'C1-key-xxxx': [{ id: 'm-free:free', context_length: 131072 }, { id: 'm-paid', pricing: { prompt: '0.1', completion: '0.2' } }],
  'SA-key-xxxx': [{ id: 'qwen3.6-397b-a17b' }, { id: 'llama-3.1-8b-instant' }, { id: 'gemini-2.5-flash' }, { id: 'text-embedding-004' }, { id: 'gemini-3.8-live' }, { id: 'gemini-2.5-flash-native-audio-dialog' }, { id: 'gemini-2.5-flash-image-preview' }],
  'SB-key-xxxx': [
    { id: 'z-ai/glm-5.3:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 200000 },
    { id: 'openai/gpt-5', pricing: { prompt: '0.00001', completion: '0.00003' }, supported_parameters: ['tools'] },
    { id: 'qwen/qwen3-coder-next:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'weak/notools-model:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: [] },
  ],
  'SL-key-xxxx': [{ id: 'lim-model' }],
  'SH-key-xxxx': [{ id: 'hdr-model' }],
  'TK-key-xxxx': [{ id: 'tk-model' }],
  'TQ-key-xxxx': [{ id: 'q-model' }],
  'BT-key-xxxx': [{ id: 'vendor/model-alpha-2:free' }, { id: 'model-beta-1-instruct:free' }, { id: 'mystery-9b:free' }],
  'DM-key-xxxx': [{ id: 'dm-hinted' }, { id: 'dm-other' }],
  'LP-key-xxxx': [{ id: 'lp-special' }, { id: 'lp-plain' }],
  'RQ-key-xxxx': [{ id: 'q-model' }],
  'FB-key-xxxx': [{ id: 'locked', pricing: { prompt: '0', completion: '0' } }, { id: 'open', pricing: { prompt: '0', completion: '0' } }],
  'CR-key-xxxx': [{ id: 'pro-model', pricing: { prompt: '0.00001', completion: '0.00003' } }],
  'WT-key-xxxx': [{ id: 'wt-model', pricing: { prompt: '0', completion: '0' } }],
  'RP-key-xxxx': [{ id: 'rp-model', pricing: { prompt: '0', completion: '0' } }],
  '': [{ id: 'kl-free', pricing: { prompt: '0', completion: '0' } }, { id: 'kl-paid', pricing: { prompt: '0.00001', completion: '0.00002' } }],
  // OpenCode, IteraCompute and Infron style lists: prices in their own shapes
  'OC-key-xxxx': [
    { id: 'big-pickle', type: 'chat', cost: { text: { input: { price: 0 }, output: { price: 0 } } }, api: { 'chat-completions': {} } },
    { id: 'claude-opus-4-6', type: 'chat', cost: { text: { input: { price: 5 }, output: { price: 25 } } }, api: { messages: {} } },
    { id: 'gpt-5', type: 'chat', cost: { text: { input: { price: 1.25 }, output: { price: 10 } } }, api: { 'chat-completions': {} } },
    { id: 'jev-1.13', type: 'decision', cost: { text: { input: { price: 0.04 }, output: { price: 0 } } } },
    { id: 'z-ai/glm-5.3', is_free: false, pricing: { input: '0.82', output: '2.88' } },
    { id: 'qwen/qwen3.8-27b', is_free: true, pricing: { input: '0', output: '0' } },
    { id: 'openai/gpt-6-luna', min_prompt_price: 0.05, min_completion_price: 0.25, supported_endpoint_types: ['openai'] },
  ],
};
const SB_DAILY = { on: false };
const WT = { fail: 0 };
const GM = { lastSig: null };
const hasToolHistory = (body) => (body.messages || []).some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
const firstSig = (body) => {
  for (const m of body.messages || []) if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc.extra_content?.google?.thought_signature) return tc.extra_content.google.thought_signature;
  return null;
};
const GEMINI_400 = { error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.' } };
const limHits = [];
const HOOKS = [];
const QD = {};
const mock = http.createServer(async (req, res) => {
  const j = (s, o, h = {}) => {
    res.writeHead(s, { 'content-type': 'application/json', ...h });
    res.end(JSON.stringify(o));
  };
  // A small LMArena leaderboard, shaped like the Hugging Face datasets-server /filter answer.
  if (req.method === 'GET' && req.url.startsWith('/filter?')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const cat = (q.get('where').match(/'([a-z_]+)'/) || [])[1];
    const off = Number(q.get('offset'));
    const board = { overall: { 'Model Alpha 2 (High)': 1480, 'Model Beta 1': 1300 }, coding: { 'Model Alpha 2 (High)': 1400, 'Model Beta 1': 1560 }, math: { 'Model Alpha 2 (High)': 1450 }, hard_prompts: { 'Model Alpha 2 (High)': 1460 } };
    const rows = [];
    if (q.get('config') === 'text_style_control' && board[cat]) {
      for (const [n, r] of Object.entries(board[cat])) rows.push({ model_name: n, rating: r, category: cat, leaderboard_publish_date: '2026-11-22' });
      if (cat === 'overall') for (let i = 0; i < 30; i++) rows.push({ model_name: 'Filler Model ' + i, rating: 1000 + i, category: cat, leaderboard_publish_date: '2026-11-22' });
    }
    const page = rows.slice(off, off + 100).map((row, i) => ({ row_idx: off + i, row }));
    return j(200, { rows: page, num_rows_total: rows.length });
  }
  // Provider directory (shaped like the freellm.net files), OpenRouter benchmarks and a docs page.
  if (req.method === 'GET' && req.url === '/dir/status.json')
    return j(200, { catalog_updated_at: '2026-11-25', providers: [
      { provider: 'DirMock', slug: 'dirmock', status: 'Operational', free_models_count: 3, max_context: 131072, verified_protocols: ['OpenAI Chat Completions'], tagline: 'Mock free tier.', base_url: 'https://api.dirmock.example/v1', api_key_url: 'https://dirmock.example/keys' },
      { provider: 'Other One', slug: 'other-one', status: 'Operational', free_models_count: 9, max_context: 1000000, verified_protocols: ['OpenAI Chat Completions'], tagline: 'Another.', base_url: 'https://api.other.example/v1', api_key_url: 'https://other.example/keys' },
      { provider: 'Third', slug: 'third', status: 'Operational', free_models_count: 1, max_context: 0, verified_protocols: ['No public API'], tagline: '', base_url: '', api_key_url: '' },
    ] });
  if (req.method === 'GET' && req.url === '/dir/README.md') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(['<!-- BEGIN_PERMANENT_FREE -->', '| Provider | Free Models | Credit Card? | Max Context | Modalities | Get API Key |', '|---|---|---|---|---|---|',
      '| DirMock | 3 | No | 131K | Text | <a href="https://dirmock.example/keys">→</a> |', '| Other One | 9 | Phone verification | 1M | Text | - |', '<!-- END_PERMANENT_FREE -->',
      '<!-- BEGIN_BEST_MODELS -->', '| Provider | Best Free Model | Model ID | Max Context | Rate Limit |', '|---|---|---|---|---|',
      '| DirMock | <a href="x">Hinted</a> | `dm-hinted` | 131K | 12 RPM, 600 RPD |', '| | <a href="x">Other</a> | `dm-other2` | 131K | 12 RPM, 600 RPD |', '<!-- END_BEST_MODELS -->'].join('\n'));
  }
  // aifree.dev offers API: one provider also in freellm.net, one only here, one program that needs you to qualify.
  if (req.method === 'GET' && req.url.startsWith('/aifree/offers'))
    return j(200, { data: [
      { slug: 'dirmock-free', url: 'https://aifree.dev/offer/dirmock-free', name: 'DirMock Free API', provider: 'dirmock.example', vendorUrl: 'https://dirmock.example/keys', headline: 'Mock', theCatch: 'Limits may change.', freeType: 'free-tier', models: [], cardRequired: false, status: 'verified', riskStatus: 'clean', limits: [] },
      { slug: 'solo-free', url: 'https://aifree.dev/offer/solo-free', name: 'Solo AI Free Tier', provider: 'platform.solo.example', vendorUrl: 'https://platform.solo.example/signup?aff=abc&x=1', headline: 'Solo free', theCatch: 'Phone needed.', freeType: 'free-tier', apiBaseUrl: 'https://api.solo.example/v1', apiCompat: 'openai', models: [{ name: 'solo-1', apiId: 'solo-1', family: 'other', contextK: 128, rateLimit: { rpm: 20, rpd: 200 } }, { name: 'solo-img', apiId: 'solo-img', family: 'image', rateLimit: { rpm: 2 } }], cardRequired: false, status: 'verified', riskStatus: 'suspicious', limits: ['20 RPM'] },
      { slug: 'uni-pack', url: 'https://aifree.dev/offer/uni-pack', name: 'Uni Pack', provider: 'uni.example', freeType: 'student-program', models: [], status: 'verified' },
    ], meta: { total: 3, page: 1, pages: 1, license: 'CC BY 4.0' } });
  if (req.method === 'POST' && req.url === '/hook') {
    let hb = '';
    for await (const c of req) hb += c;
    HOOKS.push(JSON.parse(hb));
    return j(200, { ok: true });
  }
  if (req.method === 'GET' && req.url.startsWith('/api/v1/benchmarks'))
    return j(200, { data: [
      { source: 'artificial-analysis', model_permaslug: 'vendor/mystery-9b', display_name: 'Mystery 9B', intelligence_index: 60, coding_index: 55, agentic_index: 50 },
      { source: 'artificial-analysis', model_permaslug: 'vendor/model-alpha-2', display_name: 'Model Alpha 2', intelligence_index: 70, coding_index: 65, agentic_index: 60 },
      ...Array.from({ length: 12 }, (_, i) => ({ source: 'artificial-analysis', model_permaslug: 'x/filler-' + i, intelligence_index: 20 + i })),
    ], meta: {} });
  if (req.method === 'GET' && req.url === '/site/docs') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><body><h1>Free tier</h1><p>The free tier gives every account 7 requests per minute and 700 requests per day. No credit card is needed. Free models: lp-special. ' + 'Details about our platform and pricing. '.repeat(10) + '</p></body></html>');
  }
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    const k = (req.headers.authorization || '').slice(7);
    if (k === 'BAD-key-xxxx') return j(401, { error: { message: 'invalid api key' } });
    if (k === 'RL-key-xxxx') return j(429, { error: { message: 'Too many requests' } });
    if (k === 'NF-key-xxxx') return j(404, { error: 'not found' });
    return j(200, { data: MODELS[k] || [] });
  }
  let b = '';
  for await (const c of req) b += c;
  const body = JSON.parse(b);
  const key = (req.headers.authorization || '').slice(7);
  // The router asks one of its free models to read a provider's docs.
  if (String(body.messages?.[0]?.content || '').includes('FREE usage terms'))
    return j(200, { choices: [{ message: { role: 'assistant', content: 'Here it is: {"free_tier":true,"card_required":"no","limits":{"rpm":7,"rpd":700,"tpd":null},"free_tokens":null,"free_models":["lp-special"],"signup_url":"https://evil.example/steal","notes":"Seven requests a minute, no card."}' } }], usage: { prompt_tokens: 900, completion_tokens: 60 } });
  calls.push(key + ':' + body.model);
  if (key === 'FB-key-xxxx' && body.model === 'locked') return j(403, { error: { message: 'This model is not available on your plan' } });
  if (key === 'WT-key-xxxx' && WT.fail > 0) {
    WT.fail--;
    return j(429, { error: { message: 'Too many requests' } }, { 'retry-after': '2' });
  }
  if (key === 'CR-key-xxxx') return j(200, { choices: [{ message: { role: 'assistant', content: 'credit' } }], usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 } });
  if (key === 'TQ-key-xxxx' || key === 'RQ-key-xxxx') {
    QD[key] = (QD[key] || 0) + 1;
    if (QD[key] > 3) return j(429, { error: { message: key === 'TQ-key-xxxx' ? 'Daily token quota exceeded for this key' : 'Rate limit exceeded: requests per day' } });
  }
  if (key === 'A1-key-xxxx') return j(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
  if (key === 'A2-key-xxxx') return j(429, { error: { message: 'Rate limit exceeded, slow down' } }, { 'retry-after': '30' });
  if (key === 'B1-key-xxxx' && body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': PROCESSING\n\n');
    return res.end('data: {"error":{"code":429,"message":"Provider returned error: rate limited upstream"}}\n\n');
  }
  if (key === 'B1-key-xxxx') return j(200, { error: { code: 502, message: 'upstream died' } });
  if (key === 'C1-key-xxxx' && body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    return setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'), 50);
  }
  if (key === 'C1-key-xxxx' && body.messages?.[0]?.content === 'bad') return j(400, { error: { message: 'bad request' } });
  if (key === 'GM-key-xxxx') {
    GM.lastSig = firstSig(body);
    if (hasToolHistory(body) && !GM.lastSig) return j(400, [GEMINI_400]);
    return j(200, { choices: [{ message: { role: 'assistant', content: 'gemini ok' } }] });
  }
  if (key === 'GX-key-xxxx' && hasToolHistory(body)) return j(400, GEMINI_400);
  if (/live-broken/.test(body.model)) return j(400, [{ error: { code: 400, message: 'models/' + body.model + ' only supports real-time bidirectional streaming via WebSocket (bidiGenerateContent).', status: 'INVALID_ARGUMENT' } }]);
  if (key === 'SB-key-xxxx' && SB_DAILY.on) return j(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
  if (key === 'SL-key-xxxx') {
    const now = Date.now();
    limHits.push(now);
    if (limHits.filter((t) => t > now - 60000).length > 2) return j(429, { error: { message: 'Rate limit exceeded, slow down' } });
  }
  if (key === 'TK-key-xxxx' && body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"tok"}}]}\n\n');
    return res.end('data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":50,"total_tokens":250,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]\n\n');
  }
  if (key === 'TK-key-xxxx') return j(200, { choices: [{ message: { role: 'assistant', content: 'counted' } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
  if (key === 'SH-key-xxxx') return j(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '45s' });
  return j(200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'hi from ' + body.model } }] });
});
await new Promise((r) => mock.listen(9901, r));

fs.rmSync('test/.state', { recursive: true, force: true });
const TEST_ENV = { ADMIN_KEY: 'admin-secret-123', BENCH_URL: 'http://127.0.0.1:9901', BENCH_OR_URL: 'http://127.0.0.1:9901/api/v1', DIR_URL: 'http://127.0.0.1:9901/dir', AIFREE_URL: 'http://127.0.0.1:9901/aifree/offers', LEARN_LOCAL: '1' };
fs.writeFileSync('test/test.env', Object.entries(TEST_ENV).map(([k, v]) => k + '=' + v).join('\n') + '\n');
Object.assign(process.env, TEST_ENV);
// KR_TARGET=vercel runs the same checks against the Vercel entry point (api/index.js) with a local Redis stand-in.
const VERCEL = process.env.KR_TARGET === 'vercel';
const cmd = VERCEL ? ['node', ['test/vercel-serve.mjs', '9800']] : ['npx', ['wrangler', 'dev', '--port', '9800', '--ip', '127.0.0.1', '--env-file', 'test/test.env', '--persist-to', 'test/.state']];
const proc = spawn(cmd[0], cmd[1], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let out = '';
proc.stdout.on('data', (d) => (out += d));
proc.stderr.on('data', (d) => (out += d));

const B = 'http://127.0.0.1:9800';
for (let i = 0; i < 90; i++) {
  try {
    if ((await fetch(B + '/health')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
  if (i === 89) {
    console.log(out);
    throw new Error('worker did not start');
  }
}

const A = 'admin-secret-123';
const admin = async (method, path, body, key = A) => {
  const r = await fetch(B + '/admin/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let RK = '';
const post = (body, key = RK) => fetch(B + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const msgs = [{ role: 'user', content: 'hi' }];
const step = (n) => console.log('ok ' + n);
const chat = async (body) => {
  const r = await post(body);
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};

try {
  // UI is served with a strict CSP, no data without the admin key
  let r = await fetch(B + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await r.text(), /app\.js/);
  assert.equal((await fetch(B + '/app.js')).status, 200);
  step('dashboard served');

  // admin auth fails closed
  assert.equal((await admin('GET', 'config', null, 'wrong')).status, 401);
  assert.equal((await fetch(B + '/admin/config')).status, 401);
  let cfg = await admin('GET', 'config');
  assert.equal(cfg.status, 200);
  assert.ok(cfg.body.providers.openrouter, 'presets seeded');
  step('admin auth');

  // configure providers through the admin API
  const base = 'http://127.0.0.1:9901';
  for (const [n, extra] of [['a', { quotaScope: 'key' }], ['b', {}], ['b2', {}], ['c', { modelLimits: { rpm: 3 } }]])
    assert.equal((await admin('PUT', 'providers/' + n, { baseUrl: base, ...extra })).status, 200);
  assert.equal((await admin('PUT', 'providers/BAD NAME', { baseUrl: base })).status, 400);
  assert.equal((await admin('PUT', 'providers/x', { baseUrl: 'ftp://nope' })).status, 400);
  for (const [n, k] of [['a', 'A1-key-xxxx'], ['a', 'A2-key-xxxx'], ['b', 'B1-key-xxxx'], ['b2', 'B1-key-xxxx'], ['c', 'C1-key-xxxx']])
    assert.equal((await admin('POST', 'providers/' + n + '/keys', { key: k, label: 'test' })).status, 200);
  assert.equal((await admin('POST', 'providers/a/keys', { key: 'A1-key-xxxx' })).status, 400, 'duplicate key rejected');
  cfg = await admin('GET', 'config');
  const raw = JSON.stringify(cfg.body);
  assert.ok(!raw.includes('A1-key-xxxx') && !raw.includes('C1-key-xxxx'), 'full keys never returned');
  assert.equal(cfg.body.providers.a.keys[0].mask, '...xxxx');
  step('providers and keys via admin API, keys masked');

  // model discovery
  const ml = await admin('GET', 'providers/c/models');
  assert.equal(ml.body.count, 2);
  assert.ok(ml.body.models.find((m) => m.id === 'm-free:free').free);
  step('list models');

  // routes
  assert.equal((await admin('PUT', 'routes', { routes: { x: [{ provider: 'a' }] } })).status, 400, 'bad route rejected');
  const routes = {
    st: [{ provider: 'b2', model: 'm-b' }, { provider: 'c', model: 'm-c2' }],
    chain: [{ provider: 'a', model: 'm-a' }, { provider: 'b', model: 'm-b' }, { provider: 'c', model: 'm-c' }],
  };
  assert.equal((await admin('PUT', 'routes', { routes: { auto: routes.chain } })).status, 400, 'smart names reserved');
  assert.equal((await admin('PUT', 'routes', { routes })).status, 200);
  step('routes saved and validated');

  // agent key
  const created = await admin('POST', 'router-keys', { label: 'agent-1', dailyCap: 0 });
  RK = created.body.key;
  assert.match(RK, /^sk-router-[0-9a-f]{48}$/);
  assert.ok(!JSON.stringify(created.body.config).includes(RK), 'agent key not stored in plain text');
  step('agent key created');

  // router: auth
  assert.equal((await post({ model: 'chain', messages: msgs }, 'nope')).status, 401);

  // failover A1(daily) -> A2(429) -> B1(embedded error) -> C1
  r = await post({ model: 'chain', messages: msgs });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-provider'), 'c');
  assert.equal(r.headers.get('x-router-attempts'), '4');
  assert.match((await r.json()).choices[0].message.content, /m-c/);
  step('failover across 4 targets');

  calls.length = 0;
  r = await post({ model: 'chain', messages: msgs });
  assert.equal(r.headers.get('x-router-attempts'), '1');
  assert.deepEqual(calls, ['C1-key-xxxx:m-c']);
  step('paused keys skipped');

  r = await post({ model: 'chain', messages: msgs, stream: true });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /hel/);
  assert.match(text, /\[DONE\]/);
  step('streaming');

  r = await post({ model: 'chain', messages: msgs });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  step('all exhausted -> 429 with retry-after');

  r = await post({ model: 'c/other-model', messages: [{ role: 'user', content: 'bad' }] });
  assert.equal(r.status, 400);
  step('400 passthrough + direct provider/model');

  r = await post({ model: 'st', messages: msgs, stream: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-provider'), 'c');
  step('stream error-as-first-event fails over');

  r = await fetch(B + '/v1/models', { headers: { authorization: 'Bearer ' + RK } });
  const ml2 = (await r.json()).data;
  assert.ok(ml2.some((m) => m.id === 'auto') && ml2.some((m) => m.id === 'chain'));

  // status + reset
  let st = await admin('GET', 'status');
  assert.equal(st.body.providers.a[0].reason, 'daily quota');
  assert.ok(st.body.routerKeys[0].today >= 6);
  st = await admin('POST', 'reset', {});
  assert.equal(st.body.providers.a[0].blockedFor, 0);
  step('status per agent + reset cooldowns');

  // playground test endpoint
  const t = await admin('POST', 'test', { model: 'st', prompt: 'hello' });
  assert.equal(t.body.status, 200);
  assert.equal(t.body.provider, 'c');
  step('playground');

  // agent key daily cap + disable + delete
  const k2 = (await admin('POST', 'router-keys', { label: 'capped', dailyCap: 1 })).body;
  const id2 = k2.config.routerKeys.find((x) => x.label === 'capped').id;
  assert.notEqual((await post({ model: 'st', messages: msgs }, k2.key)).status, 401);
  r = await post({ model: 'st', messages: msgs }, k2.key);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, 'router_cap');
  await admin('PATCH', 'router-keys/' + id2, { enabled: false });
  assert.equal((await post({ model: 'st', messages: msgs }, k2.key)).status, 401);
  await admin('DELETE', 'router-keys/' + id2);
  assert.equal((await admin('GET', 'config')).body.routerKeys.length, 1);
  step('agent key cap, disable, delete');

  // config survives a restart of the Durable Object (persisted storage)
  await admin('DELETE', 'providers/b2');
  assert.ok(!(await admin('GET', 'config')).body.providers.b2);
  step('provider delete');

  // ---------- smart routing ----------
  await admin('PUT', 'providers/sa', { baseUrl: base, billing: 'free' });
  await admin('PUT', 'providers/sb', { baseUrl: base, billing: 'per-model', quotaScope: 'key' });
  await admin('POST', 'providers/sa/keys', { key: 'SA-key-xxxx' });
  await admin('POST', 'providers/sb/keys', { key: 'SB-key-xxxx' });
  let cat = (await admin('GET', 'catalog')).body;
  assert.equal(cat.providers.sa.count, 3, 'embedding, live, audio and image models skipped');
  assert.ok(!cat.models.some((m) => /live|audio|image/.test(m.id)));
  assert.ok(cat.models.find((m) => m.id === 'gemini-2.5-flash').cats.includes('vision'));
  assert.equal(cat.models.find((m) => m.id === 'openai/gpt-5').free, false);
  assert.equal(cat.top.general[0].model, 'z-ai/glm-5.3:free', 'strongest free model first');
  step('catalog built from keys, categories and free/paid tagged');

  const say = (content, model = 'auto', key = RK, extra = {}) => post(Object.assign({ model, messages: [{ role: 'system', content: 'You are a helpful agent' }, { role: 'user', content }] }, extra), key);
  r = await say('hi, how are you?');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-task'), 'general');
  assert.equal(r.headers.get('x-router-mode'), 'free');
  assert.equal(r.headers.get('x-router-model'), 'z-ai/glm-5.3:free');
  r = await say('fix this bug in server.ts, the build fails');
  assert.equal(r.headers.get('x-router-task'), 'coding');
  r = await say('plan a go-to-market strategy and compare the trade-offs');
  assert.equal(r.headers.get('x-router-task'), 'reasoning');
  r = await post({ model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is in this picture' }, { type: 'image_url', image_url: { url: 'data:x' } }] }] });
  assert.equal(r.headers.get('x-router-task'), 'vision');
  assert.equal(r.headers.get('x-router-model'), 'gemini-2.5-flash');
  step('auto detects task: general, coding, reasoning, vision');

  r = await say('hi', 'auto:best');
  assert.equal(r.headers.get('x-router-model'), 'openai/gpt-5');
  assert.equal(r.headers.get('x-router-paid'), '1');
  r = await say('hi', 'auto:mixed');
  assert.equal(r.headers.get('x-router-paid'), '0', 'mixed tries free first');
  r = await say('hi', 'general:free');
  assert.equal(r.headers.get('x-router-paid'), '0');
  step('modes: free, mixed (free first), best (strongest even if paid)');

  r = await say('hi', 'auto', RK, { tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] });
  assert.notEqual(r.headers.get('x-router-model'), 'weak/notools-model:free');
  step('tool calls skip models without tool support');

  // key created with Free only / Free + paid
  let kc = (await admin('POST', 'router-keys', { label: 'free-key', mode: 'free' })).body;
  assert.equal(kc.config.routerKeys.find((x) => x.label === 'free-key').mode, 'free');
  kc = (await admin('POST', 'router-keys', { label: 'mixed-key', mode: 'mixed' })).body;
  assert.equal(kc.config.routerKeys.find((x) => x.label === 'mixed-key').mode, 'mixed');
  r = await say('hi', 'auto', kc.key);
  assert.equal(r.headers.get('x-router-mode'), 'mixed');
  step('agent key created as Free only or Free + paid');

  // per-agent task and mode
  const ag = (await admin('POST', 'router-keys', { label: 'tech-team' })).body;
  const agId = ag.config.routerKeys.find((x) => x.label === 'tech-team').id;
  await admin('PATCH', 'router-keys/' + agId, { task: 'coding', mode: 'best' });
  r = await say('hello there', 'auto', ag.key);
  assert.equal(r.headers.get('x-router-task'), 'coding');
  assert.equal(r.headers.get('x-router-mode'), 'best');
  assert.equal((await admin('PATCH', 'router-keys/' + agId, { mode: 'nonsense' })).status, 400);
  step('per-agent task and mode');

  // your score wins, and switched-off models are skipped
  cat = (await admin('PUT', 'overrides', { key: 'sa/llama-3.1-8b-instant', score: 99 })).body;
  assert.equal(cat.top.general[0].model, 'llama-3.1-8b-instant');
  await admin('PUT', 'overrides', { key: 'sa/llama-3.1-8b-instant', score: null });
  cat = (await admin('PUT', 'overrides', { key: 'sb/z-ai/glm-5.3:free', off: true })).body;
  assert.ok(!cat.top.general.some((t) => t.model === 'z-ai/glm-5.3:free'));
  await admin('PUT', 'overrides', { key: 'sb/z-ai/glm-5.3:free', off: false });
  step('manual score and on/off per model');

  // paid daily cap
  let st0 = (await admin('GET', 'status')).body;
  await admin('PUT', 'settings', { paidDailyCap: st0.paidToday + 1 });
  r = await say('hi', 'auto:best');
  assert.equal(r.headers.get('x-router-paid'), '1');
  r = await say('hi', 'auto:best');
  assert.equal(r.headers.get('x-router-paid'), '0', 'cap reached, falls back to free');
  await admin('PUT', 'settings', { paidDailyCap: 0 });
  step('paid daily cap');

  // smart failover: top provider out of daily quota -> next strongest elsewhere
  SB_DAILY.on = true;
  r = await say('hi');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-provider'), 'sa');
  SB_DAILY.on = false;
  step('smart failover across providers');

  // learned limits: provider allows 2/min, router learns rpm=2
  await admin('PUT', 'providers/sl', { baseUrl: base, billing: 'free' });
  await admin('POST', 'providers/sl/keys', { key: 'SL-key-xxxx' });
  for (let i = 0; i < 3; i++) await post({ model: 'sl/lim-model', messages: msgs });
  st0 = (await admin('GET', 'status')).body;
  assert.equal(st0.providers.sl[0].models['lim-model'].learned.rpm, 2);
  step('learns per-minute limit from a 429');

  // rate-limit headers: remaining 0 pauses the key until reset
  await admin('PUT', 'providers/sh', { baseUrl: base, billing: 'free' });
  await admin('POST', 'providers/sh/keys', { key: 'SH-key-xxxx' });
  // the free test on key add already got "0 remaining", so the key is paused straight away
  r = await post({ model: 'sh/hdr-model', messages: msgs });
  assert.equal(r.status, 429, 'paused after provider said 0 remaining');
  st0 = (await admin('GET', 'status')).body;
  assert.equal(st0.providers.sh[0].reason, 'provider says 0 left');
  assert.ok(st0.providers.sh[0].blockedFor > 30);
  let dash = (await admin('GET', 'dashboard')).body;
  let shp = dash.providers.find((x) => x.name === 'sh');
  assert.equal(shp.status, 'limited');
  assert.deepEqual(shp.keys[0].rows, [{ what: 'requests', remaining: 0, reset: '45s' }]);
  step('reads rate-limit headers, dashboard shows limited');

  // connection checks: a bad key is reported, a good key with free models is ready
  await admin('PUT', 'providers/bad', { baseUrl: base, billing: 'free' });
  await admin('POST', 'providers/bad/keys', { key: 'BAD-key-xxxx' });
  await admin('PUT', 'providers/tk', { baseUrl: base, billing: 'free' });
  await admin('POST', 'providers/tk/keys', { key: 'TK-key-xxxx' });
  dash = (await admin('GET', 'dashboard')).body;
  const badp = dash.providers.find((x) => x.name === 'bad');
  assert.equal(badp.status, 'error');
  assert.match(badp.keys[0].check.error, /^Key rejected \(401\)/);
  const tkp = dash.providers.find((x) => x.name === 'tk');
  assert.equal(tkp.status, 'ready', JSON.stringify(tkp));
  assert.equal(tkp.freeTest.model, 'tk-model');
  assert.equal(tkp.free, 1);
  const chk = await admin('POST', 'providers/tk/check');
  assert.equal(chk.status, 200);
  assert.ok(chk.body.providers.find((x) => x.name === 'tk').freeTest.ok);
  step('provider checks: bad key reported, free models tested ready');

  // token accounting from provider usage, streamed or not, per provider and per agent key
  const before = (await admin('GET', 'dashboard')).body.totals.today;
  r = await post({ model: 'tk/tk-model', messages: msgs });
  assert.equal(r.status, 200);
  await r.text();
  r = await post({ model: 'tk/tk-model', messages: msgs, stream: true });
  assert.match(await r.text(), /\[DONE\]/);
  await new Promise((res) => setTimeout(res, 200));
  dash = (await admin('GET', 'dashboard')).body;
  assert.equal(dash.totals.today.p - before.p, 320);
  assert.equal(dash.totals.today.c - before.c, 80);
  const tkt = dash.providers.find((x) => x.name === 'tk').tokensToday;
  assert.equal(tkt.p, 120 + 120 + 200, 'one free test (Check keeps a fresh pass) + json + stream');
  assert.ok(dash.agentKeys.some((k) => k.tokensToday.p >= 320), 'agent key tokens counted');
  assert.ok(dash.topModels.some((m) => m.key === 'tk/tk-model'));
  assert.equal(dash.series.length, 14);
  step('tokens counted from usage (json and stream) per provider, model and agent key');

  // playground reports task and mode
  const t2 = await admin('POST', 'test', { model: 'auto', prompt: 'debug my python script' });
  assert.equal(t2.body.task, 'coding');
  step('playground shows detected task');

  // ---------- conversation history across models ----------
  await admin('PUT', 'providers/gemini', { baseUrl: base, billing: 'free' });
  await admin('POST', 'providers/gemini/keys', { key: 'GM-key-xxxx' });
  const toolHist = [
    { role: 'system', content: 'You are a helpful agent' },
    { role: 'user', content: 'look up my skills' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill_view', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ];
  r = await post({ model: 'gemini/gem-model', messages: toolHist });
  assert.equal(r.status, 200, 'gemini accepts history from another model');
  assert.equal(GM.lastSig, 'skip_thought_signature_validator');
  const signed = JSON.parse(JSON.stringify(toolHist));
  signed[2].tool_calls[0].extra_content = { google: { thought_signature: 'REAL-SIG' } };
  r = await post({ model: 'gemini/gem-model', messages: signed });
  assert.equal(GM.lastSig, 'REAL-SIG', 'real signatures are kept');
  step('gemini: missing thought signature filled in, real ones kept');

  await admin('PUT', 'providers/gx', { baseUrl: base, billing: 'free' });
  await admin('POST', 'providers/gx/keys', { key: 'GX-key-xxxx' });
  await admin('PUT', 'routes', { routes: Object.assign({}, routes, { hist: [{ provider: 'gx', model: 'gx-model' }, { provider: 'c', model: 'm-c3' }] }) });
  r = await post({ model: 'hist', messages: toolHist });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-provider'), 'c');
  st0 = (await admin('GET', 'status')).body;
  assert.ok(!st0.providers.gx[0].reason && !st0.providers.gx[0].models['gx-model'].reason, 'not penalized');
  step('provider that cannot read the history is skipped, not penalized');

  const conv = [{ role: 'system', content: 'You are a helpful agent' }, { role: 'user', content: 'hello sticky conversation' }];
  r = await post({ model: 'auto', messages: conv });
  const firstModel = r.headers.get('x-router-model');
  assert.ok(firstModel && firstModel !== 'llama-3.1-8b-instant');
  await admin('PUT', 'overrides', { key: 'sa/llama-3.1-8b-instant', score: 99 });
  r = await post({ model: 'auto', messages: conv.concat([{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'and next?' }]) });
  assert.equal(r.headers.get('x-router-model'), firstModel, 'ongoing conversation stays on its model');
  r = await post({ model: 'auto', messages: [{ role: 'user', content: 'a brand new chat' }] });
  assert.equal(r.headers.get('x-router-model'), 'llama-3.1-8b-instant', 'new conversation gets the new top pick');
  await admin('PUT', 'overrides', { key: 'sa/llama-3.1-8b-instant', score: null });
  step('conversation stays on one model');

  // a model that cannot do chat is paused for a day and the next one answers
  await admin('PUT', 'routes', { routes: Object.assign({}, routes, { liv: [{ provider: 'sa', model: 'x-live-broken' }, { provider: 'c', model: 'm-c4' }] }) });
  r = await post({ model: 'liv', messages: msgs });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-provider'), 'c');
  st0 = (await admin('GET', 'status')).body;
  assert.equal(st0.providers.sa[0].models['x-live-broken'].reason, 'model not usable for chat');
  assert.ok(st0.providers.sa[0].models['x-live-broken'].blockedFor > 80000);
  step('non-chat model paused for a day, next model answers');

  // custom provider saved as "free" still reads real prices: paid models never count as free or get the free test
  {
    await admin('PUT', 'providers/oc', { baseUrl: base, billing: 'free' });
    const r = await admin('POST', 'providers/oc/keys', { key: 'OC-key-xxxx', label: '' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ml = (await admin('GET', 'providers/oc/models')).body;
    const list = ml.models || ml;
    const by = Object.fromEntries(list.map((m) => [m.id, m]));
    assert.equal(by['big-pickle'].free, true);
    assert.equal(by['qwen/qwen3.8-27b'].free, true);
    for (const id of ['gpt-5', 'z-ai/glm-5.3', 'openai/gpt-6-luna']) assert.equal(by[id].free, false, id);
    assert.ok(!by['claude-opus-4-6'] && !by['jev-1.13'], 'non chat-completions models left out');
    const d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'oc');
    assert.equal(d.free, 2, JSON.stringify(d));
    assert.equal(d.paid, 3, JSON.stringify(d));
    assert.ok(d.freeTest && d.freeTest.ok && ['big-pickle', 'qwen/qwen3.8-27b'].includes(d.freeTest.model), JSON.stringify(d.freeTest));
    assert.ok(!calls.some((c) => /^OC-key-xxxx:(gpt-5|z-ai|openai|claude)/.test(c)), calls.filter((c) => c.startsWith('OC')).join());
    await admin('DELETE', 'providers/oc');
  }
  step('custom provider: prices from OpenCode, IteraCompute and Infron lists, paid never treated as free');

  // 403 on one model pauses that model only, not the whole key
  {
    await admin('PUT', 'providers/fb', { baseUrl: base, billing: 'per-model' });
    assert.equal((await admin('POST', 'providers/fb/keys', { key: 'FB-key-xxxx', label: '' })).status, 200);
    const r1 = await chat({ model: 'fb/locked', messages: [{ role: 'user', content: 'x' }] });
    assert.notEqual(r1.status, 200);
    const r2 = await chat({ model: 'fb/open', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'fb');
    assert.equal(d.keys[0].blockedFor, 0, 'key must not be paused');
    await admin('DELETE', 'providers/fb');
  }
  step('403 from one model pauses only that model');

  // free token allowance: paid models count as free until the tokens are used
  {
    await admin('PUT', 'providers/cr', { baseUrl: base, billing: 'per-model' });
    await admin('POST', 'providers/cr/keys', { key: 'CR-key-xxxx', label: '' });
    let d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'cr');
    assert.equal(d.free, 0);
    await admin('PUT', 'providers/cr', { allowance: { tokens: 100, per: 'once' } });
    d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'cr');
    assert.equal(d.free, 1, JSON.stringify(d));
    assert.equal(d.credit, 1);
    assert.equal(d.allowance.left, 100);
    const r = await chat({ model: 'cr/pro-model', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200);
    d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'cr');
    assert.equal(d.allowance.used, 120, JSON.stringify(d.allowance));
    assert.equal(d.allowance.left, 0);
    assert.equal(d.free, 0, 'allowance spent: paid again');
    await admin('DELETE', 'providers/cr');
  }
  step('free token allowance makes paid models free until spent');

  // keyless provider: no Authorization header, only free models kept
  {
    const r = await admin('POST', 'providers/kilo/keys', { keyless: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await admin('PUT', 'providers/kilo', { baseUrl: base });
    const ml = (await admin('GET', 'providers/kilo/models')).body;
    assert.deepEqual((ml.models || ml).map((m) => m.id), ['kl-free']);
    const c = await chat({ model: 'kilo/kl-free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.ok(calls.includes(':kl-free'), 'sent without a key');
    const bad = await admin('POST', 'providers/groq/keys', { keyless: true });
    assert.notEqual(bad.status, 200);
    const d = (await admin('GET', 'dashboard')).body;
    assert.ok(d.capacity && d.capacity.requests && d.capacity.tokens, 'capacity summary present');
    await admin('DELETE', 'providers/kilo');
  }
  step('keyless provider works without a key; capacity summary returned');

  // free tokens that refill every 5 hours
  {
    await admin('PUT', 'providers/cr', { baseUrl: base, billing: 'per-model' });
    await admin('POST', 'providers/cr/keys', { key: 'CR-key-xxxx', label: '' });
    const r = await admin('PUT', 'providers/cr', { allowance: { tokens: 500, per: '5h' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'cr');
    assert.equal(d.allowance.per, '5h');
    assert.ok(d.allowance.resetAt > Date.now() && d.allowance.resetAt <= Date.now() + 5 * 3600000 + 60000, JSON.stringify(d.allowance));
    await admin('DELETE', 'providers/cr');
  }
  step('5h / 9h / 12h allowance windows');

  // a short rate limit: the call waits for the slot instead of failing, and a real success proves the free models
  {
    await admin('PUT', 'providers/wt', { baseUrl: base, billing: 'per-model' });
    WT.fail = 1;
    await admin('POST', 'providers/wt/keys', { key: 'WT-key-xxxx', label: '' });
    let d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'wt');
    assert.equal(d.status, 'limited', JSON.stringify(d));
    const t0 = Date.now();
    const r = await post({ model: 'wt/wt-model', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200, await r.clone().text());
    assert.ok(Number(r.headers.get('x-router-waited')) > 1000, 'waited for the slot');
    assert.ok(Date.now() - t0 < 15000);
    d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'wt');
    assert.equal(d.status, 'ready', 'a real call marks free models working: ' + JSON.stringify(d));
    await admin('DELETE', 'providers/wt');
  }
  step('waits for a free slot; real calls count as a passed free test');

  // 1 request a minute: the /models call counts, so the free test waits its turn instead of failing
  {
    await admin('PUT', 'providers/rp', { baseUrl: base, billing: 'per-model', limits: { rpm: 1 } });
    await admin('POST', 'providers/rp/keys', { key: 'RP-key-xxxx', label: '' });
    const d = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'rp');
    assert.equal(d.status, 'limited', JSON.stringify(d));
    assert.match(d.statusText || '', /waits for the rate limit/, JSON.stringify(d));
    assert.ok(!calls.some((c) => c.startsWith('RP-key-xxxx')), 'no test call into the limit');
    await admin('DELETE', 'providers/rp');
  }
  step('free test waits for a 1-per-minute limit');

  // a daily cap on tokens is not a request limit: nothing learned. A request cap is learned,
  // and typing limits in by hand (or Clear pauses) drops the learned guess.
  {
    for (const [n, k] of [['tq', 'TQ-key-xxxx'], ['rq', 'RQ-key-xxxx']]) {
      await admin('PUT', 'providers/' + n, { baseUrl: base, billing: 'free' });
      await admin('POST', 'providers/' + n + '/keys', { key: k, label: '' });
      for (let i = 0; i < 5; i++) await post({ model: n + '/q-model', messages: [{ role: 'user', content: 'x' + i }] });
    }
    let st = (await admin('GET', 'status')).body;
    assert.ok(!st.providers.tq[0].learned.rpd, 'token quota learns no request limit: ' + JSON.stringify(st.providers.tq[0]));
    assert.ok(st.providers.rq[0].learned.rpd >= 1, 'request quota is learned: ' + JSON.stringify(st.providers.rq[0]));
    await admin('PUT', 'providers/rq', { limits: { rpd: 500 } });
    st = (await admin('GET', 'status')).body;
    assert.equal(st.providers.rq[0].learned.rpd, undefined, 'hand-set limit replaces the learned one: ' + JSON.stringify(st.providers.rq[0]));
    for (const n of ['tq', 'rq']) await admin('DELETE', 'providers/' + n);
  }
  step('token quotas learn no request limit; hand-set limits replace learned ones');

  // the capacity bar measures providers with a known limit only
  {
    const cap = (await admin('GET', 'dashboard')).body.capacity.requests;
    assert.ok(cap.usedKnown <= cap.limit && cap.usedKnown + cap.left === cap.limit, JSON.stringify(cap));
  }
  step('capacity: used and left add up to the limit');

  // scores come from the LMArena leaderboard; models it does not list are estimates and rank lower
  {
    await admin('PUT', 'providers/bt', { baseUrl: base, billing: 'free' });
    await admin('POST', 'providers/bt/keys', { key: 'BT-key-xxxx', label: '' });
    const cv = (await admin('POST', 'benchmarks/refresh', {})).body;
    assert.equal(cv.bench.published, '2026-11-22', JSON.stringify(cv.bench));
    const row = (id) => cv.models.find((m) => m.provider === 'bt' && m.id === id);
    assert.equal(row('vendor/model-alpha-2:free').src, 'lmarena');
    assert.equal(row('vendor/model-alpha-2:free').arena.rating, 1480);
    assert.equal(row('model-beta-1-instruct:free').src, 'lmarena');
    assert.equal(row('mystery-9b:free').src, 'estimate');
    const a = row('vendor/model-alpha-2:free');
    const b = row('model-beta-1-instruct:free');
    assert.ok(a.score > b.score, 'overall: alpha above beta ' + a.score + ' ' + b.score);
    assert.ok(b.arena.coding > a.arena.coding, 'coding board: beta above alpha');
    assert.ok(row('mystery-9b:free').score < b.score, 'estimate ranks below listed models');
    assert.match(cv.bench.openrouter.error, /OpenRouter key/);
    // with an OpenRouter key its benchmarks (Artificial Analysis) join in
    await admin('PUT', 'providers/openrouter', { baseUrl: base, billing: 'per-model' });
    await admin('POST', 'providers/openrouter/keys', { key: 'OR-key-xxxx', label: '' });
    const cv2 = (await admin('POST', 'benchmarks/refresh', {})).body;
    const row2 = (id) => cv2.models.find((m) => m.provider === 'bt' && m.id === id);
    assert.ok(cv2.bench.openrouter.models >= 10, JSON.stringify(cv2.bench.openrouter));
    assert.equal(row2('mystery-9b:free').src, 'openrouter');
    assert.equal(row2('mystery-9b:free').aa.intelligence, 60);
    assert.equal(row2('vendor/model-alpha-2:free').src, 'both');
    await admin('DELETE', 'providers/openrouter');
    await admin('DELETE', 'providers/bt');
  }
  step('model scores come from LMArena and OpenRouter benchmarks, per task, estimates marked');

  // provider directory: discover list, settings filled in on connect, your own limits kept
  {
    const dv = (await admin('POST', 'discover/refresh', {})).body;
    const dm = dv.providers.find((e) => e.id === 'dirmock');
    assert.ok(dm, JSON.stringify(dv).slice(0, 300));
    assert.equal(dm.card, 'No');
    assert.deepEqual(dm.limits, { rpm: 12, rpd: 600 });
    assert.equal(dm.keyUrl, 'https://dirmock.example/keys');
    assert.equal(dv.providers.find((e) => e.id === 'third').openai, false);
    await admin('PUT', 'providers/dirmock', { baseUrl: base, billing: 'per-model' });
    await admin('POST', 'providers/dirmock/keys', { key: 'DM-key-xxxx', label: '' });
    let p = (await admin('GET', 'dashboard')).body.providers.find((x) => x.name === 'dirmock');
    assert.deepEqual(p.limits, { rpm: 12, rpd: 600 }, JSON.stringify(p));
    assert.equal(p.auto.card, 'No');
    assert.equal(p.free, 1, 'dm-hinted counts free: the directory names it and the list shows no price');
    assert.equal((await admin('GET', 'discover')).body.providers.find((e) => e.id === 'dirmock').connected, 'dirmock');
    // limits you set win over the directory
    await admin('PUT', 'providers/dirmock', { limits: { rpm: 5 } });
    await admin('POST', 'discover/refresh', {});
    p = (await admin('GET', 'dashboard')).body.providers.find((x) => x.name === 'dirmock');
    assert.equal(p.limits.rpm, 5);
    assert.equal(p.limitsManual, true);
    await admin('DELETE', 'providers/dirmock');
  }
  step('directory: discover list, settings filled in on connect, hand-set limits kept');

  // aifree.dev joins the list: same provider merged, new ones added, programs you must qualify for left out
  {
    const dv = (await admin('GET', 'discover')).body;
    const dm = dv.providers.find((e) => e.id === 'dirmock');
    assert.deepEqual(dm.sources, ['freellm', 'aifree']);
    assert.equal(dm.catch, 'Limits may change.');
    assert.equal(dm.offerUrl, 'https://aifree.dev/offer/dirmock-free');
    const solo = dv.providers.find((e) => e.id === 'solo');
    assert.ok(solo, JSON.stringify(dv.providers.map((e) => e.id)));
    assert.equal(solo.baseUrl, 'https://api.solo.example/v1');
    assert.equal(solo.keyUrl, 'https://platform.solo.example/signup?x=1', 'referral parameter removed');
    assert.equal(solo.risk, 'suspicious');
    assert.deepEqual(solo.limits, { rpm: 20, rpd: 200 });
    assert.deepEqual(solo.models.map((m) => m.id), ['solo-1'], 'image models left out');
    assert.ok(!dv.providers.find((e) => e.id === 'uni'), 'student program left out');
    assert.equal(dv.sources.find((x) => x.id === 'aifree').n, 2);
    assert.equal(dv.sources.find((x) => x.id === 'aifree').license, 'CC BY 4.0');
  }
  step('aifree.dev offers merged into Discover');

  // reading a provider's own docs with a free model
  {
    await admin('PUT', 'providers/lp', { baseUrl: base, billing: 'per-model', docs: base + '/site/docs' });
    await admin('POST', 'providers/lp/keys', { key: 'LP-key-xxxx', label: '' });
    const r = (await admin('POST', 'providers/lp/learn', {})).body;
    assert.equal(r.result, 'learned', JSON.stringify(r).slice(0, 300));
    const p = r.dashboard.providers.find((x) => x.name === 'lp');
    assert.deepEqual(p.limits, { rpm: 7, rpd: 700 });
    assert.equal(p.auto.card, 'No');
    assert.equal(p.auto.signupUrl, null, 'a sign-up link to another site is dropped');
    assert.ok(p.auto.log.length >= 1 && /RPM/.test(p.auto.log[0].text), JSON.stringify(p.auto.log));
    assert.equal(p.free, 1, 'lp-special is free per the docs');
    const r2 = (await admin('POST', 'providers/lp/learn', {})).body;
    assert.equal(r2.result, 'learned', 'forced read runs again');
    await admin('PUT', 'providers/lp', { autoUpdate: false });
    assert.equal((await admin('GET', 'dashboard')).body.providers.find((x) => x.name === 'lp').autoUpdate, false);
    await admin('DELETE', 'providers/lp');
  }
  step('website or docs read by a free model into limits and free models; off switch');

  // a 429 while checking a key is a rate limit, not a broken key; a 404 points at the base URL
  {
    await admin('PUT', 'providers/rl', { baseUrl: base, billing: 'per-model' });
    await admin('POST', 'providers/rl/keys', { key: 'RL-key-xxxx', label: '' });
    await admin('PUT', 'providers/nf', { baseUrl: base, billing: 'per-model' });
    await admin('POST', 'providers/nf/keys', { key: 'NF-key-xxxx', label: '' });
    const d = (await admin('GET', 'dashboard')).body;
    const rl = d.providers.find((p) => p.name === 'rl');
    const nf = d.providers.find((p) => p.name === 'nf');
    assert.equal(rl.status, 'limited', JSON.stringify([rl.status, rl.statusText]));
    assert.equal(nf.status, 'error');
    assert.match(nf.statusText, /base URL/);
    const lg = (await admin('POST', 'logos', { items: [{ name: 'nf', baseUrl: 'http://127.0.0.1:9901/v1' }] })).body;
    assert.ok('nf' in lg.logos && Array.isArray(lg.pending), JSON.stringify(lg));
    // a base URL pasted with the endpoint on it is cut back to the part calls are built on
    await admin('PUT', 'providers/cu', { baseUrl: base + '/models/', billing: 'free' });
    const cu = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'cu');
    assert.equal(cu.baseUrl, base);
    for (const n of ['rl', 'nf', 'cu']) await admin('DELETE', 'providers/' + n);
  }
  step('429 on a key check shows as rate limited; 404 explains the base URL; logos endpoint');

  // settings, response cache, token budgets, alerts, speed and health history, backup and restore
  {
    assert.equal((await admin('PUT', 'settings', { accent: 'red' })).status, 400);
    const st = (await admin('PUT', 'settings', { accent: '#C6F135', cacheSecs: 60, fastFirst: false })).body.settings;
    assert.equal(st.accent, '#c6f135');
    assert.equal(st.cacheSecs, 60);
    assert.equal(st.fastFirst, false);
    assert.equal((await admin('PUT', 'alerts', { webhook: 'ftp://nope' })).status, 400);
    assert.equal((await admin('PUT', 'alerts', { telegramToken: 'nope', telegramChat: '1' })).status, 400);
    const tg = (await admin('PUT', 'alerts', { telegramToken: '123456:' + 'A'.repeat(35), telegramChat: '987654' })).body;
    assert.equal(tg.telegram.chat, '987654');
    assert.ok(!JSON.stringify(tg).includes('A'.repeat(20)), 'bot token never returned');
    const al = (await admin('PUT', 'alerts', { telegramToken: '', telegramChat: '', webhook: base + '/hook', events: { budget: true } })).body;
    assert.equal(al.telegram, null);
    assert.ok(al.on);
    assert.equal((await admin('POST', 'alerts/test', {})).status, 200);
    assert.ok(HOOKS.some((x) => x.event === 'test' && x.source === 'keyrouter'), JSON.stringify(HOOKS));

    await admin('PUT', 'providers/ck', { baseUrl: base, billing: 'free' });
    await admin('POST', 'providers/ck/keys', { key: 'TK-key-xxxx', label: '' });
    const kr = (await admin('POST', 'router-keys', { label: 'budget', tokenCap: 200, mode: 'free' })).body.key;
    const n0 = calls.filter((c) => c.startsWith('TK-key')).length;
    const same = { model: 'ck/tk-model', messages: [{ role: 'user', content: 'same' }] };
    const r1 = await post(same, kr);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-router-cache'), null);
    await r1.text();
    const r2 = await post(same, kr);
    assert.equal(r2.headers.get('x-router-cache'), 'hit');
    assert.match(await r2.text(), /counted/);
    assert.equal(calls.filter((c) => c.startsWith('TK-key')).length, n0 + 1, 'the repeat never reached the provider');
    const r3 = await post({ model: 'ck/tk-model', messages: [{ role: 'user', content: 'other' }] }, kr);
    assert.equal(r3.status, 200);
    await r3.text();
    const r4 = await post({ model: 'ck/tk-model', messages: [{ role: 'user', content: 'third' }] }, kr);
    assert.equal(r4.status, 429);
    assert.match((await r4.json()).error.message, /token budget/);
    for (let i = 0; i < 20 && !HOOKS.some((x) => x.event === 'budget'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(HOOKS.some((x) => x.event === 'budget' && /budget/.test(x.text)), JSON.stringify(HOOKS));
    const d = (await admin('GET', 'dashboard')).body;
    const ck = d.providers.find((p) => p.name === 'ck');
    const today = ck.history[ck.history.length - 1];
    assert.ok(today.ok >= 2, JSON.stringify(ck.history.slice(-2)));
    assert.ok(today.ms != null, 'answer time recorded');
    assert.equal(d.cache.today, 1);
    assert.equal(d.agentKeys.find((k) => k.label === 'budget').tokenCap, 200);
    const cv = (await admin('POST', 'benchmarks/refresh', {})).body;
    assert.ok(cv.models.find((m) => m.provider === 'ck' && m.id === 'tk-model').lat != null, 'speed shown per model');

    const bk = (await admin('GET', 'backup')).body;
    assert.equal(bk.kind, 'keyrouter-backup');
    assert.ok(!JSON.stringify(bk).includes('TK-key-xxxx'), 'provider keys left out');
    assert.equal(bk.providers.ck.keyCount, 1);
    assert.ok(bk.routerKeys.some((k) => k.label === 'budget' && k.tokenCap === 200));
    assert.equal((await admin('POST', 'restore', { backup: { kind: 'other' } })).status, 400);
    await admin('DELETE', 'providers/ck');
    const rs = (await admin('POST', 'restore', { backup: bk })).body;
    assert.ok(rs.counts.providers >= 1, JSON.stringify(rs.counts));
    assert.equal(rs.config.providers.ck.baseUrl, base);
    assert.equal(rs.config.providers.ck.keys.length, 0, 'a restored provider needs its key again');
    assert.equal(rs.counts.agentKeys, 0, 'agent keys already here are not doubled');

    // a provider whose every key fails is marked failing and sends an alert
    await admin('PUT', 'alerts', { events: { errors: true } });
    await admin('PUT', 'providers/dead', { baseUrl: base, billing: 'free' });
    await admin('POST', 'providers/dead/keys', { key: 'BAD-key-xxxx', label: '' });
    let dp = null;
    for (let i = 0; i < 40; i++) {
      dp = (await admin('GET', 'dashboard')).body.providers.find((p) => p.name === 'dead');
      if (dp.failingSince) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(dp.failingSince, 'failing provider noticed');
    for (let i = 0; i < 20 && !HOOKS.some((x) => x.event === 'errors'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(HOOKS.some((x) => x.event === 'errors' && /dead is failing/.test(x.text)), JSON.stringify(HOOKS));
    assert.ok(!JSON.stringify(HOOKS).includes('BAD-key-xxxx'), 'key values never sent');

    for (const n of ['ck', 'dead']) await admin('DELETE', 'providers/' + n);
    await admin('PUT', 'settings', { accent: '#ff6a13', cacheSecs: 0, fastFirst: true });
    await admin('PUT', 'alerts', { webhook: '' });
  }
  step('settings, cache, token budgets, alerts, speed, health history, backup and restore, failing providers');

  // brute force lockout on admin key
  for (let i = 0; i < 10; i++) await admin('GET', 'config', null, 'guess' + i);
  assert.equal((await admin('GET', 'config')).status, 429, 'locked out after 10 wrong keys');
  step('admin lockout after 10 wrong keys');

  console.log('\nALL TESTS PASSED');
} catch (e) {
  console.log(out.slice(-3000));
  console.error(e);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-proc.pid);
  } catch {}
  mock.close();
  fs.rmSync('test/test.env', { force: true });
  fs.rmSync('test/.state', { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}
