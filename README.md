# KeyRouter

**One API key for all your AI agents, routed across every free and paid LLM provider you have.**

KeyRouter runs on your own Cloudflare or Vercel account (the free plans are enough). You paste your provider keys into a dashboard once. Your agents get one OpenAI-compatible key and URL. KeyRouter picks the best model for each request, uses free models first and switches to another provider the moment one hits a rate limit or runs out of quota.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sufianweb3/KeyRouter)
&nbsp;
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsufianweb3%2FKeyRouter&project-name=keyrouter&repository-name=keyrouter&env=ADMIN_KEY&envDescription=Dashboard%20password%3A%20a%20long%20random%20string%2C%2016%2B%20characters%20%28for%20example%20openssl%20rand%20-hex%2024%29.%20Keep%20it%20in%20your%20password%20manager.&envLink=https%3A%2F%2Fgithub.com%2Fsufianweb3%2FKeyRouter%23deploy-on-vercel&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%5D)

## What you get

| | |
|---|---|
| **Dashboard** | Add providers, see usage, create agent keys, test prompts. Light and dark mode. |
| **Router** | An OpenAI-compatible `/v1` endpoint. Works with any tool that lets you set a base URL. |
| **Free first** | Reads each provider's model list and prices, tests a free model and keeps free and paid apart. Free-only mode never spends money. |
| **Never stuck** | On a 429, a daily quota, no credits or a provider error, the call moves to the next good model. Limits are learned from replies and headers. |
| **Daily capacity** | Shows how many free requests and tokens you have left today across providers. |
| **Free credits** | Track sign-up credit (like 500K free tokens) so those paid models count as free until it is used up. |
| **Keyless providers** | Some providers work with no key at all: one click to turn them on. |
| **Real model scores** | Models are ranked by the public [LMArena](https://arena.ai/leaderboard) leaderboard (blind votes, with separate coding, math and hard-prompt boards) and, once an OpenRouter key is connected, [OpenRouter's benchmarks](https://openrouter.ai/benchmarks) (Artificial Analysis intelligence, coding and agentic indexes). OpenRouter scores are fitted onto the LMArena scale, then the two are averaged. Refreshed every 3 days. Models neither lists get an estimate, marked "Est.", and rank a little lower. |
| **Discover providers** | A Discover page lists free LLM APIs from two directories, [freellm.net](https://freellm.net) and [aifree.dev](https://aifree.dev), checked daily: free model count, rate limits, credits, whether a card is needed, context size, the catch and a link to create an account. Offers aifree.dev flags as risky are marked. **Add** fills in the provider for you. |
| **Automatic setup** | When you add a provider, KeyRouter fills in its rate limits, free models and card policy from the directory. Give it the provider's website or docs and a free model also reads those pages. Both are checked again over time (directory daily, docs weekly) and every change is logged on the provider. Anything you set by hand is never overwritten; turn **Keep updated** off to freeze a provider. |
| **Faster first** | Each model's answer time is tracked. With **Prefer faster models** on, slow models drop a little in the ranking. |
| **Provider health** | The Usage page shows 14 days per provider: share of calls that worked, answer time and call count. |
| **Auto-pause** | A provider that fails every call for 3 days (Settings) is paused and checked again once a day. It turns back on by itself when it works again, or with **Turn back on**. |
| **Alerts** | Telegram or a webhook tells you when a provider keeps failing, gets paused, runs out of credits, an agent key hits its limit or a key is old. Messages never contain key values. |
| **Agent budgets** | Each agent key can have a daily request limit and a daily token limit. |
| **Response cache** | Optional: identical calls from the same agent key within a set number of seconds get the saved answer (`x-router-cache: hit`). Off by default. |
| **Key reminders** | Provider and agent keys older than 90 days (Settings) are marked and listed under **Needs a look** on the Overview. |
| **Backup** | Settings > Backup downloads your providers, routes, agent keys and settings as a file. Provider keys are left out on purpose. Restore merges a file back in and never deletes anything. |
| **Your colors** | Settings > Appearance: pick an accent from presets (Orange, Lime, Blue, Violet, Pink, Teal, Gold), a color wheel or a hex code. Text on the accent stays readable automatically. |
| **Provider logos** | Every provider shows its own logo, also ones you add later. Known brands use the LobeHub icon set; others use the icon from their own website. |

Built-in presets include OpenRouter, Gemini, Groq, Cerebras, NVIDIA, Mistral, GitHub Models, SambaNova, Together, DeepSeek, Cohere, Hugging Face, Ollama Cloud, Chutes, Requesty, AIML API, CrowLLM, Numes, TokenHarbor, Inferbase, Respan, Infron and more (44 in all). Any other OpenAI-compatible provider works by name and base URL. Paste the address with or without `/models` or `/chat/completions` on the end: KeyRouter keeps the part calls are built on.

## Cloudflare or Vercel?

Both run the same router and dashboard. Pick the one you already use. If you use neither, pick Cloudflare.

| | Cloudflare (recommended) | Vercel |
|---|---|---|
| Accounts needed | Cloudflare | Vercel + a free Upstash Redis database, created for you during deploy |
| Your URL | `https://keyrouter.<your-subdomain>.workers.dev` | `https://<project>.vercel.app` |
| Free plan capacity | Plenty for personal use | About 2,000 agent calls a day (Upstash free plan: 500K commands a month) |
| Background checks (model lists, retests) | Run on time | Run on the next request after they are due, plus once a day |
| Rate-limit counting | Exact | Can be slightly off when many calls arrive at the same moment |
| Commercial use on the free plan | Allowed | Vercel's free (Hobby) plan is for personal, non-commercial use |

## Deploy on Cloudflare

**With the button (no terminal needed)**

1. Click **Deploy to Cloudflare** above and sign in to Cloudflare (a free account works).
2. Connect your GitHub account when asked. Cloudflare copies this repo into your account and deploys from there.
3. When it asks for **ADMIN_KEY**, paste a long random password (16+ characters). This is your dashboard password.
   - Make one with `openssl rand -hex 24`, or let your password manager generate one.
   - Save it in your password manager. It is the only way into the dashboard.
4. Press **Deploy**. When it finishes, open the `workers.dev` link it shows.

**From your terminal**

```bash
git clone https://github.com/sufianweb3/KeyRouter.git
cd KeyRouter
./deploy.sh
```

`deploy.sh` logs you in to Cloudflare, deploys and creates a random admin key. The key is printed once and saved to `.admin-key`, which git ignores. Move it to your password manager and delete the file. Running it again later keeps the same key.

Needs Node.js 20+ and a Cloudflare account.

## Deploy on Vercel

1. Click **Deploy with Vercel** above and sign in to Vercel (a free Hobby account works).
2. Connect your GitHub account when asked. Vercel copies this repo into your account.
3. Add the **Upstash** database it offers (free plan). This is where your providers, keys and usage are stored.
4. Set **ADMIN_KEY** to a long random password (16+ characters), for example the output of `openssl rand -hex 24`. Save it in your password manager.
5. Press **Deploy**, then open your project's production URL, `https://<project>.vercel.app`.

Use the **production** URL for the dashboard and your agents. Vercel puts preview deployments behind a Vercel login by default.

**Without the button:** import this repo as a new Vercel project, add **Upstash Redis** under the project's **Storage** tab and connect it, add `ADMIN_KEY` under **Settings > Environment Variables**, then redeploy. KeyRouter reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` if you bring your own Upstash database.

## First setup

1. Open your dashboard URL and unlock it with your admin key.
2. **Providers**: paste an API key. Most providers are detected from the key. For any other provider, type its name and base URL. Add several keys to one provider and they take turns.
3. **Agent keys**: create one key per agent or app, with an optional daily limit.
4. **Playground**: send a test prompt.

Free keys to start with: [Gemini](https://aistudio.google.com/apikey), [Groq](https://console.groq.com/keys), [OpenRouter](https://openrouter.ai/keys), [Cerebras](https://cloud.cerebras.ai) and [Mistral](https://console.mistral.ai/api-keys).

## Connect your agent

| Setting | Value |
|---|---|
| Base URL | your dashboard URL + `/v1`, for example `https://keyrouter.<your-subdomain>.workers.dev/v1` |
| API key | an agent key from the dashboard |
| Model | `auto` |

```bash
curl https://keyrouter.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

### Model names

| Send this as `model` | What happens |
|---|---|
| `auto` | Task detected from the message, best available model for it |
| `coding`, `reasoning`, `general`, `vision`, `video`, `long-context` | That task, no detection |
| `auto:free`, `auto:mixed`, `auto:best` | Change the mode for one call |
| `provider/model` | Exactly that model, for example `groq/llama-3.3-70b-versatile` |
| a custom route name | Your own fixed order, set in the dashboard |

**Modes:** `free` never uses paid models. `mixed` uses paid ones only when every free one is busy. `best` takes the strongest model, free or paid. A daily cap on paid calls applies to `mixed` and `best`.

## Keeping your keys safe

| Key | Where it lives | If it leaks |
|---|---|---|
| **Provider keys** | Only in your own account: Cloudflare's storage, or your Upstash database on Vercel. No API ever sends them back, not even to the dashboard. | Delete the key in the dashboard and revoke it at the provider. |
| **Admin key** | A secret on Cloudflare or an environment variable on Vercel, plus your password manager. | Set a new one (Cloudflare: `npx wrangler secret put ADMIN_KEY`; Vercel: Settings > Environment Variables, then redeploy). |
| **Agent keys** | On the machine your agent runs on. Only a hash is stored. | Turn it off or delete it in the dashboard. Its daily limit caps the damage meanwhile. |

**Rules of thumb**

- Never put your admin key on the machine your agents run on. Agents only need an agent key.
- Never commit `.dev.vars`, `.env` or `.admin-key`. This repo's `.gitignore` already excludes them.
- On Vercel, keep your Upstash database private and mark `ADMIN_KEY` as **Sensitive**.
- Your deployment is yours alone. Nobody else, including the author of this repo, can see your keys or traffic.

**Built in**

- An admin key shorter than 16 characters is refused.
- 10 wrong admin keys from one IP lock that IP out for 10 minutes.
- The dashboard sends a strict Content Security Policy, blocks framing and is never indexed by search engines.
- Optional extra lock on Cloudflare: put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) in front of the dashboard (path `/`), and leave `/v1` open for your agents.

## Update to a new version

- **Deployed with a button:** Cloudflare or Vercel created a copy of this repo in your GitHub. Pull the latest changes from `sufianweb3/KeyRouter` into it, for example with a pull request from this repo. Each push redeploys automatically.
- **Deployed from the terminal:** `git pull && npm run deploy`

Your providers, keys and settings are kept across updates.

## Troubleshooting

| You see | Do this |
|---|---|
| "ADMIN_KEY is not set" | Cloudflare: `npx wrangler secret put ADMIN_KEY`, or Settings > Variables and Secrets. Vercel: Settings > Environment Variables, then redeploy. |
| "No database connected" (Vercel) | Open your project's **Storage** tab, add Upstash Redis (free), connect it to the project, then redeploy. |
| "Too many wrong admin keys" | Wait 10 minutes, then use the right key. |
| A Vercel login page instead of the dashboard | You opened a preview URL. Use the production URL, `https://<project>.vercel.app`. |
| A provider shows **Rate limited** | Nothing to do. KeyRouter retests it when the provider's limit resets. Your calls go to other providers meanwhile. |
| A provider shows **Error** with "Key rejected" | The key is wrong or revoked, or the provider only accepts its own apps (AgentRouter says "unauthorized client"). The provider's own message is shown. |
| A provider shows "No model list at this address (404)" | The base URL is wrong. It usually ends in `/v1`. |
| A provider shows "Blocked by the provider's firewall" | The provider refuses requests from servers. Nothing KeyRouter can change; use another provider. |
| Scores show "Est." everywhere | The LMArena data has not loaded yet. Models page > **Update scores**. |
| No OpenRouter scores | Connect an OpenRouter key (any free key works), then Models page > **Update scores**. |
| Discover is empty | The directories could not be reached. Discover page > **Refresh list**, or try again later. The source line shows which one failed. |
| A provider shows **Paused automatically** | It failed every call for days. Fix the key or base URL, then press **Turn back on**. Change or turn off the wait under Settings > Upkeep. |
| No Telegram alerts | Settings > Alerts: message your bot once first, then use **Send test**. The chat ID is a number (from @userinfobot) or `@channelname`. |
| An agent gets "Daily token budget" | Its key reached **Tokens a day**. Raise it under Agent keys or wait for the next day (UTC). |
| An agent gets an old answer | The response cache is on. Settings > Routing > **Reuse identical answers**: set 0 to turn it off. |
| A model you expected to be free shows as paid | The provider lists a price for it. If you have free credit there, set **Free tokens** under that provider's Settings. |

## How routing handles errors

| Provider answers | KeyRouter does |
|---|---|
| 429 rate limit | Pauses that key and model for the `retry-after` time, then uses the next model |
| 429 daily quota | Parks the key or model until the provider's daily reset |
| 402 or out of credits | Parks the key until the reset |
| 401 or 403 | Pauses the key or model and shows the reason |
| 404 model not found | Pauses that model for an hour |
| 5xx or timeout | Pauses that model briefly |
| 200 that contains an error | Treated as a failure, next model |

When every model is briefly rate limited, the call waits for the first free slot, up to 20 seconds by default (Settings).

## Development

```bash
npm install
npm test                      # router and admin API against mock providers (Cloudflare runtime)
npm run test:vercel           # the same checks on the Vercel version, plus two instances sharing one database
node test/ui-serve.mjs &      # seeded local dashboard on http://127.0.0.1:9800 (admin key: admin-secret-123)
python3 test/ui_check.py      # headless browser walkthrough (needs Playwright)
```

| File | What it is |
|---|---|
| `src/router.js` | The router, admin API and all logic. Same code on both platforms. |
| `src/http.js` | Serves the dashboard and passes API calls to the router |
| `src/index.js` | Cloudflare entry: stores data in a Durable Object |
| `api/index.js`, `src/redis-storage.js` | Vercel entry: stores data in Upstash Redis |
| `src/bench.js` | Reads the LMArena leaderboard and OpenRouter benchmarks and matches model names |
| `src/learn.js` | Reads the provider directories and provider websites or docs for limits and free models |
| `src/extras.js` | Alerts, backup and restore, and the response cache |
| `src/logos.js` | Finds a logo for each provider |
| `src/ui/` | The dashboard |

The tests create their own throwaway admin key and database. No real keys are needed.

Optional settings (Cloudflare vars or Vercel environment variables), mostly for tests:

| Name | Does |
|---|---|
| `BENCH_OFF`, `DIR_OFF`, `LEARN_OFF` | Turn off benchmark loading, the provider directory or docs reading |
| `AIFREE_OFF` | Turn off the aifree.dev directory |
| `BENCH_URL`, `BENCH_OR_URL`, `DIR_URL`, `AIFREE_URL` | Point the LMArena data, OpenRouter benchmarks or a directory at another address |
| `LEARN_LOCAL` | Tests only: lets docs reading reach local addresses |

## License

[MIT](LICENSE)

Model scores come from the [LMArena leaderboard](https://arena.ai/leaderboard) ([dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset)) and [OpenRouter's benchmarks](https://openrouter.ai/benchmarks) (data by Artificial Analysis). Provider directories come from [freellm.net](https://freellm.net) ([awesome-freellm-apis](https://github.com/open-free-llm-api/awesome-freellm-apis)) and [aifree.dev](https://aifree.dev) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); each listing links back to its aifree.dev page). Provider logos come from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT) or the provider's own website, and belong to their owners.
