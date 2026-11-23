// Starts a mock provider + the Worker, seeds realistic data, then stays up for browser checks.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

let n = 0;
http.createServer(async (req, res) => {
  const j = (s, o, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET') {
    const k = (req.headers.authorization || '').slice(7);
    // a free-credit provider: only paid models, but a free token allowance on the account
    if (k.startsWith('clean')) return j(200, { data: [
      { id: 'claude-sonnet-5', pricing: { prompt: '0.000002', completion: '0.00001' }, context_length: 1000000 },
      { id: 'gpt-6-luna', pricing: { prompt: '0.0000001', completion: '0.0000005' } },
    ] });
    if (k.startsWith('sk-or')) return j(200, { data: [
      { id: 'z-ai/glm-5.3:free', context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
      { id: 'deepseek/deepseek-v4.1-flash:free', context_length: 1000000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
      { id: 'nvidia/nemotron-3.5-super-vl:free', context_length: 128000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'openai/gpt-oss-120b:free', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
      { id: 'openai/gpt-5', context_length: 400000, pricing: { prompt: '0.00001', completion: '0.00003' }, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'anthropic/claude-sonnet-4.5', context_length: 1000000, pricing: { prompt: '0.000003', completion: '0.000015' } },
    ] });
    if (k.startsWith('bad')) return j(401, { error: { message: 'invalid key' } });
    // an OpenCode-style list: prices under cost.text, one free model, the rest paid
    if (k.startsWith('chutes')) return j(200, { data: [
      { id: 'big-pickle', type: 'chat', cost: { text: { input: { price: 0 }, output: { price: 0 } } }, api: { 'chat-completions': {} }, limit: { context: 200000 } },
      { id: 'gpt-5', type: 'chat', cost: { text: { input: { price: 1.25 }, output: { price: 10 } } }, api: { 'chat-completions': {} } },
      { id: 'kimi-k3', type: 'chat', cost: { text: { input: { price: 2.35 }, output: { price: 11.76 } } }, api: { 'chat-completions': {} } },
      { id: 'claude-opus-4-6', type: 'chat', cost: { text: { input: { price: 5 }, output: { price: 25 } } }, api: { messages: {} } },
    ] });
    if (k.startsWith('csk')) return j(200, { data: [{ id: 'gpt-oss-120b' }, { id: 'qwen-3-235b-a22b-instruct-2507' }] });
    if (k.startsWith('gsk')) return j(200, { data: [{ id: 'llama-3.3-70b-versatile', context_window: 131072 }, { id: 'openai/gpt-oss-120b', context_window: 131072 }, { id: 'whisper-large-v3' }] });
    return j(200, { data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-2.5-pro' }, { id: 'models/text-embedding-004' }] });
  }
  let b = ''; for await (const c of req) b += c;
  const body = JSON.parse(b);
  const key = (req.headers.authorization || '').slice(7);
  if (key.startsWith('sk-or-one') && n++ < 3) return j(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
  const pt = 300 + Math.floor(Math.random() * 2400);
  const ct = 80 + Math.floor(Math.random() * 700);
  // Cerebras-style daily headers on the groq mock, so the daily capacity cards have numbers
  const day = { 'x-ratelimit-limit-requests-day': '14400', 'x-ratelimit-remaining-requests-day': String(14400 - n * 3), 'x-ratelimit-limit-tokens-day': '1000000', 'x-ratelimit-remaining-tokens-day': String(1000000 - n * 900) };
  const hdr = key.startsWith('gsk') ? Object.assign({}, day, { 'x-ratelimit-limit-requests': '14400', 'x-ratelimit-remaining-requests': String(14400 - (++n * 37)), 'x-ratelimit-reset-requests': '2h11m', 'x-ratelimit-limit-tokens': '12000', 'x-ratelimit-remaining-tokens': '8450', 'x-ratelimit-reset-tokens': '7.6s' }) : {};
  return j(200, { choices: [{ message: { role: 'assistant', content: 'Hello from ' + body.model + '. Router works fine.' } }], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct } }, hdr);
}).listen(9901);

fs.rmSync('test/.state', { recursive: true, force: true });
fs.writeFileSync('test/test.env', 'ADMIN_KEY=admin-secret-123\n');
const proc = spawn('npx', ['wrangler', 'dev', '--port', '9800', '--ip', '127.0.0.1', '--env-file', 'test/test.env', '--persist-to', 'test/.state'], { stdio: 'ignore', detached: true });
process.on('SIGTERM', () => { try { process.kill(-proc.pid); } catch {} process.exit(0); });

const B = 'http://127.0.0.1:9800';
for (let i = 0; i < 90; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const admin = (m, p, body) => fetch(B + '/admin/' + p, { method: m, headers: { authorization: 'Bearer admin-secret-123', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const mock = 'http://127.0.0.1:9901';
await admin('PUT', 'providers/openrouter', { baseUrl: mock, billing: 'per-model' });
await admin('PUT', 'providers/groq', { baseUrl: mock, billing: 'free' });
await admin('PUT', 'providers/gemini', { baseUrl: mock, billing: 'free' });
await admin('POST', 'providers/openrouter/keys', { key: 'sk-or-one-aaaa1111', label: 'main' });
await admin('POST', 'providers/openrouter/keys', { key: 'sk-or-two-bbbb2222', label: 'alt' });
await admin('POST', 'providers/groq/keys', { key: 'gsk_groq_cccc3333' });
await admin('POST', 'providers/gemini/keys', { key: 'AIza-gem-dddd4444' });
await admin('PUT', 'providers/mistral', { baseUrl: mock, billing: 'free' });
await admin('POST', 'providers/mistral/keys', { key: 'bad-mistral-eeee5555' });
await admin('PUT', 'providers/creditapi', { baseUrl: mock, billing: 'per-model' });
await admin('POST', 'providers/creditapi/keys', { key: 'credit-api-ffff6666' });
await admin('PUT', 'providers/creditapi', { allowance: { tokens: 500000, per: 'once' }, limits: { tpd: 200000 } });
const k = await admin('POST', 'router-keys', { label: 'research-agent', dailyCap: 3000, mode: 'free' });
await admin('POST', 'router-keys', { label: 'tech-team', dailyCap: 1500 });
for (let i = 0; i < 24; i++)
  await fetch(B + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + k.key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: i % 2 ? 'fix the bug in app.ts' : 'hi' }] }) });
console.log('READY');
setInterval(() => {}, 1 << 30);
