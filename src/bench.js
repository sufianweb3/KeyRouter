// Real benchmark data for ranking models: the official LMArena leaderboard (arena.ai), published as an
// open dataset on Hugging Face (lmarena-ai/leaderboard-dataset). Ratings come from millions of blind,
// side-by-side human votes, with separate scores for coding, math, hard prompts, long queries and vision.
// Refreshed every few days; models it does not list fall back to an estimate and are marked as such.

export const BENCH_SOURCE = {
  name: 'LMArena',
  url: 'https://arena.ai/leaderboard',
  dataset: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
};
export const BENCH_EVERY = 3 * 24 * 3600000;
const API = 'https://datasets-server.huggingface.co';

// Which leaderboard feeds each column of the stored row [overall, coding, math, hard, long, vision].
const PARTS = [
  ['text_style_control', 'overall'],
  ['text_style_control', 'coding'],
  ['text_style_control', 'math'],
  ['text_style_control', 'hard_prompts'],
  ['text_style_control', 'longer_query'],
  ['vision_style_control', 'overall'],
];

// Words that name a packaging of a model, not a different model.
const NOISE = new Set(['instruct', 'chat', 'versatile', 'latest', 'preview', 'exp', 'experimental', 'it', 'hf', 'fp8', 'bf16', 'fp16', 'nvfp4', 'int4', 'int8', 'awq', 'gguf', 'tee', 'free', 'online', 'api', 'beta', 'base', 'turbo-preview']);

// One name, many spellings: "anthropic/claude-opus-4.7:free", "Claude Opus 4.7 (High)" and
// "claude-opus-4-7-20251101" all become "claude-opus-4-7".
export function benchKey(name) {
  let s = String(name || '').toLowerCase();
  s = s.slice(s.lastIndexOf('/') + 1).replace(/:[a-z0-9_-]+$/, '');
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const out = [];
  const month = /^(0[1-9]|1[0-2])$/;
  for (const t of s.split(/[^a-z0-9]+/)) {
    if (!t || NOISE.has(t)) continue;
    if (/^20\d{6}$/.test(t) || /^\d{6}$/.test(t)) continue; // 20250514, 250514
    if (out.length >= 2 && /^(0[1-9]|1[0-2])\d{2}$/.test(t)) continue; // 0528, 1210
    if (out.length >= 2 && /^20\d{2}$/.test(t)) {
      if (month.test(out[out.length - 1])) out.pop(); // 08-2024
      continue;
    }
    out.push(t);
  }
  // A trailing "06-17" is a date.
  if (out.length > 3 && month.test(out[out.length - 2]) && /^(0[1-9]|[12]\d|3[01])$/.test(out[out.length - 1])) out.length -= 2;
  return out.join('-');
}

// Arena rating (about 1100 to 1600) to the 0-100 scale the router ranks with.
export const toScore = (r) => (r == null ? null : Math.max(0, Math.min(100, Math.round((20 + (r - 1100) * 0.17) * 10) / 10)));

// Fetch every part of the leaderboard. Returns { at, published, n, map: { key: [o, c, m, h, l, v] } }.
export async function fetchBench(base, fetcher) {
  const get = fetcher || fetch;
  const root = (base || API).replace(/\/+$/, '');
  const map = {};
  let published = null;
  for (let i = 0; i < PARTS.length; i++) {
    const [config, category] = PARTS[i];
    for (let offset = 0; offset < 2000; offset += 100) {
      const q = new URLSearchParams({ dataset: 'lmarena-ai/leaderboard-dataset', config, split: 'latest', where: '"category"=\'' + category + "'", offset: String(offset), length: '100' });
      const r = await get(root + '/filter?' + q, { headers: { accept: 'application/json', 'user-agent': 'KeyRouter (+https://github.com/sufianweb3/KeyRouter)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) {
        if (i === 0) throw new Error('LMArena data answered ' + r.status);
        break; // a missing extra board is fine: the overall score still ranks
      }
      const j = await r.json();
      const rows = Array.isArray(j.rows) ? j.rows : [];
      for (const x of rows) {
        const row = x.row || x;
        const key = benchKey(row.model_name);
        const rating = Number(row.rating);
        if (!key || !Number.isFinite(rating)) continue;
        const cur = map[key] || (map[key] = [null, null, null, null, null, null]);
        // Several entries can share a name (thinking effort, dated snapshots): keep the best.
        if (cur[i] == null || rating > cur[i]) cur[i] = Math.round(rating);
        if (!published && row.leaderboard_publish_date) published = String(row.leaderboard_publish_date).slice(0, 10);
      }
      if (rows.length < 100 || offset + 100 >= (j.num_rows_total || 0)) break;
    }
  }
  for (const k of Object.keys(map)) if (map[k][0] == null) delete map[k];
  const n = Object.keys(map).length;
  if (n < 20) throw new Error('LMArena data looked empty (' + n + ' models)');
  return { at: Date.now(), published, n, map };
}

// Find the leaderboard row for a model id. Exact name first, then the longest leaderboard name the
// id starts with (so "gpt-5-codex" uses GPT-5, "llama-3-1-8b-instant" uses Llama 3.1 8B).
export function makeLookup(bench) {
  const map = (bench && bench.map) || {};
  const keys = Object.keys(map);
  const cache = new Map();
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const k = benchKey(id);
    let hit = null;
    if (k && map[k]) hit = { key: k, row: map[k], exact: true };
    else if (k) {
      let best = null;
      for (const c of keys) {
        if (c.length < 4 || c.indexOf('-') < 0) continue;
        if (k.startsWith(c + '-') && (!best || c.length > best.length)) best = c;
      }
      // The shorter name must carry a version number, so "claude-opus" never stands in for a model.
      if (best && /\d/.test(best)) hit = { key: best, row: map[best], exact: false };
    }
    cache.set(id, hit);
    return hit;
  };
}

// Score for one task from a leaderboard row. Tasks without their own board use the overall score.
export function benchScore(row, task) {
  const [o, c, m, h, l, v] = row;
  let r = o;
  if (task === 'coding') r = c != null ? c : o;
  else if (task === 'reasoning') r = m != null && h != null ? (m + h) / 2 : h != null ? h : m != null ? m : o;
  else if (task === 'long-context') r = l != null ? l : o;
  else if (task === 'vision') r = v != null ? v : o;
  return toScore(r);
}
