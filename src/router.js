// KeyRouter Durable Object: provider keys, model catalog, routes, agent keys, usage state and failover.
// Provider keys never leave Cloudflare: the admin API only returns masks.
import { PRESETS, DEFAULT_ROUTES, DEFAULT_SETTINGS } from './config.js';
import { CATEGORIES, SMART_NAMES, MODES, analyze, taskScore, detectTask, isChatId } from './models.js';
import { BENCH_SOURCE, BENCH_EVERY, fetchBench, makeLookup, benchScore, toScore } from './bench.js';
import { resolveLogo } from './logos.js';

export const json = (status, obj, extra) =>
  new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json' }, extra || {}) });

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const digest = (s) => crypto.subtle.digest('SHA-256', enc.encode(s));
const sha = async (s) => hex(await digest(s));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const clone = (o) => JSON.parse(JSON.stringify(o));
const mask = (k) => '...' + k.slice(-4);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SMART_RE = /^([a-z-]+)(?::(free|mixed|best))?$/;
const HOUR = 3600000;
// Rolling allowance windows, counted from when the allowance was set.
const WINDOW_H = { '5h': 5, '9h': 9, '12h': 12 };
const sleep = (ms, signal) =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => (clearTimeout(t), res()));
  });
const CATALOG_EVERY = 6 * HOUR;
const CATALOG_V = 2;
const log = (o) => console.log(JSON.stringify(o));

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers.get('x-api-key') || '').trim();
}

async function safeEqual(a, b) {
  // Compare fixed-length hashes in constant time. Works on Cloudflare and in Node (Vercel).
  const [x, y] = (await Promise.all([digest(String(a)), digest(String(b))])).map((d) => new Uint8Array(d));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function cleanLimits(l) {
  if (!l || typeof l !== 'object') return undefined;
  const out = {};
  for (const f of ['rpm', 'rpd', 'tpd']) {
    const n = Number(l[f]);
    if (Number.isFinite(n) && n > 0) out[f] = Math.floor(n);
  }
  return Object.keys(out).length ? out : undefined;
}

// A free token allowance on paid models (signup credit, monthly or daily free tokens).
function cleanAllowance(a) {
  if (!a || typeof a !== 'object') return undefined;
  const tokens = Math.floor(Number(a.tokens));
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  const per = ['day', 'month', 'once', '5h', '9h', '12h'].includes(a.per) ? a.per : 'once';
  return { tokens, per, since: Number(a.since) || Date.now() };
}

// A readable one-liner from a provider error such as: 429 {"error":{"message":"..."}}
function shortErr(e) {
  const t = String(e || '');
  const m = t.match(/"message"\s*:\s*"([^"]{1,160})/);
  const code = (t.match(/^\d{3}/) || [''])[0];
  return (m ? (code ? code + ' ' : '') + m[1] : t).replace(/\s+/g, ' ').slice(0, 120);
}

// Daily free capacity across providers that have free models: what is known, used and left today.
function dayRow(rows, base) {
  return (rows || []).find((r) => r.what === base + '-day' || r.what === base + '-per-day' || r.what === base + '-daily') || null;
}
function capacityOf(list) {
  // used: everything today; usedKnown: only on providers with a known limit (what the bar measures).
  const mk = () => ({ used: 0, usedKnown: 0, limit: 0, left: 0, known: 0, unknown: 0, rows: [] });
  const req = mk();
  const tok = mk();
  for (const p of list) {
    if (!['ready', 'warn', 'connected', 'limited'].includes(p.status) || !p.free) continue;
    let rl = 0;
    let ru = 0;
    let ruAll = 0;
    for (const k of p.keys) {
      const row = dayRow(k.rows, 'requests');
      // OpenRouter: free models allow about 50 a day, or 1,000 once the account has credits.
      const est = k.acct ? (k.acct.freeTier ? 50 : 1000) : 0;
      const lim = (row && row.limit) || k.rpd || est;
      const used = row && row.limit != null && row.remaining != null ? Math.max(k.today, row.limit - row.remaining) : k.today;
      ruAll += used;
      if (lim) {
        rl += lim;
        ru += used;
      }
    }
    req.used += ruAll;
    if (rl) {
      req.limit += rl;
      req.usedKnown += Math.min(ru, rl);
      req.left += Math.max(0, rl - ru);
      req.known++;
      req.rows.push({ name: p.name, used: ru, limit: rl });
    } else req.unknown++;
    const tu = (p.tokensToday.p || 0) + (p.tokensToday.c || 0);
    const pa = p.allowance;
    let tl = p.tpd || (pa && pa.per === 'day' ? pa.tokens : pa && WINDOW_H[pa.per] ? Math.round((pa.tokens * 24) / WINDOW_H[pa.per]) : 0);
    if (!tl) for (const k of p.keys) {
      const row = dayRow(k.rows, 'tokens');
      if (row && row.limit) tl += row.limit;
    }
    tok.used += tu;
    if (tl) {
      tok.limit += tl;
      tok.usedKnown += Math.min(tu, tl);
      tok.left += Math.max(0, tl - tu);
      tok.known++;
      tok.rows.push({ name: p.name, used: tu, limit: tl });
    } else tok.unknown++;
  }
  for (const x of [req, tok]) x.rows.sort((a, b) => b.limit - a.limit);
  return { requests: req, tokens: tok };
}

// No Authorization header for providers that need no key.
const authOf = (k) => (k && k.key ? { authorization: 'Bearer ' + k.key } : {});
// Some providers sit behind a firewall that refuses requests without a browser-like user agent.
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; KeyRouter/1.0; +https://github.com/sufianweb3/KeyRouter)' };
const hdrs = (p, k, extra) => Object.assign({}, UA, extra || {}, authOf(k), p.headers || {});

// Turn a failed /models answer into a message a person can act on.
async function whyFailed(r) {
  const text = (await r.text().catch(() => '')).slice(0, 2000);
  const low = text.toLowerCase();
  const html = /<html|<!doctype/.test(low);
  if (r.status === 429) return { error: 'Rate limited (429), checking again later', limited: true };
  if (r.status === 403 && html && /cloudflare|just a moment|attention required|access denied|captcha|cf-ray/.test(low))
    return { error: "Blocked by the provider's firewall (403). Their site refuses server requests", perm: true };
  if (r.status === 401 || r.status === 403) {
    const msg = (() => {
      try {
        const j = JSON.parse(text);
        const e = j.error || j;
        return String((e && (e.message || e.msg || e.detail)) || j.message || '').slice(0, 120);
      } catch {
        return html ? '' : text.slice(0, 120);
      }
    })();
    return { error: 'Key rejected (' + r.status + ')' + (msg ? ': ' + msg : ''), auth: true };
  }
  if (r.status === 404) return { error: 'No model list at this address (404). Check the base URL, it usually ends in /v1', perm: true };
  return { error: 'Provider answered ' + r.status };
}

// People often paste the full endpoint. Keep the part every call is built on: ".../v1".
function cleanBase(u) {
  return String(u || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|completions|models|responses|embeddings)$/i, '')
    .replace(/\/+$/, '');
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// "2m59.5s", "1h", "500ms", "7" (seconds), or an epoch in s or ms -> milliseconds from now.
function parseReset(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return Math.max(0, n - Date.now());
    if (n > 1e9) return Math.max(0, n * 1000 - Date.now());
    return n * 1000;
  }
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(s))) ms += Number(m[1]) * (m[2] === 'h' ? HOUR : m[2] === 'm' ? 60000 : m[2] === 's' ? 1000 : 1);
  return ms;
}

// Cheap stable hash for in-memory keys (not for secrets).
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Token counts from a provider reply (JSON or SSE). Last value wins, so the final usage chunk counts.
function usageFrom(text) {
  const last = (re) => {
    let m;
    let v = null;
    while ((m = re.exec(text))) v = Number(m[1]);
    return v;
  };
  const p = last(/"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g);
  const c = last(/"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g);
  return p == null && c == null ? null : { p: p || 0, c: c || 0 };
}
const CONTENT_RE = /"(?:content|text|reasoning|reasoning_content)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
function contentChars(text) {
  let n = 0;
  let m;
  CONTENT_RE.lastIndex = 0;
  while ((m = CONTENT_RE.exec(text))) n += m[1].length;
  return n;
}
const DAYS_KEPT = 30;

// Provider-reported rate limit headers -> rows like { what: 'tokens-day', limit, remaining, reset }.
function limitRows(rl) {
  if (!rl) return [];
  const rows = {};
  for (const [k, v] of Object.entries(rl)) {
    const m = k.match(/^x-ratelimit-(limit|remaining|reset)(?:-(.+))?$/);
    if (!m) continue;
    const what = m[2] || 'requests';
    const r = rows[what] || (rows[what] = { what });
    if (m[1] === 'reset') r.reset = v;
    else r[m[1]] = Number(v);
  }
  return Object.values(rows).filter((r) => r.limit != null || r.remaining != null);
}

const msgText = (m) => (!m ? '' : typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ') : '');

// Gemini rejects tool-call history it did not sign. Google's documented escape hatch for
// history from other models is this sentinel; real signatures are kept untouched.
const GEMINI_SKIP_SIG = 'skip_thought_signature_validator';
function isGemini(name, p) {
  return /^gemini/.test(name) || /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/.test(p.baseUrl || '');
}
function addGeminiSignatures(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return m;
    const signed = m.tool_calls.some((tc) => tc && tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature);
    if (signed) return m;
    changed = true;
    const tcs = m.tool_calls.slice();
    const first = Object.assign({}, tcs[0]);
    first.extra_content = Object.assign({}, first.extra_content || {}, { google: Object.assign({}, (first.extra_content && first.extra_content.google) || {}, { thought_signature: GEMINI_SKIP_SIG }) });
    tcs[0] = first;
    return Object.assign({}, m, { tool_calls: tcs });
  });
  return changed ? out : messages;
}

function seedProviders() {
  const out = {};
  for (const [name, p] of Object.entries(PRESETS)) out[name] = Object.assign(clone(p), { keys: [], enabled: true });
  return out;
}

// Runs as a Durable Object on Cloudflare. On Vercel, api/index.js gives it the same ctx.storage API backed by Redis.
export class KeyRouter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.fails = new Map();
    this.rrProvider = {};
    this.rrRoute = {};
    this.affinity = new Map();
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get(['providers', 'routes', 'settings', 'routerKeys', 'overrides', 'state', 'usage', 'checks', 'acct']);
      const routes = s.get('routes') || clone(DEFAULT_ROUTES);
      // Smart names are reserved: an older hand-made route with such a name keeps working as "<name>-custom".
      for (const n of Object.keys(routes)) {
        if (SMART_NAMES.includes(n)) {
          routes[n + '-custom'] = routes[n];
          delete routes[n];
        }
      }
      this.cfg = {
        providers: s.get('providers') || seedProviders(),
        routes,
        settings: Object.assign({}, DEFAULT_SETTINGS, s.get('settings') || {}),
        routerKeys: s.get('routerKeys') || [],
        overrides: s.get('overrides') || {},
      };
      if (!MODES.includes(this.cfg.settings.mode)) this.cfg.settings.mode = 'free';
      if (!this.cfg.routes[this.cfg.settings.defaultRoute] && !SMART_NAMES.includes(this.cfg.settings.defaultRoute)) this.cfg.settings.defaultRoute = 'auto';
      // Fix 1: the connect form used to save custom providers as "every model free".
      // Their prices are read from the model list now, so switch them to per-model once.
      if (((await ctx.storage.get('mig')) || 0) < 1) {
        for (const [n, p] of Object.entries(this.cfg.providers)) if (!PRESETS[n] && p.billing === 'free') p.billing = 'per-model';
        await ctx.storage.put({ providers: this.cfg.providers, mig: 1 });
      }
      // Fix 2: providers saved before they became built-in presets kept "Auto pricing" even where the
      // preset knows every model is free (Ollama Cloud, SambaNova). Use the preset unless you chose otherwise.
      if (((await ctx.storage.get('mig')) || 0) < 2) {
        for (const [n, p] of Object.entries(this.cfg.providers)) {
          const pre = PRESETS[n];
          if (pre && pre.billing === 'free' && p.billing === 'per-model' && !p.billingSet && p.baseUrl === pre.baseUrl) delete p.billing;
        }
        await ctx.storage.put({ providers: this.cfg.providers, mig: 2 });
      }
      // Fix 3: a base URL pasted with the endpoint on it (".../v1/models") made every call 404.
      if (((await ctx.storage.get('mig')) || 0) < 3) {
        let fixed = false;
        for (const p of Object.values(this.cfg.providers)) {
          const u = p.baseUrl && cleanBase(p.baseUrl);
          if (u && u !== p.baseUrl) {
            p.baseUrl = u;
            fixed = true;
          }
        }
        // Read the model lists again on the next alarm, so a fixed address shows its models right away.
        await ctx.storage.put(fixed ? { providers: this.cfg.providers, mig: 3, alarmFull: 0 } : { mig: 3 });
      }
      this.bench = (await ctx.storage.get('bench')) || null;
      this.benchLookup = makeLookup(this.bench);
      this.state = s.get('state') || {};
      this.usage = s.get('usage') || { days: {} };
      this.checks = s.get('checks') || {};
      this.acct = s.get('acct') || {};
      this.catalog = {};
      const cats = await ctx.storage.list({ prefix: 'cat:' });
      for (const [k, v] of cats) this.catalog[k.slice(4)] = v;
      this.rebuild();
      const keyed = Object.keys(this.providers);
      const missing = keyed.filter((n) => !this.catalog[n] || (this.catalog[n].v || 0) < CATALOG_V);
      this.cfg.alarmFull = missing.length ? 0 : (await ctx.storage.get('alarmFull')) || 0;
      const alarm = await ctx.storage.getAlarm();
      const untested = keyed.some((n) => !(this.checks[n] && this.checks[n].freeTest));
      const soon = missing.length || !this.cfg.alarmFull ? 2000 : untested ? 60000 : null;
      if (keyed.length && (alarm == null || (soon && alarm > Date.now() + soon))) await ctx.storage.setAlarm(Date.now() + (soon || CATALOG_EVERY));
    });
  }

  rebuild() {
    this.providers = {};
    for (const [name, p] of Object.entries(this.cfg.providers)) {
      if (p.enabled === false || !p.keys.length) continue;
      this.providers[name] = Object.assign({ name }, p);
    }
    this.rkByHash = new Map(this.cfg.routerKeys.map((rk) => [rk.hash, rk]));
  }

  // Allowance period key: today, this month, or since it was set.
  allowPeriod(a) {
    const d = this.today('UTC');
    if (WINDOW_H[a.per]) return 'w:' + a.since + ':' + Math.floor((Date.now() - a.since) / (WINDOW_H[a.per] * HOUR));
    return a.per === 'day' ? d : a.per === 'month' ? d.slice(0, 7) : 'since:' + a.since;
  }

  // When the allowance fills up again (null for a one-time credit).
  allowResetAt(a) {
    const now = new Date();
    if (WINDOW_H[a.per]) {
      const w = WINDOW_H[a.per] * HOUR;
      return a.since + (Math.floor((now.getTime() - a.since) / w) + 1) * w;
    }
    if (a.per === 'day') return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    if (a.per === 'month') return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return null;
  }

  allowInfo(name) {
    const p = this.cfg.providers[name];
    const a = p && p.allowance;
    if (!a) return null;
    const all = this.usage.allow || {};
    const cur = all[name];
    const used = cur && cur.period === this.allowPeriod(a) ? cur.used : 0;
    return { tokens: a.tokens, per: a.per, since: a.since, used, left: Math.max(0, a.tokens - used), resetAt: this.allowResetAt(a) };
  }

  // Free to use right now: free by price, or a paid model covered by a free token allowance.
  freeOf(name, m) {
    if (m.free) return true;
    const a = this.allowInfo(name);
    return !!(a && a.left > 0);
  }

  tokensToday(name) {
    const d = (this.usage.days || {})[this.today('UTC')];
    const x = d && d.prov && d.prov[name];
    return x ? x.p + x.c : 0;
  }

  // Over its own tokens-per-day limit (set by you or by the preset)?
  overTpd(name) {
    const p = this.cfg.providers[name];
    const tpd = p && p.limits && p.limits.tpd;
    return !!(tpd && this.tokensToday(name) >= tpd);
  }

  billingOf(name) {
    const p = this.cfg.providers[name] || {};
    return p.billing || (PRESETS[name] && PRESETS[name].billing) || 'per-model';
  }

  async saveCfg() {
    await this.ctx.storage.put({
      providers: this.cfg.providers,
      routes: this.cfg.routes,
      settings: this.cfg.settings,
      routerKeys: this.cfg.routerKeys,
      overrides: this.cfg.overrides,
    });
    this.rebuild();
  }

  save() {
    this.ctx.storage.put({ state: this.state, usage: this.usage }).catch((e) => console.error(JSON.stringify({ message: 'state save failed', error: String(e) })));
  }

  // ---------- model catalog ----------
  async alarm() {
    const now = Date.now();
    if (this.benchDue()) {
      await this.refreshBench();
      await this.ctx.storage.setAlarm(Date.now() + 2000);
      return;
    }
    const due = this.cfg.alarmFull == null || now >= this.cfg.alarmFull;
    if (due) {
      await this.refreshCatalog(Object.keys(this.providers));
      for (const n of Object.keys(this.providers)) await this.fetchAccount(n);
      await this.ctx.storage.put('acct', this.acct);
      this.cfg.alarmFull = now + CATALOG_EVERY;
      await this.ctx.storage.put('alarmFull', this.cfg.alarmFull);
    }
    // Keys whose last check failed for a passing reason (rate limit, timeout, server error) get checked again.
    for (const n of this.keyRetry()) {
      for (const k of this.cfg.providers[n].keys) await this.checkKey(n, k);
      if (!this.catalog[n] || !this.catalog[n].models.length) await this.refreshCatalog([n]);
      await this.ctx.storage.put('checks', this.checks);
    }
    // Self-heal: test free models nobody has tested yet, and retry failed tests after a while.
    for (const n of this.needsTest()) {
      await this.testFree(n);
      await this.ctx.storage.put('checks', this.checks);
    }
    const next = Math.min(this.cfg.alarmFull, now + CATALOG_EVERY, this.nextRetest());
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  // ---------- benchmarks ----------
  benchDue() {
    if (this.env.BENCH_OFF) return false;
    const b = this.bench;
    const tried = this.benchTried || 0;
    return (!b || Date.now() - b.at > BENCH_EVERY) && Date.now() - tried > 6 * HOUR;
  }

  async refreshBench() {
    this.benchTried = Date.now();
    try {
      const b = await fetchBench(this.env.BENCH_URL);
      this.bench = b;
      this.benchErr = null;
      this.benchLookup = makeLookup(b);
      await this.ctx.storage.put('bench', b);
      log({ message: 'benchmarks refreshed', models: b.n, published: b.published });
    } catch (e) {
      this.benchErr = String(e.message || e).slice(0, 200);
      log({ message: 'benchmarks failed', error: this.benchErr });
    }
  }

  benchInfo() {
    const b = this.bench;
    return { source: BENCH_SOURCE, published: b ? b.published : null, at: b ? b.at : null, models: b ? b.n : 0, error: this.benchErr || null };
  }

  // How strong a model is for a task. Your own score wins, then the LMArena leaderboard, then an estimate.
  // Estimates rank a little lower, so a model with real results is preferred over a guess of the same size.
  strength(name, m, task, needTools) {
    const ov = this.cfg.overrides[name + '/' + m.id] || {};
    if (ov.score != null) return { score: taskScore(Object.assign({}, m, { score: ov.score }), task, needTools), src: 'custom' };
    const hit = this.benchLookup(m.id);
    if (hit) {
      let sc = benchScore(hit.row, task);
      if (needTools && m.tools === true) sc += 2;
      return { score: sc, src: 'lmarena', exact: hit.exact, key: hit.key, rating: hit.row[0] };
    }
    return { score: taskScore(m, task, needTools) - (this.bench ? 6 : 0), src: 'estimate' };
  }

  keyRetry() {
    const out = [];
    for (const n of Object.keys(this.providers)) {
      const ks = Object.values((this.checks[n] && this.checks[n].keys) || {});
      if (ks.length && ks.every((x) => !x.ok && !x.auth && !x.perm && Date.now() - x.at > 30 * 60000)) out.push(n);
    }
    return out.slice(0, 5);
  }

  // Earliest time a rate-limited free test may run again.
  nextRetest() {
    let t = Infinity;
    for (const n of Object.keys(this.providers)) {
      const ks = Object.values((this.checks[n] && this.checks[n].keys) || {});
      if (ks.length && ks.every((x) => !x.ok && !x.auth && !x.perm)) t = Math.min(t, Math.max(...ks.map((x) => x.at)) + 30 * 60000);
    }
    for (const n of Object.keys(this.providers)) {
      const ft = this.checks[n] && this.checks[n].freeTest;
      if (ft && !ft.ok && ft.limited) t = Math.min(t, ft.retryAt || ft.at + 5 * 60000);
    }
    return t;
  }

  // Make sure the alarm fires no later than at.
  async wake(at) {
    if (!Number.isFinite(at)) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
  }

  // A real call to a free model worked: that proves the provider's free models, no test call needed.
  markWorking(c) {
    const name = c.t.provider;
    const m = (this.catalog[name] && this.catalog[name].models.find((x) => x.id === c.t.model)) || null;
    if (!m || !this.freeOf(name, m)) return;
    const ch = this.checks[name] || (this.checks[name] = { keys: {} });
    const ft = ch.freeTest;
    if (ft && ft.ok && Date.now() - ft.at < HOUR) return;
    ch.freeTest = { ok: true, at: Date.now(), model: c.t.model, passive: true };
    this.ctx.storage.put('checks', this.checks).catch(() => {});
  }

  // Providers with free models whose test is missing, rate limited (5 min ago) or failed (6 h ago).
  needsTest() {
    const out = [];
    for (const n of Object.keys(this.providers)) {
      const cat = this.catalog[n];
      if (!cat || !cat.models.some((m) => this.freeOf(n, m))) continue;
      const ft = this.checks[n] && this.checks[n].freeTest;
      const age = ft ? Date.now() - ft.at : Infinity;
      const due = ft && ft.retryAt ? Date.now() >= ft.retryAt : age > 5 * 60000;
      if (!ft || ft.none || (!ft.ok && ft.limited && due) || (!ft.ok && !ft.limited && age > 6 * HOUR)) out.push(n);
    }
    return out;
  }

  // Some providers count /models against the per-minute limit (1 a minute on Airforce),
  // so it is noted like a call and the free test waits its turn.
  noteCall(name, k) {
    const p = this.cfg.providers[name];
    if (!p || !p.limits || !p.limits.rpm || p.limits.rpm > 5) return;
    this.bucket('k:' + name + ':' + k.id, p.resetTz || 'UTC').hits.push(Date.now());
  }

  async fetchModels(p, name) {
    const k = p.keys[0];
    const ll = this.lastList;
    // The key check just fetched this list: reuse it instead of a second call.
    if (ll && ll.name === name && ll.id === k.id && Date.now() - ll.at < 60000) {
      this.lastList = null;
      return ll.list;
    }
    if (name) this.noteCall(name, k);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(p.baseUrl + '/models', { headers: hdrs(p, k), signal: ctrl.signal });
      if (!r.ok) throw new Error((await whyFailed(r)).error);
      const j = await r.json();
      return Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j.models) ? j.models : [];
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshCatalog(names) {
    for (const name of names) {
      const p = this.cfg.providers[name];
      if (!p || !p.keys.length) continue;
      const billing = this.billingOf(name);
      try {
        const raw = await this.fetchModels(p, name);
        const keyless = p.keys.every((k) => !k.key);
        // Without a key nothing can be paid for, so a listed price always counts.
        const all = raw.map((x) => analyze(x, billing, !!PRESETS[name] && !keyless));
        const models = all.filter((m) => m.chat && (!keyless || m.free)).slice(0, 1500);
        this.catalog[name] = { at: Date.now(), error: null, total: all.length, models, v: CATALOG_V };
        // The list came back with this key, so an older failed check of it (a 429, a timeout) no longer stands.
        const ch0 = this.checks[name] || (this.checks[name] = { keys: {} });
        ch0.keys = ch0.keys || {};
        const k0 = p.keys[0];
        if (!ch0.keys[k0.id] || !ch0.keys[k0.id].ok) {
          ch0.keys[k0.id] = { ok: true, at: Date.now() };
          await this.ctx.storage.put('checks', this.checks);
        }
        // A past free test on a model that turns out to be paid is no longer true.
        const ft = this.checks[name] && this.checks[name].freeTest;
        if (ft && ft.model && !models.some((m) => m.id === ft.model && this.freeOf(name, m))) {
          delete this.checks[name].freeTest;
          await this.ctx.storage.put('checks', this.checks);
        }
      } catch (e) {
        const prev = this.catalog[name] || { models: [], total: 0 };
        this.catalog[name] = Object.assign({}, prev, { at: Date.now(), error: e.name === 'AbortError' ? 'timed out' : e.message });
      }
      await this.ctx.storage.put('cat:' + name, this.catalog[name]);
      log({ message: 'catalog refreshed', provider: name, models: this.catalog[name].models.length, error: this.catalog[name].error });
    }
  }

  // ok / fail per provider+model across all keys, for ranking.
  health() {
    const h = {};
    for (const [id, b] of Object.entries(this.state)) {
      if (!id.startsWith('m:')) continue;
      const parts = id.split(':');
      const key = parts[1] + '/' + parts.slice(3).join(':');
      const x = h[key] || (h[key] = { ok: 0, fail: 0 });
      x.ok += b.ok || 0;
      x.fail += b.fail || 0;
    }
    return h;
  }

  paidBucket() {
    return this.bucket('paid', 'UTC');
  }

  paidAllowed() {
    const cap = this.cfg.settings.paidDailyCap || 0;
    return !cap || this.paidBucket().dayCount < cap;
  }

  // ---------- token accounting ----------
  addUsage(provider, model, who, u, estimated) {
    const day = this.today('UTC');
    const days = this.usage.days;
    const d = days[day] || (days[day] = { p: 0, c: 0, req: 0, est: 0, prov: {}, keys: {}, models: {} });
    const add = (o, k) => {
      const x = o[k] || (o[k] = { p: 0, c: 0, req: 0 });
      x.p += u.p;
      x.c += u.c;
      x.req++;
    };
    d.p += u.p;
    d.c += u.c;
    d.req++;
    if (estimated) d.est++;
    add(d.prov, provider);
    add(d.keys, who || 'dashboard');
    const pa = this.cfg.providers[provider] && this.cfg.providers[provider].allowance;
    if (pa) {
      const all = this.usage.allow || (this.usage.allow = {});
      const per = this.allowPeriod(pa);
      const cur = all[provider] && all[provider].period === per ? all[provider] : (all[provider] = { period: per, used: 0 });
      cur.used += u.p + u.c;
    }
    const mk = provider + '/' + model;
    if (d.models[mk] || Object.keys(d.models).length < 300) add(d.models, mk);
    const keep = Object.keys(days).sort().slice(-DAYS_KEPT);
    for (const k of Object.keys(days)) if (!keep.includes(k)) delete days[k];
  }

  // Count tokens for one finished reply. Falls back to a ~4 chars per token estimate.
  countReply(c, who, promptEst, text, chars) {
    const got = usageFrom(text);
    const u = got || { p: promptEst, c: Math.ceil((chars != null ? chars : contentChars(text)) / 4) };
    this.addUsage(c.t.provider, c.t.model, who, u, !got);
    this.save();
  }

  // ---------- provider checks ----------
  // Does this key work? Asks the provider for its model list with that one key.
  async checkKey(name, k) {
    const p = this.cfg.providers[name];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      this.noteCall(name, k);
      const r = await fetch(p.baseUrl + '/models', { headers: hdrs(p, k), signal: ctrl.signal });
      res = r.ok ? { ok: true } : Object.assign({ ok: false }, await whyFailed(r));
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j) this.lastList = { name, id: k.id, at: Date.now(), list: Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j.models) ? j.models : [] };
      }
    } catch (e) {
      res = { ok: false, error: e.name === 'AbortError' ? 'Timed out' : 'Network error: ' + e.message };
    } finally {
      clearTimeout(timer);
    }
    res.at = Date.now();
    const ch = this.checks[name] || (this.checks[name] = { keys: {} });
    ch.keys = ch.keys || {};
    ch.keys[k.id] = res;
    return res;
  }

  // OpenRouter tells us credits and free tier per key.
  async fetchAccount(name) {
    const p = this.cfg.providers[name];
    if (!p || !/openrouter\.ai/.test(p.baseUrl)) return;
    const out = {};
    for (const k of p.keys) {
      try {
        const r = await fetch(p.baseUrl + '/key', { headers: { authorization: 'Bearer ' + k.key } });
        if (!r.ok) continue;
        const d = (await r.json()).data || {};
        out[k.id] = { usage: d.usage, limit: d.limit, remaining: d.limit_remaining, freeTier: !!d.is_free_tier, at: Date.now() };
      } catch {
        /* optional info */
      }
    }
    this.acct[name] = out;
  }

  // Send one tiny message to the strongest free model of this provider.
  async testFree(name) {
    const p = this.cfg.providers[name];
    const cat = this.catalog[name];
    const ch = this.checks[name] || (this.checks[name] = { keys: {} });
    // Truly free models first, allowance-covered ones after. Within each, the strongest first.
    const free = cat ? cat.models.filter((m) => this.freeOf(name, m) && isChatId(m.id) && !(this.cfg.overrides[name + '/' + m.id] || {}).off).sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0) || b.score - a.score) : [];
    if (!p || !p.keys.length) return (ch.freeTest = { ok: false, at: Date.now(), error: 'No key' });
    if (!free.length) return (ch.freeTest = { ok: false, at: Date.now(), none: true, error: 'No free models on this provider' });
    let last = null;
    const prev = ch.freeTest;
    for (const m of free.slice(0, 3)) {
      const k = p.keys.find((x) => !ch.keys || !ch.keys[x.id] || ch.keys[x.id].ok !== false) || p.keys[0];
      const tz = p.resetTz || 'UTC';
      const cc = { t: { provider: name, model: m.id }, p, k, kb: this.bucket('k:' + name + ':' + k.id, tz), mb: this.bucket('m:' + name + ':' + k.id + ':' + m.id, tz) };
      // Never test into a wall: if the key or model is inside a rate window, wait a few seconds
      // or come back when it opens. A test that only collects a 429 wastes quota and shows a false error.
      if (!this.available(cc.kb, p.limits) || !this.available(cc.mb, p.modelLimits)) {
        const w = Math.max(this.waitMs(cc.kb, p.limits), this.waitMs(cc.mb, p.modelLimits));
        if (w <= 8000) await sleep(w + 50);
        else {
          if (prev && prev.ok) return prev;
          last = { ok: false, at: Date.now(), model: m.id, limited: true, waiting: true, error: 'Waiting for the rate limit window', retryAt: Date.now() + w + 1000 };
          break;
        }
      }
      // The test spends real quota, so it counts like any other call.
      for (const bk of [cc.kb, cc.mb]) {
        bk.hits.push(Date.now());
        bk.dayCount++;
      }
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        // Some gateways fail on a tiny output cap (reasoning models spend it thinking), so allow a little room.
        const body = { model: m.id, messages: [{ role: 'user', content: 'Reply with the word OK.' }], max_tokens: 128 };
        const r = await fetch(p.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: hdrs(p, k, { 'content-type': 'application/json' }),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await r.text();
        this.readLimits(cc, r.headers);
        const ee = r.ok ? this.embeddedError(text) : null;
        if (r.ok && !ee) {
          cc.kb.ok++;
          cc.mb.ok++;
          this.countReply(cc, 'dashboard', 8, text);
          return (ch.freeTest = { ok: true, at: Date.now(), model: m.id, ms: Date.now() - t0 });
        }
        const cls = ee ? this.classify(ee.status, ee.text) : this.classify(r.status, text, r.headers);
        if (cls && cls.kind !== 'skip') this.penalize(cc, cls);
        last = { ok: false, at: Date.now(), model: m.id, error: (ee ? ee.status + ' ' + ee.text : r.status + ' ' + text).slice(0, 200) };
        // Rate limited: trying more models now only burns the same limit. Retest when the provider says.
        if (cls && (cls.reason === 'rate limited' || cls.reason === 'daily quota')) {
          last.limited = true;
          last.retryAt = Date.now() + Math.min(24 * HOUR, Math.max(60000, this.waitMs(cc.kb, p.limits), this.waitMs(cc.mb, p.modelLimits)));
          break;
        }
      } catch (e) {
        last = { ok: false, at: Date.now(), model: m.id, error: e.name === 'AbortError' ? 'Timed out' : e.message };
      } finally {
        clearTimeout(timer);
      }
    }
    return (ch.freeTest = last);
  }

  async fullCheck(name) {
    const p = this.cfg.providers[name];
    if (!p) return;
    for (const k of p.keys) await this.checkKey(name, k);
    await this.refreshCatalog([name]);
    await this.fetchAccount(name);
    // A pass in the last 12 hours (a test or a real call) still stands: no need to spend a request on it.
    const ft = this.checks[name] && this.checks[name].freeTest;
    if (!(ft && ft.ok && Date.now() - ft.at < 12 * HOUR)) await this.testFree(name);
    await this.ctx.storage.put({ checks: this.checks, acct: this.acct });
    const ch = this.checks[name] || {};
    const cat = this.catalog[name] || {};
    log({ message: 'provider checked', provider: name, host: hostOf(p.baseUrl), keys: Object.values(ch.keys || {}).map((x) => (x.ok ? 'ok' : x.error)), models: (cat.models || []).length, catalogError: cat.error || null, freeTest: ch.freeTest ? (ch.freeTest.ok ? 'ok' : ch.freeTest.error || 'failed') : null });
    await this.wake(this.nextRetest());
  }

  // Best-first list of models for one task, across every provider that has a key.
  smartTargets(task, mode, det, health) {
    health = health || this.health();
    det = det || { tokens: 0, needTools: false };
    const out = [];
    const paidOk = this.paidAllowed();
    for (const name of Object.keys(this.providers)) {
      const c = this.catalog[name];
      if (!c || this.overTpd(name)) continue;
      for (const m of c.models) {
        if (!isChatId(m.id)) continue;
        const key = name + '/' + m.id;
        const ov = this.cfg.overrides[key] || {};
        if (ov.off) continue;
        if (!m.cats.includes(task)) continue;
        if (det.needTools && m.tools === false) continue;
        if (m.ctx && det.tokens && det.tokens > m.ctx * 0.9) continue;
        const isFree = this.freeOf(name, m);
        if (!isFree && (mode === 'free' || !paidOk)) continue;
        const st = this.strength(name, m, task, det.needTools);
        const hh = health[key];
        const penalty = hh ? (20 * hh.fail) / (hh.ok + hh.fail + 3) : 0;
        // A model close to its rate or daily limit slides down, so traffic moves to a near-equal model
        // before the provider starts refusing. Free quota lasts longer and fewer calls fail.
        const pr = this.pressure(name, m.id);
        out.push({ provider: name, model: m.id, free: isFree, rank: Math.round((st.score - penalty - 15 * pr * pr) * 10) / 10, src: st.src });
      }
    }
    out.sort((a, b) => {
      if (mode === 'mixed' && a.free !== b.free) return a.free ? -1 : 1;
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.free === b.free ? 0 : a.free ? -1 : 1;
    });
    return out.slice(0, 25);
  }

  // Decide what to try for a request: smart (task + mode), a hand-made route, or one exact model.
  plan(body, rk) {
    const raw = String(body.model || '').trim();
    const sm = raw.match(SMART_RE);
    if (sm && SMART_NAMES.includes(sm[1]) && !this.cfg.routes[raw]) {
      const det = detectTask(body);
      let task = sm[1];
      if (task === 'auto' || task === 'smart') task = rk && rk.task && rk.task !== 'detect' ? rk.task : det.task;
      if (task === 'chat') task = 'general';
      const mode = sm[2] || (rk && rk.mode && rk.mode !== 'inherit' ? rk.mode : this.cfg.settings.mode);
      let targets = this.smartTargets(task, mode, det);
      let used = task;
      if (!targets.length && task !== 'vision' && task !== 'video' && task !== 'general') {
        targets = this.smartTargets('general', mode, det);
        used = 'general';
      }
      // Keep a running conversation (especially a tool loop) on the model that started it.
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const firstSys = msgs.find((m) => m && m.role === 'system');
      const firstUser = msgs.find((m) => m && m.role === 'user');
      const aff = firstUser ? 'aff:' + (rk ? rk.id : 'admin') + ':' + fnv(msgText(firstSys).slice(0, 2000) + '|' + msgText(firstUser).slice(0, 2000)) : null;
      if (aff && msgs.some((m) => m && m.role === 'assistant')) {
        const a = this.affinity.get(aff);
        if (a && Date.now() - a.at < HOUR) {
          const i = targets.findIndex((t) => t.provider === a.provider && t.model === a.model);
          if (i > 0) targets.unshift(targets.splice(i, 1)[0]);
        }
      }
      return { targets, task: used, mode, smart: true, aff };
    }
    const targets = this.resolveTargets(raw);
    if (targets.length) return { targets, task: null, mode: null, smart: false };
    const def = this.cfg.settings.defaultRoute || 'auto';
    if (def !== raw) return this.plan(Object.assign({}, body, { model: def }), rk);
    return { targets: [], task: null, mode: null, smart: false };
  }

  remember(aff, t) {
    if (!aff) return;
    this.affinity.set(aff, { provider: t.provider, model: t.model, at: Date.now() });
    if (this.affinity.size > 2000) this.affinity.delete(this.affinity.keys().next().value);
  }

  // ---------- usage buckets ----------
  today(tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date());
  }

  bucket(id, tz) {
    const d = this.today(tz);
    let b = this.state[id];
    if (!b) b = this.state[id] = { day: d, dayCount: 0, hits: [], cooldownUntil: 0, exhaustedDay: '', reason: '', ok: 0, fail: 0 };
    if (b.day !== d) {
      b.day = d;
      b.dayCount = 0;
    }
    const cut = Date.now() - 60000;
    b.hits = b.hits.filter((t) => t > cut);
    b.tz = tz || 'UTC';
    return b;
  }

  // Configured limits, tightened by what the provider has taught us (429s and daily quotas).
  eff(b, lim) {
    const out = Object.assign({}, lim || {});
    const L = b.learned;
    const now = Date.now();
    if (L) {
      if (L.rpm && now - L.rpmAt < 6 * HOUR) out.rpm = out.rpm ? Math.min(out.rpm, L.rpm) : L.rpm;
      if (L.rpd && now - L.rpdAt < 7 * 24 * HOUR) out.rpd = out.rpd ? Math.min(out.rpd, L.rpd) : L.rpd;
    }
    return out;
  }

  available(b, lim) {
    const l = this.eff(b, lim);
    return Date.now() >= b.cooldownUntil && b.exhaustedDay !== this.today(b.tz) && !(l.rpm && b.hits.length >= l.rpm) && !(l.rpd && b.dayCount >= l.rpd);
  }

  waitMs(b, lim) {
    const l = this.eff(b, lim);
    if (b.exhaustedDay === this.today(b.tz)) return HOUR;
    let w = Math.max(0, b.cooldownUntil - Date.now());
    if (l.rpm && b.hits.length >= l.rpm) w = Math.max(w, b.hits[0] + 60000 - Date.now());
    if (l.rpd && b.dayCount >= l.rpd) w = Math.max(w, HOUR);
    return w;
  }

  // How close one bucket is to a limit: 0 = idle, 1 = blocked. Uses our counts, learned limits and provider headers.
  load(b, lim) {
    if (!b) return 0;
    const now = Date.now();
    if (now < b.cooldownUntil || b.exhaustedDay === this.today(b.tz)) return 1;
    const l = this.eff(b, lim);
    const day = b.day === this.today(b.tz) ? b.dayCount : 0;
    const recent = b.hits.filter((t) => t > now - 60000).length;
    let x = 0;
    if (l.rpm) x = Math.max(x, recent / l.rpm);
    if (l.rpd) x = Math.max(x, day / l.rpd);
    if (b.rl && b.rlAt) {
      for (const r of limitRows(b.rl)) {
        if (!r.limit || r.remaining == null) continue;
        const daily = /day|daily/.test(r.what);
        if (now - b.rlAt > (daily ? 24 * HOUR : 60000)) continue;
        x = Math.max(x, 1 - r.remaining / r.limit);
      }
    }
    return Math.min(1, x);
  }

  // The least loaded key decides: one fresh key is enough to serve the next call.
  pressure(name, model) {
    const p = this.providers[name];
    if (!p || !p.keys.length) return 1;
    let best = 1;
    for (const k of p.keys) {
      const kb = this.state['k:' + name + ':' + k.id];
      const mb = this.state['m:' + name + ':' + k.id + ':' + model];
      best = Math.min(best, Math.max(this.load(kb, p.limits), this.load(mb, p.modelLimits)));
      if (!best) break;
    }
    return best;
  }

  // ---------- routing ----------
  resolveTargets(model) {
    const routes = this.cfg.routes;
    const asObj = (r) => (Array.isArray(r) ? { targets: r } : r);
    if (model && routes[model]) {
      const r = asObj(routes[model]);
      let t = r.targets.slice();
      if (r.strategy === 'roundrobin') {
        const i = (this.rrRoute[model] = ((this.rrRoute[model] ?? -1) + 1) % t.length);
        t = t.slice(i).concat(t.slice(0, i));
      }
      if (r.strategy === 'shuffle') {
        for (let i = t.length - 1; i > 0; i--) {
          const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
          [t[i], t[j]] = [t[j], t[i]];
        }
      }
      return t;
    }
    const i = model ? model.indexOf('/') : -1;
    if (i > 0 && this.providers[model.slice(0, i)]) return [{ provider: model.slice(0, i), model: model.slice(i + 1) }];
    const found = [];
    for (const name of Object.keys(this.providers)) {
      const c = this.catalog[name];
      if (c && c.models.some((m) => m.id === model)) found.push({ provider: name, model });
    }
    if (found.length) return found;
    return Object.values(routes).flatMap((r) => asObj(r).targets).filter((t) => t.model === model);
  }

  *candidates(targets) {
    for (const t of targets) {
      const p = this.providers[t.provider];
      if (!p) continue;
      const start = (this.rrProvider[t.provider] = (this.rrProvider[t.provider] || 0) + 1) % p.keys.length;
      for (let i = 0; i < p.keys.length; i++) {
        const k = p.keys[(start + i) % p.keys.length];
        const tz = p.resetTz || 'UTC';
        const kb = this.bucket('k:' + t.provider + ':' + k.id, tz);
        const mb = this.bucket('m:' + t.provider + ':' + k.id + ':' + t.model, tz);
        const mlim = t.limits || p.modelLimits;
        yield { t, p, k, kb, mb, mlim, ok: this.available(kb, p.limits) && this.available(mb, mlim) };
      }
    }
  }

  // What an upstream failure means. null = not retryable, return it to the client as is.
  classify(status, text, headers) {
    const msg = String(text || '').toLowerCase();
    const ra = Number(headers && headers.get ? headers.get('retry-after') : 0) || 0;
    if (status === 400 && /thought_signature|thought signature|reasoning_details|tool_use_id|tool_call_id|function call .{0,80}missing/.test(msg))
      return { kind: 'skip', reason: 'cannot read this conversation history' };
    if (status === 400 && /does not support (tools|function)|tools? (are|is) not supported|function calling is not (enabled|supported)/.test(msg))
      return { kind: 'skip', reason: 'model cannot use tools' };
    if (status === 400 && /bidigeneratecontent|live api|only supports|not supported for generatecontent|not a chat model|is not supported for this|model .{0,60}(not found|does not exist|is not supported|not available)/.test(msg))
      return { kind: 'cool', secs: 86400, scope: 'model', reason: 'model not usable for chat' };
    if (status === 402 || /insufficient.{0,20}(credit|balance|fund)|out of credits|payment required/.test(msg))
      return { kind: 'daily', scope: 'key', reason: 'no credits' };
    if (status === 429 || /rate.?limit|quota|too many requests|resource.?exhausted/.test(msg)) {
      // tokens: the daily cap is on tokens, so the request count tells nothing about a request limit.
      if (/per.?day|daily|per_day|perday|free-models-per-day|requests per day|rpd/.test(msg)) return { kind: 'daily', scope: 'quota', reason: 'daily quota', tokens: /token/.test(msg) && !/request/.test(msg) };
      return { kind: 'cool', secs: ra || 60, scope: 'model', reason: 'rate limited', hinted: !!ra };
    }
    if (status === 401) return { kind: 'cool', secs: 3600, scope: 'key', reason: 'auth 401' };
    // 403 is often one model the key may not use (OpenCode free models outside its app, plan-locked models).
    // Pause that model only, unless the message says the key itself is bad.
    if (status === 403) {
      if (/invalid.{0,20}(api.?)?key|key.{0,20}(invalid|revoked|expired|disabled)|unauthori[sz]ed|authentication/.test(msg) && !/model/.test(msg))
        return { kind: 'cool', secs: 3600, scope: 'key', reason: 'auth 403' };
      return { kind: 'cool', secs: 6 * 3600, scope: 'model', reason: 'model refused (403)' };
    }
    if (status === 404) return { kind: 'cool', secs: 3600, scope: 'model', reason: 'model not found' };
    if (status === 0 || status === 408 || status >= 500) return { kind: 'cool', secs: ra || 20, scope: 'model', reason: 'upstream ' + (status || 'network') };
    return null;
  }

  penalize(c, cls) {
    const scope = cls.scope === 'quota' ? c.p.quotaScope || 'key' : cls.scope;
    const b = scope === 'key' ? c.kb : c.mb;
    b.fail++;
    b.reason = cls.reason;
    if (cls.kind === 'daily') b.exhaustedDay = this.today(b.tz);
    else b.cooldownUntil = Date.now() + cls.secs * 1000;
    // Out of credits: the free allowance is spent, whatever our own count says.
    const pa = c.p.allowance;
    if (cls.reason === 'no credits' && pa) {
      const all = this.usage.allow || (this.usage.allow = {});
      all[c.t.provider] = { period: this.allowPeriod(pa), used: pa.tokens };
    }
    // Learn the real limit from where it broke, so next time we stop just before it.
    // A short Retry-After is a burst limit, not a per-minute one: wait it out, learn nothing.
    if (cls.reason === 'rate limited' && b.hits.length > 1 && !(cls.hinted && cls.secs < 15)) {
      b.learned = Object.assign(b.learned || {}, { rpm: Math.max(1, b.hits.length - 1), rpmAt: Date.now() });
    }
    if (cls.reason === 'daily quota' && b.dayCount > 1 && !cls.tokens) {
      b.learned = Object.assign(b.learned || {}, { rpd: Math.max(1, b.dayCount - 1), rpdAt: Date.now() });
    }
    log({ message: 'failover', provider: c.t.provider, model: c.t.model, key: c.k.mask, reason: cls.reason, scope, learned: b.learned || null });
    this.save();
  }

  // Rate-limit headers: remember them, and pause the key early when a provider says 0 remaining.
  readLimits(c, headers) {
    const rl = {};
    let n = 0;
    headers.forEach((v, k) => {
      if (/ratelimit/i.test(k) && n < 10) {
        rl[k.toLowerCase()] = v;
        n++;
      }
    });
    if (!n) return;
    c.kb.rl = rl;
    c.kb.rlAt = Date.now();
    for (const [k, v] of Object.entries(rl)) {
      if (!/remaining/.test(k) || Number(v) !== 0) continue;
      const wait = Math.min(24 * HOUR, parseReset(rl[k.replace('remaining', 'reset')]) || 60000);
      if (Date.now() + wait > c.kb.cooldownUntil) {
        c.kb.cooldownUntil = Date.now() + wait;
        c.kb.reason = 'provider says 0 left';
      }
    }
  }

  // Error embedded in a 200 response (OpenRouter does this, also as the first SSE event).
  embeddedError(text) {
    const m = text.match(/(?:^|\n)data:\s*(\{.*\})/);
    const raw = m ? m[1] : text;
    try {
      const j = JSON.parse(raw);
      if (j.error && !(j.choices && j.choices.length)) return { status: Number(j.error.code) || Number(j.error.status) || 500, text: JSON.stringify(j.error) };
    } catch {
      /* not json */
    }
    return null;
  }

  // ---------- entry ----------
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (p.startsWith('/admin/')) return this.admin(request, p);

    const tok = bearer(request);
    const rk = tok ? this.rkByHash.get(await sha(tok)) : null;
    if (!rk || rk.enabled === false) return json(401, { error: { message: 'invalid router key' } });

    if (request.method === 'GET' && (p === '/v1/models' || p === '/models')) return json(200, this.models());
    if (request.method === 'POST') {
      const ep = p.replace(/^\/v1/, '');
      if (['/chat/completions', '/completions', '/embeddings'].includes(ep)) {
        let body;
        try {
          body = await request.json();
        } catch {
          return json(400, { error: { message: 'invalid JSON' } });
        }
        return this.proxy(body, ep, request.signal, rk);
      }
    }
    return json(404, { error: { message: 'not found' } });
  }

  models() {
    const data = SMART_NAMES.map((id) => ({ id, object: 'model', owned_by: 'router' }));
    for (const id of Object.keys(this.cfg.routes)) data.push({ id, object: 'model', owned_by: 'router' });
    return { object: 'list', data };
  }

  async proxy(body, endpoint, signal, rk) {
    // Daily cap per agent key: a leaked key cannot drain all your quota.
    if (rk) {
      const rb = this.bucket('rk:' + rk.id, 'UTC');
      if (rk.dailyCap && rb.dayCount >= rk.dailyCap)
        return json(429, { error: { message: 'Daily cap (' + rk.dailyCap + ') reached for agent key "' + rk.label + '"', type: 'router_cap' } }, { 'retry-after': '3600' });
      rb.dayCount++;
      rb.hits.push(Date.now());
      this.save();
    }

    const plan = endpoint === '/chat/completions' ? this.plan(body, rk) : { targets: this.resolveTargets(String(body.model || '')), task: null, mode: null, smart: false };
    const meta = {};
    if (plan.task) meta['x-router-task'] = plan.task;
    if (plan.mode) meta['x-router-mode'] = plan.mode;
    if (!plan.targets.length) {
      const msg = plan.smart
        ? 'No ' + (plan.mode === 'free' ? 'free ' : '') + 'model for "' + plan.task + '" is available. Add provider keys, refresh the model list, or use mode mixed.'
        : 'unknown model or route: ' + body.model;
      return json(plan.smart ? 503 : 404, { error: { message: msg, type: 'router_no_model' } }, meta);
    }

    const who = rk ? rk.id : 'dashboard';
    const promptEst = Math.ceil(JSON.stringify(body.messages || body.input || body.prompt || '').length / 4);
    const tried = [];
    const maxAttempts = this.cfg.settings.maxAttempts || 12;
    let attempts = 0;
    let waited = 0;
    let soonest = HOUR;
    const usable = (c) => !(c.t.free === false && !this.paidAllowed());

    // Rounds: try every ready model; if all are only briefly blocked (a per-minute limit), wait for the
    // first free slot instead of failing the agent's call. Capped by the "wait for a slot" setting.
    for (let round = 0; ; round++) {
    for (const c of this.candidates(plan.targets)) {
      if (!c.ok) continue;
      if (c.t.free === false && !this.paidAllowed()) continue;
      if (++attempts > maxAttempts || (signal && signal.aborted)) break;
      const label = c.t.provider + '/' + c.t.model;
      c.kb.hits.push(Date.now());
      c.kb.dayCount++;
      c.mb.hits.push(Date.now());
      c.mb.dayCount++;
      if (c.t.free === false) this.paidBucket().dayCount++;
      this.save();

      const ctrl = new AbortController();
      if (signal) signal.addEventListener('abort', () => ctrl.abort());
      const timer = setTimeout(() => ctrl.abort(), this.cfg.settings.timeoutMs || 90000);
      let r;
      try {
        r = await fetch(c.p.baseUrl + endpoint, {
          method: 'POST',
          headers: hdrs(c.p, c.k, { 'content-type': 'application/json' }),
          body: JSON.stringify(Object.assign({}, body, c.t.params || {}, { model: c.t.model }, isGemini(c.t.provider, c.p) ? { messages: addGeminiSignatures(body.messages) } : {})),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (signal && signal.aborted) return new Response(null, { status: 499 });
        tried.push(label + ': ' + (e.name === 'AbortError' ? 'timeout' : e.message));
        this.penalize(c, this.classify(0));
        continue;
      }
      this.readLimits(c, r.headers);

      const hdr = Object.assign({ 'x-router-provider': c.t.provider, 'x-router-model': c.t.model, 'x-router-attempts': String(attempts), 'x-router-paid': c.t.free === false ? '1' : '0' }, meta);

      if (!r.ok) {
        clearTimeout(timer);
        const text = await r.text().catch(() => '');
        const cls = this.classify(r.status, text, r.headers);
        tried.push(label + ': ' + r.status + ' ' + text.slice(0, 160));
        if (!cls) return new Response(text, { status: r.status, headers: Object.assign({ 'content-type': r.headers.get('content-type') || 'application/json' }, hdr) });
        if (cls.kind === 'skip') {
          log({ message: 'skipped model', provider: c.t.provider, model: c.t.model, reason: cls.reason });
          continue;
        }
        this.penalize(c, cls);
        continue;
      }

      const isStream = (r.headers.get('content-type') || '').includes('text/event-stream');
      if (!isStream) {
        const text = await r.text().catch(() => '');
        clearTimeout(timer);
        const ee = this.embeddedError(text);
        if (ee) {
          tried.push(label + ': ' + ee.status + ' ' + ee.text.slice(0, 160));
          this.penalize(c, this.classify(ee.status, ee.text) || this.classify(500));
          continue;
        }
        c.mb.ok++;
        c.kb.ok++;
        this.remember(plan.aff, c.t);
        this.markWorking(c);
        this.countReply(c, who, promptEst, text);
        return new Response(text, { status: 200, headers: Object.assign({ 'content-type': r.headers.get('content-type') || 'application/json' }, hdr) });
      }

      // Stream: peek until the first data event so an error-as-first-event can still fail over.
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      const chunks = [];
      let peek = '';
      try {
        while (!/(^|\n)data:/.test(peek)) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          peek += dec.decode(value, { stream: true });
        }
      } catch (e) {
        clearTimeout(timer);
        if (signal && signal.aborted) return new Response(null, { status: 499 });
        tried.push(label + ': stream ' + e.message);
        this.penalize(c, this.classify(0));
        continue;
      }
      clearTimeout(timer);
      const ee = this.embeddedError(peek);
      if (ee) {
        reader.cancel().catch(() => {});
        tried.push(label + ': ' + ee.status + ' ' + ee.text.slice(0, 160));
        this.penalize(c, this.classify(ee.status, ee.text) || this.classify(500));
        continue;
      }

      c.mb.ok++;
      c.kb.ok++;
      this.remember(plan.aff, c.t);
      this.markWorking(c);
      this.save();
      // Watch the stream go by to count tokens, without holding it back.
      const self = this;
      let tail = peek.slice(-6000);
      let chars = contentChars(peek);
      let counted = false;
      const finish = () => {
        if (counted) return;
        counted = true;
        self.countReply(c, who, promptEst, tail, chars);
      };
      const stream = new ReadableStream({
        start(controller) {
          for (const ch of chunks) controller.enqueue(ch);
        },
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              finish();
              controller.close();
            } else {
              const str = dec.decode(value, { stream: true });
              tail = (tail + str).slice(-6000);
              chars += contentChars(str);
              controller.enqueue(value);
            }
          } catch {
            finish();
            controller.close();
          }
        },
        cancel() {
          finish();
          reader.cancel().catch(() => {});
        },
      });
      return new Response(stream, { status: 200, headers: Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, hdr) });
    }
    const waits = [];
    for (const c of this.candidates(plan.targets)) if (usable(c)) waits.push(Math.max(this.waitMs(c.kb, c.p.limits), this.waitMs(c.mb, c.mlim)));
    soonest = Math.min.apply(null, waits.concat([HOUR]));
    const cap = (this.cfg.settings.waitSecs ?? 20) * 1000;
    if (round < 3 && soonest > 0 && waited + soonest <= cap && attempts < maxAttempts && !(signal && signal.aborted)) {
      log({ message: 'waiting for a free slot', model: body.model, ms: soonest });
      await sleep(soonest + 50, signal);
      waited += soonest + 50;
      meta['x-router-waited'] = String(waited);
      continue;
    }
    break;
    }

    const retry = Math.max(1, Math.ceil(soonest / 1000));
    const noKeys = plan.targets.every((t) => !this.providers[t.provider]);
    log({ message: 'exhausted', model: body.model, task: plan.task, mode: plan.mode, tried: tried.length, noKeys });
    return json(
      429,
      {
        error: {
          message: noKeys ? 'No provider for "' + body.model + '" has a key yet. Add keys in the dashboard.' : 'All models busy or out of quota for "' + body.model + '". Retry in ~' + retry + 's.',
          type: 'router_exhausted',
          tried,
        },
      },
      Object.assign({ 'retry-after': String(retry) }, meta),
    );
  }

  // ---------- views for the dashboard ----------
  status() {
    const providers = {};
    for (const [name, p] of Object.entries(this.providers)) {
      providers[name] = p.keys.map((k) => {
        const kb = this.bucket('k:' + name + ':' + k.id, p.resetTz || 'UTC');
        const models = {};
        const pre = 'm:' + name + ':' + k.id + ':';
        for (const [id, b] of Object.entries(this.state)) {
          if (!id.startsWith(pre)) continue;
          this.bucket(id, b.tz);
          models[id.slice(pre.length)] = {
            today: b.dayCount,
            lastMin: b.hits.length,
            ok: b.ok,
            fail: b.fail,
            blockedFor: Math.ceil(this.waitMs(b, p.modelLimits) / 1000),
            reason: b.reason || undefined,
            learned: this.eff(b, {}),
          };
        }
        return {
          id: k.id,
          key: k.mask,
          label: k.label,
          today: kb.dayCount,
          lastMin: kb.hits.length,
          limits: p.limits,
          learned: this.eff(kb, {}),
          headers: kb.rl || null,
          blockedFor: Math.ceil(this.waitMs(kb, p.limits) / 1000),
          reason: kb.reason || undefined,
          models,
        };
      });
    }
    const routerKeys = this.cfg.routerKeys.map((rk) => {
      const b = this.bucket('rk:' + rk.id, 'UTC');
      return { id: rk.id, label: rk.label, today: b.dayCount, lastMin: b.hits.length, dailyCap: rk.dailyCap || 0, enabled: rk.enabled !== false };
    });
    return { providers, routerKeys, paidToday: this.paidBucket().dayCount, paidDailyCap: this.cfg.settings.paidDailyCap || 0 };
  }

  catalogView() {
    const health = this.health();
    const providers = {};
    const models = [];
    for (const [name, c] of Object.entries(this.catalog)) {
      if (!this.cfg.providers[name]) continue;
      const usable = !!this.providers[name];
      providers[name] = { at: c.at, error: c.error, count: c.models.length, total: c.total || c.models.length, usable, billing: this.billingOf(name) };
      for (const m of c.models) {
        if (!isChatId(m.id)) continue;
        const key = name + '/' + m.id;
        const ov = this.cfg.overrides[key] || {};
        const hh = health[key];
        const hit = this.benchLookup(m.id);
        const base = hit ? toScore(hit.row[0]) : m.score;
        models.push({ provider: name, id: m.id, free: this.freeOf(name, m), credit: !m.free && this.freeOf(name, m), ctx: m.ctx, tools: m.tools, cats: m.cats, base, score: ov.score != null ? ov.score : base, custom: ov.score != null, src: ov.score != null ? 'custom' : hit ? 'lmarena' : 'estimate', arena: hit ? { rating: hit.row[0], coding: hit.row[1], math: hit.row[2], hard: hit.row[3], long: hit.row[4], vision: hit.row[5], as: hit.key, exact: hit.exact } : null, off: !!ov.off, usable, ok: hh ? hh.ok : 0, fail: hh ? hh.fail : 0 });
      }
    }
    const mode = this.cfg.settings.mode;
    const top = {};
    for (const cat of CATEGORIES) top[cat] = this.smartTargets(cat, mode, null, health).slice(0, 6);
    return { providers, models, top, mode, bench: this.benchInfo(), paidDailyCap: this.cfg.settings.paidDailyCap || 0, paidToday: this.paidBucket().dayCount };
  }

  // Everything the dashboard needs in one call.
  dashboard() {
    const days = this.usage.days || {};
    const dayList = [];
    for (let i = 13; i >= 0; i--) dayList.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const zero = () => ({ p: 0, c: 0, req: 0, est: 0 });
    const sumDays = (n) => {
      const out = zero();
      for (const d of dayList.slice(-n)) {
        const x = days[d];
        if (!x) continue;
        out.p += x.p;
        out.c += x.c;
        out.req += x.req;
        out.est += x.est || 0;
      }
      return out;
    };
    const groupDays = (field, n) => {
      const out = {};
      for (const d of dayList.slice(-n)) {
        const x = days[d];
        if (!x || !x[field]) continue;
        for (const [k, v] of Object.entries(x[field])) {
          const o = out[k] || (out[k] = { p: 0, c: 0, req: 0 });
          o.p += v.p;
          o.c += v.c;
          o.req += v.req;
        }
      }
      return out;
    };
    const month = zero();
    for (const x of Object.values(days)) {
      month.p += x.p;
      month.c += x.c;
      month.req += x.req;
      month.est += x.est || 0;
    }
    const prov1 = groupDays('prov', 1);
    const prov7 = groupDays('prov', 7);
    const keys1 = groupDays('keys', 1);
    const keys7 = groupDays('keys', 7);
    const models7 = groupDays('models', 7);

    const providers = [];
    for (const [name, p] of Object.entries(this.cfg.providers)) {
      const cat = this.catalog[name];
      const ch = this.checks[name] || {};
      const ac = this.acct[name] || {};
      const chatModels = cat ? cat.models.filter((m) => isChatId(m.id)) : [];
      const free = chatModels.filter((m) => this.freeOf(name, m)).length;
      const paid = chatModels.length - free;
      const credit = chatModels.filter((m) => !m.free && this.freeOf(name, m)).length;
      const tz = p.resetTz || 'UTC';
      const keys = p.keys.map((k) => {
        const kb = this.bucket('k:' + name + ':' + k.id, tz);
        const pre = 'm:' + name + ':' + k.id + ':';
        const models = [];
        for (const [id, b] of Object.entries(this.state)) {
          if (!id.startsWith(pre)) continue;
          this.bucket(id, b.tz);
          const l = this.eff(b, p.modelLimits);
          const wait = Math.ceil(this.waitMs(b, p.modelLimits) / 1000);
          if (b.dayCount || wait || l.rpm || l.rpd) models.push({ model: id.slice(pre.length), today: b.dayCount, lastMin: b.hits.length, rpm: l.rpm || null, rpd: l.rpd || null, blockedFor: wait, reason: wait ? b.reason || '' : '' });
        }
        models.sort((x, y) => y.blockedFor - x.blockedFor || y.today - x.today);
        const l = this.eff(kb, p.limits);
        return {
          id: k.id,
          mask: k.mask,
          label: k.label,
          added: k.added,
          check: (ch.keys && ch.keys[k.id]) || null,
          today: kb.dayCount,
          lastMin: kb.hits.length,
          rpm: l.rpm || null,
          rpd: l.rpd || null,
          blockedFor: Math.ceil(this.waitMs(kb, p.limits) / 1000),
          reason: kb.reason || '',
          rows: limitRows(kb.rl),
          rowsAt: kb.rlAt || null,
          acct: ac[k.id] || null,
          models: models.slice(0, 6),
        };
      });
      let status = 'nokey';
      let statusText = 'No key yet';
      if (p.keys.length && p.enabled === false) {
        status = 'off';
        statusText = 'Turned off';
      } else if (p.keys.length) {
        const checked = keys.filter((k) => k.check);
        const allBad = checked.length && checked.length === keys.length && checked.every((k) => !k.check.ok);
        const blocked = keys.every((k) => k.blockedFor > 0);
        if (allBad && checked.every((k) => k.check.limited)) {
          status = 'limited';
          statusText = checked[0].check.error;
        } else if (allBad) {
          status = 'error';
          statusText = checked[0].check.error;
        } else if (cat && cat.error && !chatModels.length) {
          status = 'error';
          statusText = cat.error;
        } else if (blocked && !(ch.freeTest && ch.freeTest.waiting)) {
          status = 'limited';
          statusText = 'Rate limited, back in ' + Math.ceil(Math.min.apply(null, keys.map((k) => k.blockedFor)) / 60) + ' min';
        } else if (!cat) {
          status = 'checking';
          statusText = 'Loading models';
        } else if (free && ch.freeTest && ch.freeTest.none) {
          status = 'connected';
          statusText = free + ' free model' + (free === 1 ? '' : 's') + ', test pending';
        } else if (free && ch.freeTest && ch.freeTest.ok) {
          status = 'ready';
          statusText = free + ' free model' + (free === 1 ? '' : 's') + ' ready';
        } else if (free && ch.freeTest && !ch.freeTest.ok && ch.freeTest.limited) {
          status = 'limited';
          const mins = ch.freeTest.retryAt ? Math.max(1, Math.ceil((ch.freeTest.retryAt - Date.now()) / 60000)) : 5;
          statusText = (ch.freeTest.waiting ? 'Free test waits for the rate limit' : 'Free test hit the rate limit') + ', runs in ~' + (mins >= 90 ? Math.round(mins / 60) + ' h' : mins + ' min');
        } else if (free && ch.freeTest && !ch.freeTest.ok) {
          status = 'warn';
          statusText = 'Free test failed: ' + shortErr(ch.freeTest.error);
        } else if (!free) {
          status = 'paid';
          statusText = chatModels.length + ' paid model' + (chatModels.length === 1 ? '' : 's');
        } else {
          status = 'connected';
          statusText = free + ' free model' + (free === 1 ? '' : 's') + ', test pending';
        }
      }
      providers.push({
        name,
        baseUrl: p.baseUrl,
        billing: this.billingOf(name),
        enabled: p.enabled !== false,
        preset: !!PRESETS[name],
        status,
        statusText,
        free,
        paid,
        catalogAt: cat ? cat.at : null,
        catalogError: cat ? cat.error : null,
        freeTest: ch.freeTest && !(ch.freeTest.none && free) ? ch.freeTest : null,
        credit,
        allowance: this.allowInfo(name),
        keyless: p.keys.length > 0 && p.keys.every((k) => !k.key),
        note: (PRESETS[name] && PRESETS[name].note) || null,
        tpd: (p.limits && p.limits.tpd) || null,
        tokensToday: prov1[name] || { p: 0, c: 0, req: 0 },
        tokens7d: prov7[name] || { p: 0, c: 0, req: 0 },
        limits: p.limits || null,
        modelLimits: p.modelLimits || null,
        keys,
      });
    }
    const order = { ready: 0, warn: 1, connected: 2, limited: 3, paid: 4, checking: 5, error: 6, off: 7, nokey: 8 };
    providers.sort((x, y) => order[x.status] - order[y.status] || x.name.localeCompare(y.name));

    const agentKeys = this.cfg.routerKeys.map((rk) => {
      const b = this.bucket('rk:' + rk.id, 'UTC');
      return { id: rk.id, label: rk.label, created: rk.created, mode: rk.mode || 'inherit', task: rk.task || 'detect', dailyCap: rk.dailyCap || 0, enabled: rk.enabled !== false, today: b.dayCount, tokensToday: keys1[rk.id] || { p: 0, c: 0, req: 0 }, tokens7d: keys7[rk.id] || { p: 0, c: 0, req: 0 } };
    });
    const topModels = Object.entries(models7)
      .map(([k, v]) => Object.assign({ key: k }, v))
      .sort((x, y) => y.p + y.c - (x.p + x.c))
      .slice(0, 8);

    return {
      now: Date.now(),
      capacity: capacityOf(providers),
      settings: this.cfg.settings,
      paidToday: this.paidBucket().dayCount,
      totals: { today: sumDays(1), week: sumDays(7), month },
      series: dayList.map((d) => Object.assign({ day: d }, days[d] ? { p: days[d].p, c: days[d].c, req: days[d].req } : { p: 0, c: 0, req: 0 })),
      byProvider: Object.entries(prov7).map(([k, v]) => Object.assign({ name: k }, v)).sort((x, y) => y.p + y.c - (x.p + x.c)),
      dashboardTokens7d: keys7.dashboard || null,
      topModels,
      agentKeys,
      providers,
    };
  }

  publicConfig() {
    const providers = {};
    for (const [n, p] of Object.entries(this.cfg.providers)) {
      providers[n] = {
        baseUrl: p.baseUrl,
        enabled: p.enabled !== false,
        billing: this.billingOf(n),
        limits: p.limits || null,
        modelLimits: p.modelLimits || null,
        quotaScope: p.quotaScope || 'key',
        resetTz: p.resetTz || 'UTC',
        headers: p.headers || {},
        keys: p.keys.map((k) => ({ id: k.id, mask: k.mask, label: k.label, added: k.added })),
        models: this.catalog[n] ? this.catalog[n].models.length : null,
        catalogAt: this.catalog[n] ? this.catalog[n].at : null,
        catalogError: this.catalog[n] ? this.catalog[n].error : null,
      };
    }
    const routerKeys = this.cfg.routerKeys.map((rk) => ({ id: rk.id, label: rk.label, created: rk.created, dailyCap: rk.dailyCap || 0, enabled: rk.enabled !== false, mode: rk.mode || 'inherit', task: rk.task || 'detect' }));
    return { providers, routes: this.cfg.routes, settings: this.cfg.settings, routerKeys, presets: PRESETS, smart: SMART_NAMES, categories: CATEGORIES, modes: MODES };
  }

  validateRoutes(routes) {
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('Routes must be an object: { "routeName": [targets] }');
    const out = {};
    for (const [name, r] of Object.entries(routes)) {
      if (!NAME_RE.test(name)) throw new Error('Bad route name "' + name + '": use lowercase letters, digits, - or _');
      if (SMART_NAMES.includes(name)) throw new Error('"' + name + '" is a smart route name and is reserved. Pick another name.');
      const obj = Array.isArray(r) ? { targets: r } : r;
      if (!obj || !Array.isArray(obj.targets) || !obj.targets.length) throw new Error('Route "' + name + '" needs at least one target');
      const targets = obj.targets.map((t, i) => {
        if (!t || typeof t.provider !== 'string' || typeof t.model !== 'string' || !t.model.trim())
          throw new Error('Route "' + name + '" target ' + (i + 1) + ' needs "provider" and "model"');
        const o = { provider: t.provider, model: t.model.trim() };
        const l = cleanLimits(t.limits);
        if (l) o.limits = l;
        if (t.params && typeof t.params === 'object' && !Array.isArray(t.params)) o.params = t.params;
        return o;
      });
      out[name] = obj.strategy === 'roundrobin' || obj.strategy === 'shuffle' ? { strategy: obj.strategy, targets } : targets;
    }
    return out;
  }

  // ---------- admin API (dashboard) ----------
  async admin(request, p) {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
    const f = this.fails.get(ip);
    if (f && f.n >= 10 && Date.now() - f.t < 600000) return json(429, { error: { message: 'Too many wrong admin keys. Wait 10 minutes.' } });
    const tok = bearer(request);
    // A short admin key can be guessed. Older installs may have one, so warn in the logs instead of locking them out.
    if (this.env.ADMIN_KEY && String(this.env.ADMIN_KEY).length < 16 && !this.warnedShort) {
      this.warnedShort = true;
      log({ message: 'ADMIN_KEY is shorter than 16 characters. Replace it with: openssl rand -hex 24' });
    }
    const ok = !!this.env.ADMIN_KEY && !!tok && (await safeEqual(tok, this.env.ADMIN_KEY));
    if (!ok) {
      const g = f && Date.now() - f.t < 600000 ? f : { n: 0, t: Date.now() };
      g.n++;
      this.fails.set(ip, g);
      log({ message: 'admin auth failed', ip });
      return json(401, { error: { message: this.env.ADMIN_KEY ? 'invalid admin key' : 'ADMIN_KEY is not set. Add it as a secret (Cloudflare) or an environment variable (Vercel), then redeploy.' } });
    }
    this.fails.delete(ip);
    const m = request.method;
    const seg = p.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    let body = {};
    if (m === 'POST' || m === 'PUT' || m === 'PATCH') body = (await request.json().catch(() => null)) || {};
    try {
      return await this.adminRoute(m, seg, body, request);
    } catch (e) {
      return json(400, { error: { message: e.message } });
    }
  }

  async adminRoute(m, seg, body, request) {
    const [a, b, c, d] = seg;
    const P = this.cfg.providers;
    const done = async () => {
      await this.saveCfg();
      return json(200, this.publicConfig());
    };

    if (m === 'GET' && a === 'config') return json(200, this.publicConfig());
    if (m === 'GET' && a === 'status') return json(200, this.status());
    if (m === 'GET' && a === 'catalog') return json(200, this.catalogView());
    if (m === 'GET' && a === 'dashboard') return json(200, this.dashboard());
    if (a === 'providers' && b && c === 'check' && m === 'POST') {
      if (!P[b]) throw new Error('Unknown provider: ' + b);
      await this.fullCheck(b);
      return json(200, this.dashboard());
    }

    if (a === 'benchmarks' && b === 'refresh' && m === 'POST') {
      await this.refreshBench();
      if (!this.bench) throw new Error(this.benchErr || 'Could not load benchmark data');
      return json(200, this.catalogView());
    }

    // Logos for the dashboard, cached for 30 days (7 when none was found). A few new ones per call.
    if (a === 'logos' && m === 'POST') {
      const items = Array.isArray(body.items) ? body.items.slice(0, 80) : [];
      const out = {};
      const pending = [];
      let fresh = 0;
      for (const it of items) {
        const name = String((it && it.name) || '').toLowerCase().slice(0, 40);
        const base = String((it && it.baseUrl) || '').slice(0, 300);
        if (!name) continue;
        const key = 'logo:' + name + '|' + base;
        const hit = await this.ctx.storage.get(key);
        if (hit && Date.now() - hit.at < (hit.url ? 30 : 7) * 86400000) {
          out[name] = hit.url;
          continue;
        }
        if (fresh >= 4) {
          pending.push(name);
          continue;
        }
        fresh++;
        const url = await resolveLogo(name, base, this.env.LOGO_FETCH);
        await this.ctx.storage.put(key, { at: Date.now(), url });
        out[name] = url;
      }
      return json(200, { logos: out, pending });
    }

    if (a === 'catalog' && b === 'refresh' && m === 'POST') {
      const names = body.provider ? [body.provider] : Object.keys(this.providers);
      await this.refreshCatalog(names);
      return json(200, this.catalogView());
    }

    if (a === 'overrides' && m === 'PUT') {
      const key = String(body.key || '');
      const i = key.indexOf('/');
      if (i <= 0 || !P[key.slice(0, i)]) throw new Error('Unknown model');
      const ov = Object.assign({}, this.cfg.overrides[key] || {});
      if ('score' in body) {
        const s = Number(body.score);
        if (body.score === null || body.score === '' || !Number.isFinite(s)) delete ov.score;
        else ov.score = Math.max(0, Math.min(100, Math.round(s)));
      }
      if ('off' in body) {
        if (body.off) ov.off = true;
        else delete ov.off;
      }
      if (Object.keys(ov).length) this.cfg.overrides[key] = ov;
      else delete this.cfg.overrides[key];
      await this.saveCfg();
      return json(200, this.catalogView());
    }

    if (a === 'providers' && b) {
      if (!NAME_RE.test(b)) throw new Error('Provider name: lowercase letters, digits, - or _ (max 32)');
      if (m === 'PUT' && !c) {
        const cur = P[b] || { keys: [] };
        const baseUrl = cleanBase(body.baseUrl != null ? body.baseUrl : cur.baseUrl || '');
        if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new Error('Base URL must start with https://');
        const next = { baseUrl, keys: cur.keys, enabled: 'enabled' in body ? !!body.enabled : cur.enabled !== false };
        next.limits = 'limits' in body ? cleanLimits(body.limits) : cur.limits;
        next.modelLimits = 'modelLimits' in body ? cleanLimits(body.modelLimits) : cur.modelLimits;
        next.allowance = 'allowance' in body ? cleanAllowance(body.allowance) : cur.allowance;
        // A new allowance starts counting from zero.
        if ('allowance' in body && next.allowance && (!cur.allowance || cur.allowance.tokens !== next.allowance.tokens || cur.allowance.per !== next.allowance.per)) {
          next.allowance.since = Date.now();
          if (this.usage.allow) delete this.usage.allow[b];
        } else if (next.allowance && cur.allowance) next.allowance.since = cur.allowance.since;
        const qs = 'quotaScope' in body ? body.quotaScope : cur.quotaScope;
        next.quotaScope = qs === 'model' ? 'model' : 'key';
        const bl = 'billing' in body ? body.billing : cur.billing || (PRESETS[b] && PRESETS[b].billing) || 'per-model';
        next.billing = ['free', 'paid', 'per-model'].includes(bl) ? bl : 'per-model';
        // Remember a pricing choice made by hand, so a later preset update never overrides it.
        if (cur.billingSet || ('billing' in body && P[b] && next.billing !== this.billingOf(b))) next.billingSet = true;
        const tz = String(('resetTz' in body ? body.resetTz : cur.resetTz) || 'UTC').trim();
        if (!validTz(tz)) throw new Error('Unknown timezone: ' + tz);
        next.resetTz = tz;
        const hd = 'headers' in body ? body.headers : cur.headers;
        if (hd && typeof hd === 'object' && !Array.isArray(hd)) {
          next.headers = {};
          for (const [hk, hv] of Object.entries(hd)) if (/^[A-Za-z0-9-]{1,64}$/.test(hk) && typeof hv === 'string') next.headers[hk] = hv.slice(0, 200);
        }
        const billingChanged = cur.billing !== next.billing || cur.baseUrl !== next.baseUrl;
        // Limits typed in by hand replace what KeyRouter learned, which may have been a wrong guess.
        if ('limits' in body && JSON.stringify(cur.limits || {}) !== JSON.stringify(next.limits || {})) {
          for (const [id, st] of Object.entries(this.state)) if (id.startsWith('k:' + b + ':') || id.startsWith('m:' + b + ':')) delete st.learned;
          this.save();
        }
        P[b] = next;
        await this.saveCfg();
        if (billingChanged && next.keys.length) await this.refreshCatalog([b]);
        if ('allowance' in body && next.keys.length) {
          const al = await this.ctx.storage.getAlarm();
          if (al == null || al > Date.now() + 5000) await this.ctx.storage.setAlarm(Date.now() + 5000);
        }
        return json(200, this.publicConfig());
      }
      if (m === 'DELETE' && !c) {
        delete P[b];
        delete this.catalog[b];
        delete this.checks[b];
        delete this.acct[b];
        await this.ctx.storage.delete('cat:' + b);
        for (const id of Object.keys(this.state)) if (id.startsWith('k:' + b + ':') || id.startsWith('m:' + b + ':')) delete this.state[id];
        for (const k of Object.keys(this.cfg.overrides)) if (k.startsWith(b + '/')) delete this.cfg.overrides[k];
        this.save();
        return done();
      }
      if (!P[b] && PRESETS[b] && c === 'keys' && m === 'POST') P[b] = Object.assign(JSON.parse(JSON.stringify(PRESETS[b])), { keys: [], enabled: true });
      if (!P[b]) throw new Error('Unknown provider: ' + b);
      if (c === 'keys' && m === 'POST' && !d) {
        if (body.keyless) {
          if (!(PRESETS[b] && PRESETS[b].keyless)) throw new Error(b + ' needs a key');
          if (P[b].keys.some((k) => !k.key)) throw new Error(b + ' is already on');
          P[b].keys.push({ id: 'nokey', key: '', mask: 'No key needed', label: '', added: Date.now() });
        } else {
          const key = String(body.key || '').trim();
          if (key.length < 8 || key.length > 512 || /\s/.test(key)) throw new Error('That does not look like an API key');
          const id = (await sha(key)).slice(0, 10);
          if (P[b].keys.some((k) => k.id === id)) throw new Error('This key is already added');
          P[b].keys.push({ id, key, mask: mask(key), label: String(body.label || '').slice(0, 40), added: Date.now() });
        }
        const nk = P[b].keys[P[b].keys.length - 1];
        log({ message: 'provider key added', provider: b, key: nk.mask });
        await this.saveCfg();
        // Save after every step: if this request is cut short, the work so far is kept.
        await this.checkKey(b, nk);
        await this.ctx.storage.put('checks', this.checks);
        await this.refreshCatalog([b]);
        await this.fetchAccount(b);
        await this.ctx.storage.put('acct', this.acct);
        await this.testFree(b);
        await this.ctx.storage.put({ checks: this.checks, acct: this.acct });
        if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + CATALOG_EVERY);
        await this.wake(this.nextRetest());
        return json(200, this.publicConfig());
      }
      if (c === 'keys' && d && m === 'DELETE') {
        P[b].keys = P[b].keys.filter((k) => k.id !== d);
        if (this.checks[b] && this.checks[b].keys) delete this.checks[b].keys[d];
        if (this.acct[b]) delete this.acct[b][d];
        for (const id of Object.keys(this.state)) if (id.startsWith('k:' + b + ':' + d) || id.startsWith('m:' + b + ':' + d + ':')) delete this.state[id];
        this.save();
        return done();
      }
      if (c === 'models' && m === 'GET') {
        await this.refreshCatalog([b]);
        const cat = this.catalog[b];
        if (cat.error) throw new Error(cat.error);
        return json(200, { count: cat.models.length, models: cat.models.map((x) => ({ id: x.id, free: this.freeOf(b, x), ctx: x.ctx })) });
      }
    }

    if (a === 'routes' && m === 'PUT') {
      this.cfg.routes = this.validateRoutes(body.routes);
      this.rrRoute = {};
      return done();
    }

    if (a === 'settings' && m === 'PUT') {
      const S = this.cfg.settings;
      const ma = Number(body.maxAttempts);
      const to = Number(body.timeoutMs);
      if (Number.isFinite(ma) && ma >= 1 && ma <= 50) S.maxAttempts = Math.floor(ma);
      if (Number.isFinite(to) && to >= 5000 && to <= 300000) S.timeoutMs = Math.floor(to);
      const ws = Number(body.waitSecs);
      if (body.waitSecs != null && Number.isFinite(ws) && ws >= 0 && ws <= 60) S.waitSecs = Math.floor(ws);
      if ('mode' in body) {
        if (!MODES.includes(body.mode)) throw new Error('Mode must be free, mixed or best');
        S.mode = body.mode;
      }
      if ('paidDailyCap' in body) {
        const cap = Number(body.paidDailyCap);
        S.paidDailyCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
      }
      return done();
    }

    if (a === 'router-keys') {
      if (m === 'POST' && !b) {
        const label = String(body.label || '').trim().slice(0, 40) || 'agent';
        const cap = Number(body.dailyCap);
        const key = 'sk-router-' + randHex(24);
        const hash = await sha(key);
        const kmode = body.mode === 'inherit' || MODES.includes(body.mode) ? body.mode : 'inherit';
        const ktask = CATEGORIES.includes(body.task) ? body.task : 'detect';
        this.cfg.routerKeys.push({ id: hash.slice(0, 10), hash, label, dailyCap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0, enabled: true, created: Date.now(), mode: kmode, task: ktask });
        await this.saveCfg();
        log({ message: 'agent key created', label });
        return json(200, { key, config: this.publicConfig() });
      }
      const rk = this.cfg.routerKeys.find((x) => x.id === b);
      if (!rk) throw new Error('Unknown agent key');
      if (m === 'PATCH') {
        if ('enabled' in body) rk.enabled = !!body.enabled;
        if ('label' in body) rk.label = String(body.label || '').trim().slice(0, 40) || rk.label;
        if ('dailyCap' in body) {
          const cap = Number(body.dailyCap);
          rk.dailyCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
        }
        if ('mode' in body) {
          if (body.mode !== 'inherit' && !MODES.includes(body.mode)) throw new Error('Mode must be inherit, free, mixed or best');
          rk.mode = body.mode;
        }
        if ('task' in body) {
          if (body.task !== 'detect' && !CATEGORIES.includes(body.task)) throw new Error('Unknown task type');
          rk.task = body.task;
        }
        return done();
      }
      if (m === 'DELETE') {
        this.cfg.routerKeys = this.cfg.routerKeys.filter((x) => x.id !== b);
        delete this.state['rk:' + b];
        this.save();
        return done();
      }
    }

    if (a === 'reset' && m === 'POST') {
      const prov = body.provider;
      for (const [id, s] of Object.entries(this.state)) {
        if (id.startsWith('rk:') || id === 'paid') continue;
        if (prov && !id.startsWith('k:' + prov + ':') && !id.startsWith('m:' + prov + ':')) continue;
        s.cooldownUntil = 0;
        s.exhaustedDay = '';
        s.reason = '';
        if (body.forget) delete s.learned;
      }
      this.save();
      return json(200, this.status());
    }

    if (a === 'test' && m === 'POST') {
      const t0 = Date.now();
      const r = await this.proxy(
        { model: body.model || 'auto', messages: [{ role: 'user', content: String(body.prompt || 'Say hi in five words.').slice(0, 4000) }], max_tokens: 400 },
        '/chat/completions',
        request.signal,
        null,
      );
      const text = await r.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        j = { raw: text.slice(0, 4000) };
      }
      return json(200, {
        status: r.status,
        ms: Date.now() - t0,
        provider: r.headers.get('x-router-provider'),
        model: r.headers.get('x-router-model'),
        attempts: r.headers.get('x-router-attempts'),
        task: r.headers.get('x-router-task'),
        mode: r.headers.get('x-router-mode'),
        paid: r.headers.get('x-router-paid') === '1',
        body: j,
      });
    }

    return json(404, { error: { message: 'unknown admin endpoint' } });
  }
}
