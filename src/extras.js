// Alerts, backups and the response cache. Small helpers the router calls.

const HTTPS = /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/;

// ---------- alerts ----------
export const ALERT_EVENTS = ['errors', 'paused', 'limits', 'budget', 'keys'];

export function cleanAlerts(body, cur, allowHttp) {
  const a = Object.assign({ telegram: null, webhook: null, events: {} }, cur || {});
  if ('telegramToken' in body || 'telegramChat' in body) {
    const token = 'telegramToken' in body ? String(body.telegramToken || '').trim() : a.telegram ? a.telegram.token : '';
    const chat = 'telegramChat' in body ? String(body.telegramChat || '').trim() : a.telegram ? a.telegram.chat : '';
    if (token && !/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token)) throw new Error('That does not look like a Telegram bot token (123456:ABC...)');
    if (chat && !/^(-?\d{3,20}|@[A-Za-z0-9_]{4,40})$/.test(chat)) throw new Error('Telegram chat: a number like 123456789 or -100..., or @channelname');
    a.telegram = token && chat ? { token, chat } : null;
  }
  if ('webhook' in body) {
    const w = String(body.webhook || '').trim();
    if (w && !(HTTPS.test(w) || (allowHttp && /^http:\/\/\S+$/.test(w)))) throw new Error('Webhook must be an https:// address');
    a.webhook = w || null;
  }
  if (body.events && typeof body.events === 'object') for (const k of ALERT_EVENTS) if (k in body.events) a.events[k] = !!body.events[k];
  return a;
}

// What the dashboard may see: never the token itself.
export function alertsView(a) {
  a = a || {};
  const ev = {};
  for (const k of ALERT_EVENTS) ev[k] = !a.events || a.events[k] !== false;
  return {
    telegram: a.telegram ? { chat: a.telegram.chat, token: a.telegram.token.slice(0, 4) + '…' + a.telegram.token.slice(-4) } : null,
    webhook: a.webhook ? a.webhook.replace(/^(https:\/\/[^/]+).*$/, '$1/…') : null,
    events: ev,
    on: !!(a.telegram || a.webhook),
  };
}

export async function deliver(a, event, text, fetcher) {
  const get = fetcher || fetch;
  const out = [];
  if (a && a.telegram) {
    const r = await get('https://api.telegram.org/bot' + a.telegram.token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: a.telegram.chat, text: 'KeyRouter: ' + text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    out.push(r.ok && j.ok !== false ? 'telegram ok' : 'telegram ' + (j.description || r.status));
  }
  if (a && a.webhook) {
    const r = await get(a.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'KeyRouter alerts' },
      body: JSON.stringify({ source: 'keyrouter', event, text, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10000),
    });
    out.push(r.ok ? 'webhook ok' : 'webhook ' + r.status);
  }
  return out;
}

// ---------- backup ----------
const PROV_FIELDS = ['baseUrl', 'enabled', 'billing', 'billingSet', 'limits', 'modelLimits', 'quotaScope', 'resetTz', 'headers', 'allowance', 'docs', 'autoUpdate', 'limitsManual', 'allowanceManual'];

// Everything needed to rebuild the router somewhere else, except provider keys and alert secrets.
export function makeBackup(cfg) {
  const providers = {};
  for (const [n, p] of Object.entries(cfg.providers)) {
    const o = {};
    for (const f of PROV_FIELDS) if (p[f] !== undefined) o[f] = p[f];
    o.keyCount = p.keys.length;
    providers[n] = o;
  }
  return {
    kind: 'keyrouter-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    note: 'Provider keys are not included. Agent keys are stored as hashes, so the same agent keys keep working after a restore.',
    providers,
    routes: cfg.routes,
    settings: cfg.settings,
    overrides: cfg.overrides,
    routerKeys: cfg.routerKeys.map((rk) => ({ id: rk.id, hash: rk.hash, label: rk.label, dailyCap: rk.dailyCap || 0, tokenCap: rk.tokenCap || 0, enabled: rk.enabled !== false, created: rk.created, mode: rk.mode, task: rk.task })),
  };
}

// Restore merges: providers you already have keep their keys; nothing is deleted.
export function applyBackup(cfg, b, clean) {
  if (!b || b.kind !== 'keyrouter-backup' || !b.providers) throw new Error('This is not a KeyRouter backup file');
  const counts = { providers: 0, routes: 0, agentKeys: 0 };
  for (const [n, p] of Object.entries(b.providers)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n) || !p || typeof p.baseUrl !== 'string' || !/^https?:\/\/\S+$/.test(p.baseUrl)) continue;
    const cur = cfg.providers[n] || { keys: [] };
    const next = Object.assign({}, cur);
    for (const f of PROV_FIELDS) if (p[f] !== undefined) next[f] = p[f];
    next.limits = clean.limits(next.limits);
    next.modelLimits = clean.limits(next.modelLimits);
    next.allowance = clean.allowance(next.allowance);
    next.keys = cur.keys;
    cfg.providers[n] = next;
    counts.providers++;
  }
  if (b.routes && typeof b.routes === 'object') {
    clean.routes(b.routes);
    Object.assign(cfg.routes, b.routes);
    counts.routes = Object.keys(b.routes).length;
  }
  if (b.settings && typeof b.settings === 'object') clean.settings(b.settings);
  if (b.overrides && typeof b.overrides === 'object') {
    for (const [k, v] of Object.entries(b.overrides)) if (/^[a-z0-9_-]+\/\S+$/.test(k) && v && typeof v === 'object') cfg.overrides[k] = { score: Number.isFinite(v.score) ? v.score : undefined, off: v.off ? true : undefined };
  }
  if (Array.isArray(b.routerKeys)) {
    for (const rk of b.routerKeys) {
      if (!rk || !/^[0-9a-f]{64}$/.test(rk.hash || '') || cfg.routerKeys.some((x) => x.hash === rk.hash)) continue;
      cfg.routerKeys.push({ id: rk.hash.slice(0, 10), hash: rk.hash, label: String(rk.label || 'agent').slice(0, 40), dailyCap: Math.max(0, Math.floor(Number(rk.dailyCap) || 0)), tokenCap: Math.max(0, Math.floor(Number(rk.tokenCap) || 0)), enabled: rk.enabled !== false, created: Number(rk.created) || Date.now(), mode: rk.mode || 'inherit', task: rk.task || 'detect' });
      counts.agentKeys++;
    }
  }
  return counts;
}

// ---------- response cache ----------
// Same agent key, same endpoint, same request body: same answer, for a short while.
export class ReplyCache {
  constructor(max) {
    this.max = max || 300;
    this.map = new Map();
  }
  get(key, ttlMs) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.at > ttlMs) {
      this.map.delete(key);
      return null;
    }
    return e;
  }
  set(key, value) {
    if (!value || value.body.length > 512000) return;
    this.map.delete(key);
    this.map.set(key, Object.assign({ at: Date.now() }, value));
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
