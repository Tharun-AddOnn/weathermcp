# MCP Interactive Weather POC

An MCP server that demonstrates **elicitation** — how a server can pause mid-tool-call, ask the
user for missing information through the AI client's *own* UI, and then execute with what it
learned.

The weather tool is the excuse. The point is the interaction pattern.

---

## 1. Project Overview

Ask an AI client *"What's today's weather?"* with this server connected and the flow is:

```
User: What's today's weather?
   ↓
Model calls get_weather()  — with no arguments, deliberately
   ↓
Server elicits:  Select a city
                 ○ Hyderabad  ○ Bengaluru  ○ Mumbai
                 ○ Delhi      ○ Chennai    ○ London      [Continue]
   ↓
Server elicits:  Select temperature unit
                 ○ Celsius (°C)   ○ Fahrenheit (°F)      [Continue]
   ↓
get_weather(city="hyderabad", temperatureUnit="C")
   ↓
Model: Today's weather in Hyderabad: 29°C, Partly cloudy.
```

`city` and `temperatureUnit` are **optional** in the tool schema. That's what lets the model call
the tool without them and hand the questions to the server instead of guessing.

The server asks only for what's actually missing. Say *"weather in Mumbai"* and you get one prompt,
not two. Say *"weather in Mumbai in Fahrenheit"* and you get none.

### What this POC is really demonstrating

| Concern | Where it lives |
|---|---|
| MCP server creation | [src/server.ts](src/server.ts) |
| Tool definition + input schema | [src/tools/getWeather.ts](src/tools/getWeather.ts) |
| Required vs optional parameters | both params optional → triggers elicitation |
| Structured user input (elicitation) | [src/elicit/ask.ts](src/elicit/ask.ts) |
| Structured choices / enums | city + unit as `enum` with display labels |
| Transport configuration | [src/index.ts](src/index.ts) — stdio and Streamable HTTP |
| Error handling & validation | two layers, see §10 |
| Logging | [src/log.ts](src/log.ts) — stderr + MCP `notifications/message` |
| Client compatibility | four-tier fallback, see §15 |

---

## 2. Architecture

```
AI client (Claude / ChatGPT / Copilot)
        │  MCP over stdio or Streamable HTTP
        ▼
┌──────────────────────────────────────────────┐
│ MCP layer          src/server.ts, src/tools/ │
│  · tool definitions, schemas, annotations    │
│  · validation and error shaping              │
├──────────────────────────────────────────────┤
│ Elicitation engine src/elicit/               │
│  · picks a channel from client capabilities  │
│  · four-tier fallback (§9)                   │
├──────────────────────────────────────────────┤
│ Weather domain     src/weather/              │
│  · no MCP imports at all                     │
│  · WeatherService interface + mock impl      │
└──────────────────────────────────────────────┘
```

The three layers don't leak into each other. `src/weather/` has no MCP dependency, so swapping the
mock for a real API is a single-file change with no effect on the tool schema or the elicitation
flow. The elicitation engine knows nothing about weather.

---

## 3. Prerequisites

- **Node.js 18+** (developed on 22)
- npm
- For remote clients (ChatGPT, Copilot Studio): a public **HTTPS** URL — a tunnel or a host

No API keys. The weather data is mocked.

---

## 4. Installation

```bash
npm install
npm run build
npm test          # 46 tests
```

---

## 5. Project Structure

```
src/
  index.ts               CLI, stdio + Streamable HTTP transports, sessions, auth
  serverless.ts          stateless fetch handler for Netlify/Vercel/Workers/Deno
  server.ts              assembles the MCP server and registers tools
  log.ts                 stderr logging + MCP notifications/message

  tools/
    getWeather.ts        the headline tool: validate → elicit what's missing → execute
    support.ts           list_cities, client_capabilities

  elicit/                reusable, weather-agnostic
    ask.ts               channel selection and the four-tier fallback
    fields.ts            field spec → elicitation JSON Schema; coercion + validation
    webform.ts           local form server, single-use tokens, timeouts
    html.ts              themed form rendering with escaping

  weather/               no MCP imports — swap this for a real API
    cities.ts            extensible city registry
    units.ts             unit parsing + Celsius/Fahrenheit conversion
    service.ts           WeatherService interface + MockWeatherService

test/
  weather.test.mjs       domain: registry, conversion, fixtures, errors
  flow.test.mjs          the elicitation flow through a real MCP client
  webform.test.mjs       fallback form: rendering, validation, auth, XSS
  stdio.test.mjs         the built binary as a subprocess + stdout hygiene
  http.test.mjs          hosted shape: shared port, bearer token, path secret
  serverless.test.mjs    stateless fetch handler, cold instances, auth

netlify/functions/mcp.mts   Netlify entry point
api/mcp.ts                  Vercel entry point
```

---

## 6. Running Locally

```bash
npm run dev                      # stdio, no build step (tsx)
node dist/index.js               # stdio, built
node dist/index.js --http        # Streamable HTTP on :3000
node dist/index.js --help
```

Inspect it interactively with the official tool — the fastest way to see elicitation working:

```bash
npm run inspect
```

### Options

Every flag has an environment-variable equivalent; see [.env.example](.env.example).

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--http` | — | off | Streamable HTTP instead of stdio |
| `--port <n>` | `WEATHER_HTTP_PORT` / `PORT` | `3000` | HTTP port |
| `--timeout <sec>` | `WEATHER_TIMEOUT_SECONDS` | `300` | Wait for a human answer |
| `--fallback <mode>` | `WEATHER_FALLBACK` | browser (stdio) / conversational (http) | What to do with no elicitation |
| `--cities <file>` | `WEATHER_CITIES_FILE` | built-in six | JSON array of `{id,label,country}` |
| `--public-url <url>` | `WEATHER_PUBLIC_URL` | — | Public origin for fallback form links |
| `--no-launch` | `WEATHER_NO_LAUNCH=1` | off | Never auto-open a browser |
| `--auth-token <t>` | `WEATHER_AUTH_TOKEN` | — | Require `Authorization: Bearer <t>` |
| `--path-secret <s>` | `WEATHER_PATH_SECRET` | — | Serve MCP at `/mcp/<s>` |
| `--force-channel <c>` | `WEATHER_FORCE_CHANNEL` | — | Pin a channel; testing aid |

---

## 7. MCP Configuration

**Claude Code**

```bash
claude mcp add weather -- node /absolute/path/to/dist/index.js
```

**Claude Desktop** — `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "weather": { "command": "node", "args": ["/absolute/path/to/dist/index.js"] }
  }
}
```

**VS Code Copilot** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "weather": { "type": "stdio", "command": "node", "args": ["/absolute/path/to/dist/index.js"] }
  }
}
```

On Windows use forward slashes or escape backslashes (`C:\\Users\\...`).

---

## 8. Tool Description

### `get_weather`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `city` | string | **no** | One of the supported city ids. Omit to be asked. |
| `temperatureUnit` | `"C"` \| `"F"` | **no** | Enum in the schema. Omit to be asked. |

Returns `structuredContent`:

```json
{
  "status": "ok",
  "city": "Hyderabad",
  "temperature": 29,
  "unit": "C",
  "condition": "Partly cloudy",
  "observedAt": "2026-08-30T09:15:00.000Z",
  "channel": "elicitation-form"
}
```

`status` is one of:

- **`ok`** — weather retrieved
- **`input_required`** — the client can't show a UI; `missing`, `availableCities` and
  `availableUnits` tell the model what to ask in chat
- **`cancelled`** — the user declined or dismissed the prompt

`channel` reports which mechanism was used to ask, which is invaluable when debugging a client.

### `list_cities`

Returns the supported cities and units. Lets a model phrase its own question in clients that can't
render a selection list.

### `client_capabilities`

Diagnostic. Reports the connected client, whether it negotiated elicitation, and which channel
prompts will use. **Prompts nobody** — call it first when setting up a new client.

---

## 9. Elicitation / Interactive Input

MCP elicitation (added in the June 2025 spec revision) lets a server send `elicitation/create` and
have the *client* render the UI. That's why the popup looks native — Claude draws a Claude dialog,
VS Code draws a VS Code dialog.

The schema it accepts is restricted: **a flat object of primitives**. No nesting, no arrays of
objects. Single-select is an `enum` with parallel `enumNames` for display labels. This server
rejects an unrenderable field spec with a clear error rather than degrading silently.

Not every client implements it, so there are four tiers, chosen from the capabilities the client
declares at initialize time:

| Tier | Condition | What the user sees |
|---|---|---|
| 1. `elicitation-form` | client declares `elicitation.form` | **Native selection dialog in the client** |
| 2. `elicitation-url` | client declares `elicitation.url` | Client hands over a link to a form |
| 3. `browser` | no elicitation, `--fallback browser` | Local browser page, opened automatically |
| 4. `conversational` | no elicitation, `--fallback conversational` | Model asks in chat, then re-calls the tool |

Tier 4 is the universal one — it uses nothing but ordinary tool calls, so it works in **every** MCP
client including ones that will never support elicitation. It's the default for `--http`, because a
cloud-hosted server can't usefully open anybody's browser.

> **Server capability vs client capability.** This server always advertises elicitation. Whether a
> popup appears is entirely the client's decision. `client_capabilities` shows you both sides.

---

## 10. Validation and Error Handling

Validation happens at two deliberately different layers:

| Layer | Used for | Why |
|---|---|---|
| **Tool input schema** (protocol) | `temperatureUnit` | Closed set of two → a real `enum`. The SDK rejects anything else before the handler runs, and the model sees the valid values in the schema. |
| **Handler** | `city` | The city list is extensible at runtime, so it can't be a fixed enum. Resolved case-insensitively; unknown cities produce an error naming every valid one. |

| Case | Result |
|---|---|
| Unsupported city | `isError`, message lists all supported cities |
| Unsupported unit | `isError`, protocol-level: `expected one of "C"\|"F"` |
| Missing city / unit | Elicited, or `status: "input_required"` |
| User declines or cancels | `status: "cancelled"`, provider never called |
| Prompt times out | Treated as cancelled — never as consent |
| Weather service failure | `isError`, `Could not retrieve weather: …` |
| Unexpected exception | `isError`, caught and reported, never crashes the server |
| Elicitation transport failure | Falls to the next tier, logged |

Errors are returned as `isError` tool results, not thrown protocol errors, so the model can read
them and recover.

### Logging

Every line goes to **stderr** and, when the client subscribes, to MCP `notifications/message`.
Nothing is ever written to stdout — on the stdio transport stdout carries JSON-RPC, and a single
stray `console.log` corrupts the stream and kills the session. There's a test asserting this.

---

## 11. ChatGPT Integration

**Transport** — remote **Streamable HTTP** over **HTTPS**. ChatGPT does not launch local stdio
servers.

**Expose it:**

```bash
node dist/index.js --http --port 3000 --no-launch \
  --public-url https://<your-host> --path-secret "$(openssl rand -hex 16)"
```

Put it behind a tunnel (`cloudflared tunnel --url http://localhost:3000`) or host it — see
[DEPLOY.md](DEPLOY.md).

**Authentication** — ChatGPT supports OAuth 2.1, no-auth, and mixed. This server implements a
bearer token and a URL path secret, not full OAuth. Since ChatGPT's connector UI won't let you set
an arbitrary header, use `--path-secret` and register the secret-bearing URL.

**Configure** — Settings → Connectors → Advanced → **Developer mode**, then add
`https://<your-host>/mcp/<secret>`.

**Test it** — ask *"What's today's weather?"* and watch for the selection prompt. Then call
`client_capabilities` to see the negotiated channel.

**Elicitation** — the Apps SDK documentation references MCP elicitation, so a native prompt is
plausible, but treat it as unconfirmed until `client_capabilities` says
`clientSupportsElicitationForm: true`. If it doesn't, you get tier 4: ChatGPT asks *"Which city?"*
in chat and re-calls the tool. The flow still completes.

---

## 12. Claude Integration

**Claude Code / Claude Desktop (local, stdio)** — the best experience. Configure as in §7.
Elicitation **is supported in Claude Code**, so you get the real native dialog: a proper selection
list rendered by Claude itself.

**Claude.ai custom connector (remote)** — Settings → Connectors → Add custom connector, pointing at
your HTTPS URL. Available on Free through Enterprise (Free is capped at one connector). Claude
connects from Anthropic's cloud, so the URL must be publicly reachable.

**Elicitation over the remote connector is very likely unavailable.** The Claude
[MCP connector docs](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector) state
plainly: *"Of the feature set of the MCP specification, only tool calls are currently supported."*
That's the Messages API surface; Claude.ai's connector docs make no elicitation promise either, and
it remains an [open request](https://github.com/anthropics/claude-ai-mcp/issues/153).

So expect tier 4 remotely: Claude asks in chat, you answer, it re-calls the tool. Correct results,
no popup.

**Claude Messages API** — pass the server directly:

```json
{
  "mcp_servers": [
    { "type": "url", "url": "https://your-host/mcp", "name": "weather",
      "authorization_token": "YOUR_TOKEN" }
  ],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "weather" }]
}
```

Requires the `mcp-client-2025-11-20` beta header. This is the surface where `--auth-token` fits
exactly — `authorization_token` is sent as a bearer header.

---

## 13. Copilot Integration

**"Copilot" is two different products here, with opposite answers.** This distinction matters more
than any other in this document.

### GitHub Copilot in VS Code — elicitation **supported**

Configure as in §7. VS Code implements MCP elicitation, so you get the **native selection dialog**,
the same tier-1 experience as Claude Code. Use Copilot Chat in **Agent** mode; the tools appear in
the tools picker. VS Code also shows its own confirmation before running any MCP tool, which is
separate from our elicitation prompt.

### Microsoft Copilot Studio — elicitation **not supported**

MCP support reached GA in Copilot Studio in July 2026, and each MCP tool becomes an agent action
inheriting its name, description, inputs and outputs. But **Copilot Studio supports only tools and
resources** — sampling, roots and elicitation are not implemented.

Consequences:

- No popup or dropdown for MCP elicitation. There is no workaround that produces one.
- Structured **tool inputs** work fine — the `temperatureUnit` enum is honoured as an action input.
- The working pattern is **tier 4**: `get_weather` returns `status: "input_required"` with
  `availableCities`, the agent asks in chat, and calls the tool again. Run with
  `--fallback conversational` (the default for `--http`).
- If you need a real selection UI inside Copilot Studio, build it as an **Adaptive Card in a Topic**
  and pass the result to the MCP tool as arguments. That's a Copilot Studio feature, not MCP
  elicitation, and it means maintaining the city list in two places.

**Setup** — expose over HTTPS as in §11, then add it as an MCP tool in Copilot Studio and point it
at your endpoint. Authentication is configured per connection; use `--auth-token` where headers can
be set, otherwise `--path-secret`.

---

## 14. Testing

```bash
npm test
```

46 tests, no network, no API keys. Mapping to the required scenarios:

| # | Scenario | Where |
|---|---|---|
| 1 | Server starts successfully | `stdio.test.mjs`, `http.test.mjs` (health probe) |
| 2 | Client can discover the server | every test connects a real `Client` |
| 3 | Client discovers `get_weather` | `flow.test.mjs` — "discovers get_weather" |
| 4 | Missing info triggers elicitation | "calling with no arguments elicits city then unit" |
| 5 | City selection works | same test — asserts `enum` + `enumNames` |
| 6 | Unit selection works | same test — second prompt |
| 7 | Correct parameters reach the tool | spy `WeatherService` records `{cityId, unit}` |
| 8 | Weather data returned correctly | `weather.test.mjs` — all six fixtures |
| 9 | C→F conversion | `weather.test.mjs` — 29→84.2, 0→32, −40→−40 |
| 10 | Invalid inputs handled | unknown city, invalid unit, provider failure, crash |
| 11 | Refusal is not consent | decline/cancel → provider never called |
| 12 | Universal fallback | `input_required` shape, then a successful re-call |
| + | Serverless, stateless | `serverless.test.mjs` — cold instance lists tools, never blocks |

Also covered: stdout hygiene on stdio, XSS escaping in the fallback form, single-use prompt tokens,
prompt timeout, hosted single-port serving, bearer-token and path-secret auth.

### Manual test

```bash
npm run inspect
```

Call `get_weather` with no arguments. The Inspector supports elicitation, so you'll see the real
selection prompts. Then try `--force-channel conversational` to see the fallback shape.

---

## 15. Client Compatibility / Limitations

Verified against current documentation, August 2026. **Always confirm with `client_capabilities`
rather than trusting this table** — it's the whole reason that tool exists.

| Client | Transport | Elicitation | What you actually get |
|---|---|---|---|
| Claude Code | stdio | ✅ Yes | Native selection dialog |
| VS Code Copilot | stdio | ✅ Yes | Native selection dialog |
| MCP Inspector | both | ✅ Yes | Native selection dialog |
| Claude Desktop | stdio | ⚠️ Check | Dialog, else local browser form |
| ChatGPT dev mode | HTTPS | ⚠️ Likely | Dialog if supported, else chat |
| Claude.ai connector | HTTPS | ❌ Unlikely | Chat question, then re-call |
| Claude Messages API | HTTPS | ❌ No (documented) | Chat question, then re-call |
| Copilot Studio | HTTPS | ❌ No | Chat question, then re-call |

### Four kinds of "supported"

The requirement asked to keep these separate, and they genuinely are:

1. **The MCP protocol** supports elicitation in form and URL modes (June 2025 revision onward).
2. **The TypeScript SDK** implements both — `server.elicitInput()`, capability negotiation, and
   `createElicitationCompletionNotifier` for out-of-band URL completion.
3. **Each client** decides independently whether to implement it. This is where the variation is.
4. **A true popup can only be guaranteed by a custom client.** No server-side trick forces a host
   application to render a dialog it hasn't implemented. That's why tier 4 exists.

### Known limitations

- Elicitation schemas are flat primitives only — no nested objects or object arrays.
- Multi-select labels can't ride along on the array form, so they're folded into the description.
- Single-select uses `enum` + `enumNames` rather than the newer `oneOf: [{const, title}]`, because
  the legacy form is what shipping clients render today. See the comment in `src/elicit/fields.ts`.
- Sessions and pending prompts are **in memory** — run a single instance (see [DEPLOY.md](DEPLOY.md)).
- On serverless (Netlify, Vercel, Workers), elicitation is **impossible**, not merely absent:
  there is no live stream to send a prompt on and no process to hold the session. That build
  is stateless and conversational-only.
- No OAuth 2.1 authorization server; auth is a shared bearer token or URL secret.

---

## 16. Troubleshooting

**No popup appears, the model just asks in chat.** Expected on clients without elicitation. Confirm
with `client_capabilities`; if `clientSupportsElicitationForm` is `false`, the client is the limit,
not the server.

**Client won't start the server.** Use an absolute path to `dist/index.js` and make sure you ran
`npm run build`. Check the client's MCP log panel.

**Session drops immediately on stdio.** Something wrote to stdout. All logging must go to stderr —
`npm test` includes a check for this.

**Fallback form links 404 when hosted.** `--public-url` doesn't match the origin users reach. It's
the base for every prompt link.

**Prompt times out.** Default is 300 s. Raise with `--timeout`. A timeout is reported as cancelled,
never as consent.

**`Unknown city "…"`.** Only the six built-in cities are supported. Extend with `--cities`
(see [cities.example.json](cities.example.json)) and add a matching fixture in
`src/weather/service.ts`.

**Remote client can't connect.** Needs HTTPS and public reachability. Verify with
`curl https://your-host/health`.

---

## 17. Future Improvements

- **Real weather API.** Implement `WeatherService` against Open-Meteo or similar and pass it to
  `buildServer`. Nothing else changes — that's what the interface is for.
- **A single combined form.** Ask for city and unit in one elicitation instead of two. Fewer
  interruptions; two are used here because the spec's flow calls for them.
- **OAuth 2.1** with dynamic client registration, for per-user identity and audit trails.
- **Free-text city search**, once more clients support elicitation string fields well.
- **Redis-backed sessions**, to allow more than one instance.
- **`oneOf`-titled enums**, once client adoption catches up with the current spec.

---

## Deployment

See **[DEPLOY.md](DEPLOY.md)**. Three paths, and the choice decides whether you get a popup:

| You want | Use | Popup? |
|---|---|---|
| Native selection dialog | Tunnel from your machine, or a persistent host (Fly, Railway) | ✅ |
| Always-on and cheapest | Serverless — Netlify, Vercel, Cloudflare, Deno Deploy | ❌ chat question |
| Claude.ai or Copilot Studio | Any — those clients cannot show a popup regardless | ❌ chat question |

Included: [Dockerfile](Dockerfile), [fly.toml](fly.toml), [netlify.toml](netlify.toml),
[netlify/functions/mcp.mts](netlify/functions/mcp.mts), [api/mcp.ts](api/mcp.ts).
