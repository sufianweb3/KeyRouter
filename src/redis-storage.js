// Durable Object storage API on top of Upstash Redis (REST), for running KeyRouter on Vercel.
// Covers what the router uses: get, put, delete, list({ prefix }), getAlarm and setAlarm.
//
// Each value is one Redis key (kr:v:<name>, JSON). The hash kr:vers counts writes per name, so an
// instance re-reads only the values another instance changed. Writes are batched into one round trip.
// Several function instances can run at once; the last write wins, so counters can be slightly off
// under heavy parallel traffic. Settings, keys and catalogs are written rarely and stay consistent.

const NS = 'kr:';
const VERS = NS + 'vers';
const ALARM = NS + 'alarm';
const LOCK = NS + 'alarm-lock';
const vkey = (k) => NS + 'v:' + k;

export function redisConfig(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

export class RedisStorage {
  constructor(cfg, onPending) {
    this.cfg = cfg;
    this.onPending = onPending || ((p) => p);
    this.cache = new Map(); // name -> value
    this.vers = new Map(); // name -> write count we have seen
    this.alarm = null;
    this.dirty = new Set();
    this.deleted = new Set();
    this.flushing = null;
    this.loaded = false;
  }

  async cmd(list) {
    const r = await fetch(this.cfg.url + '/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify(list),
    });
    const out = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(out)) throw new Error('Redis ' + r.status + ': ' + JSON.stringify(out).slice(0, 200));
    return out.map((x) => {
      if (x && x.error) throw new Error('Redis: ' + x.error);
      return x ? x.result : null;
    });
  }

  // Bring the local copy up to date. Returns true when something changed since the last sync.
  async sync() {
    const [flat, alarm] = await this.cmd([['HGETALL', VERS], ['GET', ALARM]]);
    const remote = new Map();
    for (let i = 0; i + 1 < (flat || []).length; i += 2) remote.set(flat[i], Number(flat[i + 1]));
    const pending = new Set([...this.dirty, ...this.deleted]);
    const need = [...remote.keys()].filter((k) => !pending.has(k) && this.vers.get(k) !== remote.get(k));
    let changed = !this.loaded;
    if (need.length) {
      const vals = await this.cmd([['MGET', ...need.map(vkey)]]);
      need.forEach((k, i) => {
        const raw = vals[0][i];
        if (raw == null) this.cache.delete(k);
        else this.cache.set(k, JSON.parse(raw));
        this.vers.set(k, remote.get(k));
      });
      changed = true;
    }
    for (const k of [...this.cache.keys()]) {
      if (!remote.has(k) && !pending.has(k) && this.vers.has(k)) {
        this.cache.delete(k);
        this.vers.delete(k);
        changed = true;
      }
    }
    this.alarm = alarm == null ? null : Number(alarm);
    this.loaded = true;
    return changed;
  }

  // ---- the Durable Object storage API ----
  async get(k) {
    if (Array.isArray(k)) {
      const m = new Map();
      for (const x of k) if (this.cache.has(x)) m.set(x, this.cache.get(x));
      return m;
    }
    return this.cache.get(k);
  }

  async list(opts) {
    const pre = (opts && opts.prefix) || '';
    const m = new Map();
    for (const [k, v] of this.cache) if (k.startsWith(pre)) m.set(k, v);
    return m;
  }

  put(k, v) {
    const obj = typeof k === 'object' ? k : { [k]: v };
    for (const [name, val] of Object.entries(obj)) {
      this.cache.set(name, val);
      this.deleted.delete(name);
      this.dirty.add(name);
    }
    return this.flush();
  }

  delete(k) {
    for (const name of Array.isArray(k) ? k : [k]) {
      this.cache.delete(name);
      this.dirty.delete(name);
      this.deleted.add(name);
    }
    return this.flush();
  }

  async getAlarm() {
    return this.alarm;
  }

  setAlarm(t) {
    this.alarm = Number(t);
    return this.onPending(this.cmd([['SET', ALARM, String(this.alarm)]]));
  }

  deleteAlarm() {
    this.alarm = null;
    return this.onPending(this.cmd([['DEL', ALARM]]));
  }

  // Batch every write made in the same tick into one request.
  flush() {
    if (!this.flushing) {
      this.flushing = Promise.resolve()
        .then(async () => {
          // Values are read now, not when put() was called, so later edits in the same tick are included.
          while (this.dirty.size || this.deleted.size) {
            const puts = [...this.dirty];
            const dels = [...this.deleted];
            this.dirty.clear();
            this.deleted.clear();
            const list = [];
            for (const k of puts) list.push(['SET', vkey(k), JSON.stringify(this.cache.get(k))], ['HINCRBY', VERS, k, '1']);
            for (const k of dels) list.push(['DEL', vkey(k)], ['HDEL', VERS, k]);
            const res = await this.cmd(list);
            puts.forEach((k, i) => this.vers.set(k, Number(res[i * 2 + 1])));
            for (const k of dels) this.vers.delete(k);
          }
        })
        .finally(() => {
          this.flushing = null;
        });
      this.onPending(this.flushing.catch(() => {}));
    }
    return this.flushing;
  }

  async idle() {
    while (this.flushing) await this.flushing.catch(() => {});
  }

  // Only one instance runs the scheduled work at a time.
  async lock(ms) {
    const [ok] = await this.cmd([['SET', LOCK, String(Date.now()), 'NX', 'PX', String(ms)]]);
    return ok === 'OK';
  }

  unlock() {
    return this.cmd([['DEL', LOCK]]).catch(() => {});
  }
}
