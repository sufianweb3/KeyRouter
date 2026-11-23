// KeyRouter on Cloudflare Workers: OpenAI-compatible LLM router + dashboard.
//   /            dashboard (admin key required to load any data)
//   /v1/...      router for agents (agent key required)
//   /admin/...   dashboard API (admin key required, same-origin only)
// All state lives in one Durable Object (the KeyRouter class).
import { KeyRouter } from './router.js';
import { handle } from './http.js';
import HTML from './ui/index.html';
import APP from './ui/app.txt';

export { KeyRouter };

export default {
  async fetch(request, env) {
    return handle(request, { html: HTML, app: APP }, (req) => env.ROUTER.get(env.ROUTER.idFromName('global')).fetch(req));
  },
};
