// First-run defaults only. Everything here can be changed from the dashboard afterwards.
// billing: 'free' = every model on this key is free to you, 'paid' = every call costs money,
// 'per-model' = the provider marks each model free or paid (OpenRouter).

export const PRESETS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', billing: 'per-model', limits: { rpm: 20 }, quotaScope: 'key', headers: { 'X-Title': 'KeyRouter' } },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', billing: 'free', quotaScope: 'model', resetTz: 'America/Los_Angeles' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', billing: 'free', quotaScope: 'model' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', billing: 'free', quotaScope: 'model' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', billing: 'free', limits: { rpm: 40 } },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', billing: 'free' },
  github: { baseUrl: 'https://models.github.ai/inference', billing: 'free' },
  sambanova: { baseUrl: 'https://api.sambanova.ai/v1', billing: 'free' },
  together: { baseUrl: 'https://api.together.xyz/v1', billing: 'paid' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', billing: 'paid' },
  // Free tiers found in the omniroute and freellmapi projects (Nov 2026). Prices are read per model.
  longcat: { baseUrl: 'https://api.longcat.chat/openai/v1', billing: 'free', note: 'Daily free token quota, resets 00:00 UTC.' },
  cohere: { baseUrl: 'https://api.cohere.ai/compatibility/v1', billing: 'free', note: 'Trial key: free, low monthly call limit.' },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1', billing: 'per-model', note: 'Small free monthly credit.' },
  ollama: { baseUrl: 'https://ollama.com/v1', billing: 'free', note: 'Free light-usage tier. Some models need a paid plan.' },
  sealion: { baseUrl: 'https://api.sea-lion.ai/v1', billing: 'free', limits: { rpm: 10 } },
  navy: { baseUrl: 'https://api.navy/v1', billing: 'per-model', limits: { rpm: 20, tpd: 150000 }, headers: { 'User-Agent': 'Mozilla/5.0 (KeyRouter)' }, note: '150K free tokens a day.' },
  xkiro: { baseUrl: 'https://api.xkiro.com/v1', billing: 'per-model', limits: { tpd: 5000000 }, note: '5M free tokens a day.' },
  anyapi: { baseUrl: 'https://api.anyapi.ai/v1', billing: 'per-model', limits: { tpd: 100000 }, note: '100K free tokens a day on free and basic models.' },
  routeway: { baseUrl: 'https://api.routeway.ai/v1', billing: 'per-model', limits: { rpm: 5, rpd: 200 }, headers: { 'User-Agent': 'Mozilla/5.0 (KeyRouter)' }, note: ':free models, about 200 a day.' },
  airforce: { baseUrl: 'https://api.airforce/v1', billing: 'per-model', limits: { rpm: 1 }, note: 'Only 1 request a minute per account.' },
  beatapi: { baseUrl: 'https://api.beatapi.io/v1', billing: 'per-model' },
  bazaarlink: { baseUrl: 'https://bazaarlink.ai/api/v1', billing: 'per-model', note: 'Use the auto:free model.' },
  iteracompute: { baseUrl: 'https://api.iteracompute.com/v1', billing: 'per-model', note: 'Monthly free token allowance: set it under Settings.' },
  requesty: { baseUrl: 'https://router.requesty.ai/v1', billing: 'per-model' },
  agnes: { baseUrl: 'https://apihub.agnes-ai.com/v1', billing: 'per-model' },
  opencode: { baseUrl: 'https://opencode.ai/zen/v1', billing: 'per-model', note: 'Free models refuse calls from outside the OpenCode app.' },
  // No key needed. Limits are per IP, and Cloudflare shares IPs, so expect them to be busy at times.
  kilo: { baseUrl: 'https://api.kilo.ai/api/gateway/v1', billing: 'per-model', keyless: true, note: 'No key. :free models, about 200 requests an hour. Free prompts may be used for training.' },
  ovh: { baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', billing: 'free', keyless: true, quotaScope: 'model', limits: { rpm: 2 }, note: 'No key. About 2 requests a minute per model.' },
};

// Optional hand-made routes. Smart routing (auto, coding, reasoning ...) needs none.
export const DEFAULT_ROUTES = {};

export const DEFAULT_SETTINGS = { defaultRoute: 'auto', maxAttempts: 12, timeoutMs: 90000, waitSecs: 20, mode: 'free', paidDailyCap: 100 };
