# Hosting the weather MCP server as a connector

## Read this first: what you actually get

Deploying remotely does **not** give you the native selection popup on most remote
clients — see [README §15](README.md#15-client-compatibility--limitations) for the full
matrix. Remote connectors are the weakest surface for elicitation:

- **Claude Messages API** is documented as tool-calls-only.
- **Claude.ai custom connectors** make no elicitation promise; still an
  [open request](https://github.com/anthropics/claude-ai-mcp/issues/153).
- **Copilot Studio** supports tools and resources only — no elicitation, no workaround.
- **ChatGPT developer mode** references elicitation in the Apps SDK docs; verify it.

On those clients `get_weather` returns `status: "input_required"` and the model asks
"Which city?" in chat, then calls the tool again. The flow completes correctly — you just
don't get a dropdown. That is why `--fallback conversational` is the default for `--http`.

Don't take this on faith. Deploy, then call **`client_capabilities`**. It reports the
client's actual negotiated capabilities, which beats any documentation including this file.

## Choosing a path

| You want | Use |
|---|---|
| The native selection popup | **Option A** (tunnel) or **B** (persistent host) |
| Always-on, cheapest, no popup needed | **Option C** (serverless) |
| Targeting Claude.ai or Copilot Studio | **Option C** — they cannot show a popup regardless |

## Option A — Tunnel from your own machine (best UX, recommended first)

If you want a real selection UI, a tunnel is the better bet. The server runs on your
machine, so `--fallback browser` can open the form **on your own desktop** instead of
deferring to a chat question. The cloud connector still reaches it over public HTTPS.

```bash
npm run build
node dist/index.js --http --fallback browser --port 3000 --path-secret "$(openssl rand -hex 16)"

# in another terminal
cloudflared tunnel --url http://localhost:3000
```

Take the `https://<random>.trycloudflare.com` URL it prints, then restart the server with
it so prompt links resolve:

```bash
node dist/index.js --http --port 3000 \
  --public-url https://<random>.trycloudflare.com \
  --path-secret <the same secret>
```

Register `https://<random>.trycloudflare.com/mcp/<secret>` as the connector URL.

Trade-off: only works while your machine and the tunnel are up. Free Cloudflare quick
tunnels also get a new hostname on every restart — use a named tunnel for a stable one.
ChatGPT additionally offers a **Secure MCP Tunnel** for exactly this case, which avoids
exposing the server publicly at all.

## Option B — Host it (always on)

Pick a platform that keeps a **process alive** and tolerates **long-lived connections**.
Two hard requirements come out of the design:

- A tool call can block until a human answers (up to `--timeout`, default 300 s) whenever
  elicitation or the browser fallback is in play. Anything with a short request ceiling
  will cut prompts off mid-answer.
- Sessions and pending prompts live **in memory**. Run exactly **one instance**. Two
  replicas behind a round-robin load balancer will break sessions.

| Platform | Verdict |
|---|---|
| **Fly.io** | Best fit. Persistent VMs, long connections, free HTTPS, ~$2–5/mo. `fly.toml` is in this repo. |
| **Railway** | Also good. Push the repo, set env vars, done. |
| **Render** | Fine on a paid instance. The free tier sleeps when idle and drops sessions. |
| **VPS + Caddy** | Full control, ~€4/mo. Caddy gets you TLS in two lines. |
| **Netlify / Vercel / Cloudflare / Deno Deploy** | Works, but **stateless only** — no elicitation, no popup. See Option C. |

### Deploy to Fly

```bash
fly launch --no-deploy          # keeps the fly.toml in this repo
fly secrets set WEATHER_AUTH_TOKEN="$(openssl rand -hex 32)"
# match the app's real hostname:
fly secrets set WEATHER_PUBLIC_URL="https://<your-app>.fly.dev"
fly deploy
curl https://<your-app>.fly.dev/health
```

### Any Docker host

```bash
docker build -t mcp-weather .
docker run -p 3000:3000 \
  -e WEATHER_PUBLIC_URL=https://your.domain \
  -e WEATHER_AUTH_TOKEN=$(openssl rand -hex 32) \
  mcp-weather
```

`WEATHER_PUBLIC_URL` **must** match the origin users reach you on. It's the base for
every fallback prompt link; get it wrong and those links 404.

## Option C — Serverless (Netlify, Vercel, Cloudflare, Deno Deploy)

Serverless works, with one honest caveat: **you give up the interactive popup entirely.**

A serverless platform does not keep a process alive between requests, which removes
both things elicitation depends on:

- **MCP sessions** have nowhere to live.
- **Elicitation** needs a live stream to send `elicitation/create` on, and the user's
  reply would land on a different function instance with no memory of the question.

Netlify caps functions at [30 s (60 s streaming)](https://docs.netlify.com/build/functions/api/)
anyway, so a call that waits up to 300 s for a human could never finish.

So the serverless build runs **stateless and conversational-only**: every tool call is a
short request/response that returns either the weather or `status: "input_required"`,
which the model turns into a chat question. It completes in milliseconds.

**This is the same experience Claude.ai connectors and Copilot Studio give you anyway**,
since neither supports elicitation. If those are your targets, serverless costs you
nothing. If you want the native dialog, you need Option A or B.

### Deploy to Netlify

Everything is in the repo: [netlify.toml](netlify.toml) and
[netlify/functions/mcp.mts](netlify/functions/mcp.mts).

```bash
npm i -g netlify-cli
netlify login
netlify init                     # link or create a site
netlify env:set WEATHER_PATH_SECRET "$(openssl rand -hex 16)"
netlify deploy --build --prod
```

Then check it and register the URL with your client:

```bash
curl https://<your-site>.netlify.app/health
# -> {"ok":true,"mode":"serverless-stateless",...}
```

MCP endpoint: `https://<your-site>.netlify.app/mcp/<secret>`

Netlify gives you HTTPS and a stable hostname free, which is all a connector needs.

### Vercel

[api/mcp.ts](api/mcp.ts) is the entry point; it exports the same fetch handler.

```bash
vercel env add WEATHER_PATH_SECRET
vercel --prod
```

### Cloudflare Workers / Deno Deploy

`createFetchHandler()` returns a plain `(Request) => Promise<Response>`, so it drops
straight in:

```ts
import { createFetchHandler } from './dist/serverless.js';
const handler = createFetchHandler({ pathSecret: MY_SECRET });
export default { fetch: handler };          // Workers
// Deno.serve(handler);                     // Deno Deploy
```

### What you cannot do serverless

- No native selection dialog, on any client.
- No local browser form (`--fallback browser` is ignored; there is no port and no
  browser on the host).
- No MCP sessions, so no server-initiated requests of any kind.
- `client_capabilities` will always report `channel: "conversational"`.

## Locking it down

An MCP endpoint on the public internet with no auth lets anyone open a session and make
prompts appear. Choose one:

**Bearer token** — stronger, and what the Claude Messages API sends in its
`authorization_token` field:

```bash
node dist/index.js --http --auth-token "$(openssl rand -hex 32)"
```

**URL path secret** — for connector UIs that won't let you set a header. The endpoint
moves to `/mcp/<secret>` and plain `/mcp` stops existing:

```bash
node dist/index.js --http --path-secret "$(openssl rand -hex 16)"
```

A secret in a URL is genuinely weaker — URLs land in proxy logs, browser history and
referrer headers — so prefer the token when the client lets you send one. `/health` stays
open either way so platform probes keep working.

Both are shared secrets, not per-user OAuth. If several people use the connector you get
no per-user identity or audit trail; for that you'd need a real OAuth 2.1 authorization
server, which this project does not implement.

## Registering the connector

**ChatGPT** — Settings → Connectors → Advanced → Developer mode, then add your
`https://…/mcp` (or `/mcp/<secret>`) URL. Requires HTTPS and Streamable HTTP; both are
satisfied by `--http` behind TLS.

**Copilot Studio** — add an MCP tool pointing at the same URL; each tool becomes an agent
action. Elicitation is not supported there, so run with `--fallback conversational`.

**Claude.ai** — Settings → Connectors → Add custom connector, same URL. Available on
Free through Enterprise (Free is limited to one connector). Claude connects from
Anthropic's cloud, so the URL must be reachable from the public internet — if you're
behind a firewall you'll need to allowlist their egress IPs.

**Claude Messages API** — pass it directly, with the bearer token:

```json
{
  "mcp_servers": [
    { "type": "url", "url": "https://your.domain/mcp", "name": "weather",
      "authorization_token": "YOUR_TOKEN" }
  ],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "weather" }]
}
```

Needs the `mcp-client-2025-11-20` beta header. Note this surface is tool-calls-only, so
prompts will always come back as links.

## After deploying

Call `client_capabilities` from the connected client. It prints the client name and
whether elicitation was negotiated, so you know which tier you're actually on instead of
guessing:

```
Client: claude-ai 1.0.0
Elicitation - form: no, url: no
Prompts will use: conversational
No interactive UI. get_weather returns status "input_required" and the model asks in chat.
```

Then ask "What's today's weather?" and confirm the round trip completes.
