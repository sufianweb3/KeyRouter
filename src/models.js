// Model knowledge: what each model is good for and roughly how strong it is.
// Scores (0-100) are a starting estimate from model family, version and size, not a benchmark.
// Any score can be changed in the dashboard, and your number always wins.

export const CATEGORIES = ['reasoning', 'coding', 'general', 'vision', 'video', 'long-context'];
export const SMART_NAMES = ['auto', 'smart', 'chat'].concat(CATEGORIES);
export const MODES = ['free', 'mixed', 'best'];

// Not chat models: skip them when building the catalog.
const SKIP = /whisper|tts|speech|transcri|audio|rerank|guard|moderation|imagen|dall-e|flux|stable-diffusion|sdxl|\bveo\b|video-gen|lyria|\bocr\b|embed|bge-|\be5-|gte-|nomic|\bclip\b|reward|retriever|parse|(^|[-_/])live([-_.]|$)|native-audio|realtime|image-generation|flash-image|image-preview|computer-use|\baqa\b|robotics/;

// True for models that can answer a normal chat request.
export function isChatId(id) {
  return !!id && !SKIP.test(String(id).toLowerCase());
}
const CODER = /coder|codestral|devstral|code|swe/;

const num = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

// Total parameters in billions from ids like 70b, 235b-a22b or 8x22b.
export function sizeB(id) {
  const moe = id.match(/(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/);
  if (moe) return num(moe[1]) * num(moe[2]);
  const m = id.match(/(?:^|[-_/:.])(\d+(?:\.\d+)?)b(?![a-z])/);
  return m ? num(m[1]) : 0;
}

// First matching rule wins. Each returns a score, or null to fall through.
const RULES = [
  [/claude[^/]*opus/, () => 97],
  [/claude[^/]*sonnet/, () => 94],
  [/claude[^/]*haiku/, () => 82],
  [/gpt-oss-(\d+)b/, (m) => (num(m[1]) >= 100 ? 80 : 64)],
  [/gpt-(\d+(?:\.\d+)?)/, (m, id) => (num(m[1]) >= 5 ? 95 : 82) - (/nano/.test(id) ? 20 : /mini/.test(id) ? 9 : 0)],
  [/gemini-(\d+(?:\.\d+)?)/, (m, id) => {
    const v = num(m[1]);
    let s = v >= 3 ? 95 : v >= 2.5 ? 90 : v >= 2 ? 82 : 72;
    if (/lite/.test(id)) s -= 16;
    else if (/flash/.test(id)) s -= 7;
    return s;
  }],
  [/grok-(\d+(?:\.\d+)?)/, (m, id) => (num(m[1]) >= 4 ? 93 : 84) - (/mini|fast/.test(id) ? 6 : 0)],
  [/deepseek[^/]*-v(\d+(?:\.\d+)?)/, (m, id) => {
    let s = 84 + (num(m[1]) - 3) * 4;
    if (/pro/.test(id)) s += 3;
    if (/flash|lite/.test(id)) s -= 1;
    return s;
  }],
  [/deepseek[^/]*r1/, () => 86],
  [/deepseek-(chat|reasoner)/, () => 88],
  [/kimi[^/]*k(\d+(?:\.\d+)?)/, (m) => 86 + (num(m[1]) - 2) * 6],
  [/glm-(\d+(?:\.\d+)?)/, (m, id) => {
    const v = num(m[1]);
    let s = v >= 5 ? 88 + (v - 5) * 8 : 80 + (v - 4) * 8;
    if (/flash|air/.test(id)) s -= 7;
    return s;
  }],
  [/minimax[^/]*m(\d+(?:\.\d+)?)/, (m) => 84 + (num(m[1]) - 2) * 4],
  [/qwen(\d+(?:\.\d+)?)/, (m, id) => {
    const v = num(m[1]);
    let s = v >= 3.5 ? 87 + (v - 3.5) * 2 : v >= 3 ? 82 : 72;
    const b = sizeB(id);
    if (b && b < 40) s -= 8;
    if (b && b < 10) s -= 10;
    if (/max/.test(id)) s += 3;
    if (/coder-next/.test(id)) s = Math.max(s, 84);
    return s;
  }],
  [/qwq/, () => 76],
  [/nemotron/, (m, id) => (/ultra/.test(id) ? 86 : /super/.test(id) ? 80 : /nano|lightning|mini/.test(id) ? 66 : 72)],
  [/llama-?4[^/]*maverick/, () => 78],
  [/llama-?4[^/]*scout/, () => 70],
  [/llama/, (m, id) => {
    const b = sizeB(id);
    return b >= 400 ? 76 : b >= 60 ? 68 : b >= 20 ? 58 : 45;
  }],
  [/devstral/, (m, id) => (/medium|large/.test(id) ? 82 : 76)],
  [/codestral/, () => 74],
  [/magistral/, (m, id) => (/medium/.test(id) ? 82 : 72)],
  [/mistral[^/]*large/, () => 82],
  [/mistral[^/]*medium/, () => 78],
  [/mistral[^/]*small/, () => 66],
  [/ministral|mistral-7b|mistral-nemo|open-mistral/, () => 50],
  [/gemma-?(\d+)/, (m, id) => {
    const b = sizeB(id);
    let s = num(m[1]) >= 4 ? 72 : num(m[1]) >= 3 ? 64 : 55;
    if (b && b < 10) s -= 10;
    return s;
  }],
  [/command-a|command-r\+/, () => 76],
  [/north/, () => 72],
  [/phi-?4/, () => 62],
  [/hermes/, () => 68],
];

export function scoreOf(lid) {
  for (const [re, fn] of RULES) {
    const m = lid.match(re);
    if (!m) continue;
    const s = fn(m, lid);
    if (s != null) return Math.max(20, Math.min(98, Math.round(s)));
  }
  const b = sizeB(lid);
  return b ? Math.min(80, Math.round(30 + 7 * Math.log2(b))) : 55;
}

// Read a price from the many shapes providers use. Returns null when the list says nothing about price.
const priceNum = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export function priceOf(x) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.is_free === 'boolean') return { free: x.is_free };
  const pr = x.pricing && typeof x.pricing === 'object' ? x.pricing : null;
  const cost = x.cost && typeof x.cost === 'object' ? x.cost : null;
  const tx = cost && cost.text && typeof cost.text === 'object' ? cost.text : null;
  const pick = (o, f) => (o && typeof o === 'object' && o[f] && typeof o[f] === 'object' ? o[f].price : o && o[f]);
  const pairs = [
    pr && [pr.prompt, pr.completion],
    pr && [pr.input, pr.output],
    pr && [pr.input_cost_per_token, pr.output_cost_per_token],
    tx && [pick(tx, 'input'), pick(tx, 'output')],
    cost && [pick(cost, 'input'), pick(cost, 'output')],
    [x.min_prompt_price, x.min_completion_price],
    [x.prompt_price, x.completion_price],
    [x.input_cost_per_token, x.output_cost_per_token],
    [x.input_price, x.output_price],
  ];
  for (const pair of pairs) {
    if (!pair) continue;
    const vals = pair.map(priceNum).filter((v) => v !== null);
    if (!vals.length) continue;
    // A negative price means "varies", which is not free.
    return { free: vals.every((v) => v === 0) };
  }
  return null;
}

const NOT_CHAT_TYPES = /^(decision|embedding|embeddings|image|images|audio|tts|stt|speech|transcription|rerank|moderation|video)$/;

// Turn one entry of a provider's /models list into a catalog record.
// trustBilling: true for built-in providers whose key makes every model free (Groq, Gemini and so on).
// For any other provider a reported price always wins over the billing setting.
export function analyze(raw, billing, trustBilling) {
  const x = raw && typeof raw === 'object' ? raw : {};
  const id = String(typeof raw === 'string' ? raw : x.id || x.name || '').replace(/^models\//, '');
  const lid = id.toLowerCase();
  const label = String(x.name || x.display_name || '').toLowerCase();
  const arch = x.architecture || {};
  const mods = x.modalities && typeof x.modalities === 'object' ? x.modalities : {};
  const inMods = (Array.isArray(arch.input_modalities) ? arch.input_modalities : Array.isArray(x.input_modalities) ? x.input_modalities : Array.isArray(mods.input) ? mods.input : []).map(String);
  const outMods = (Array.isArray(arch.output_modalities) ? arch.output_modalities : Array.isArray(x.output_modalities) ? x.output_modalities : Array.isArray(mods.output) ? mods.output : []).map(String);
  const params = Array.isArray(x.supported_parameters) ? x.supported_parameters : null;
  const api = x.api && typeof x.api === 'object' ? Object.keys(x.api) : null;
  const ends = Array.isArray(x.supported_endpoint_types) ? x.supported_endpoint_types : null;
  const typeOk = !(typeof x.type === 'string' && NOT_CHAT_TYPES.test(x.type.toLowerCase()));
  const chatApi = !(api && api.length && !api.includes('chat-completions')) && !(ends && ends.length && !ends.includes('openai'));
  // A model that may write 0 tokens (speech, image, embedding endpoints) is not a chat model.
  const noOutput = x.max_completion_tokens === 0;
  const chat = !!id && !SKIP.test(lid) && typeOk && chatApi && !noOutput && !(outMods.length && !outMods.some((m) => m === 'text'));
  const hasImg = inMods.some((m) => m === 'image' || m.indexOf('image/') === 0);
  const hasVid = inMods.some((m) => m === 'video' || m.indexOf('video/') === 0);
  const feats = (x.model_parameters && x.model_parameters.features) || {};
  const vision = hasImg || x.supports_vision === true || feats.vision === true || (!inMods.length && x.supports_vision == null && feats.vision == null && /vision|-vl\b|-vl-|vl-|llava|pixtral|gemini|gpt-4o|gpt-5|llama-?4|maverick|scout|gemma-?[34]|kimi[^/]*k3|omni|claude/.test(lid));
  const video = hasVid || (!inMods.length && /gemini|omni/.test(lid));
  const capT = x.capabilities && x.capabilities.tools;
  const tools = params ? params.includes('tools') : typeof x.supports_function_calling === 'boolean' ? x.supports_function_calling : capT && typeof capT.supported === 'boolean' ? capT.supported : typeof feats.tools === 'boolean' ? feats.tools : null;
  const lim = x.limit && typeof x.limit === 'object' ? x.limit : {};
  const ctx = Number(x.context_length || x.context_window || lim.context || (x.top_provider && x.top_provider.context_length)) || null;
  const price = priceOf(x);
  const tagged = /(:|-|_)free$/.test(lid) || /\bfree\b/.test(label);
  let free;
  if (billing === 'paid') free = false;
  else if (billing === 'free' && trustBilling) free = true;
  else if (price) free = price.free;
  else if (tagged) free = true;
  else free = billing === 'free';
  const score = scoreOf(lid);
  const coder = CODER.test(lid);
  const cats = [];
  if (chat) {
    cats.push('general');
    const thinks = /r1\b|-r1|reason|think|qwq|magistral|kimi|glm-[5-9]|deepseek|qwen3\.[5-9]|nemotron[^/]*ultra|grok-[4-9]|gemini-[3-9]|gemini-2\.5-pro|claude|gpt-5|minimax/.test(lid) || (params && params.includes('reasoning'));
    if (thinks || score >= 84) cats.push('reasoning');
    if (coder || score >= 78) cats.push('coding');
    if (vision) cats.push('vision');
    if (video) cats.push('video');
    if (ctx && ctx >= 200000) cats.push('long-context');
  }
  return { id, chat, free, priced: !!price, ctx, tools, score, coder, cats };
}

// Score used to order models for one task.
export function taskScore(m, task, needTools) {
  let s = m.score;
  if (task === 'coding' && m.coder) s += 5;
  if (task === 'reasoning' && /r1|reason|think|qwq|magistral/.test(m.id.toLowerCase())) s += 2;
  if (needTools && m.tools === true) s += 2;
  return s;
}

// What kind of task a chat request is, from the latest user message.
const CODE_RE = /\x60{3}|\b(def|function|class|const|let|import|return|async)\b[^\n]*[({=]|Traceback|Exception:|Error:|\.(js|ts|tsx|jsx|py|go|rs|sol|java|kt|cpp|cs|php|rb|sql|sh|ya?ml|toml)\b/;
const CODE_WORDS = /\b(code|coding|bug|debug|refactor|compile|stack ?trace|unit tests?|tests? fail\w*|regex|sql|api|endpoint|repo|repository|pull request|commit|git|npm|pip|docker\w*|script|function|frontend|backend|website|landing page|component|typescript|python|javascript|solidity|smart contract|build (an?|the|my) (app|site|tool|bot|extension))\b/;
const REASON_WORDS = /\b(plan|strategy|analy[sz]e|analysis|compare|comparison|trade-?offs?|step[- ]by[- ]step|reason|prove|architecture|design an?|evaluate|research|investigate|why|pros and cons|decide|decision|optimi[sz]e|audit|security|vulnerab\w*|calculate|math|forecast|backtest|hypothes\w*)\b/;

export function detectTask(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let img = false;
  let vid = false;
  let chars = 0;
  let lastUser = '';
  for (const m of msgs) {
    const c = m && m.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p) continue;
        const t = String(p.type || '');
        if (/image/.test(t)) img = true;
        if (/video/.test(t) || (p.file && /video/.test(String(p.file.mime_type || p.file.filename || '')))) vid = true;
        if (typeof p.text === 'string') text += (text ? ' ' : '') + p.text;
      }
    }
    chars += text.length;
    if (m && m.role === 'user') lastUser = text;
  }
  const tokens = Math.ceil(chars / 4);
  const needTools = Array.isArray(body.tools) && body.tools.length > 0;
  const low = lastUser.toLowerCase();
  let task = 'general';
  if (vid) task = 'video';
  else if (img) task = 'vision';
  else if (tokens > 100000) task = 'long-context';
  else if (CODE_RE.test(lastUser) || CODE_WORDS.test(low)) task = 'coding';
  else if (REASON_WORDS.test(low) || low.length > 1200) task = 'reasoning';
  return { task, tokens, needTools };
}
