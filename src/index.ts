#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer, SERVER_NAME, SERVER_VERSION, type ServerConfig } from './server.js';
import { FormServer } from './elicit/webform.js';
import { log } from './log.js';

interface HttpOptions {
  port: number;
  authToken?: string;
  pathSecret?: string;
}

interface Cli {
  transport: 'stdio' | 'http';
  http: HttpOptions;
  config: ServerConfig;
}

function parseArgs(argv: string[]): Cli {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${v}".`);
    return n;
  };

  const CHANNELS = ['elicitation-form', 'elicitation-url', 'browser', 'conversational'];
  const forceRaw = get('--force-channel') ?? process.env.WEATHER_FORCE_CHANNEL;
  if (forceRaw && !CHANNELS.includes(forceRaw)) {
    throw new Error(`--force-channel must be one of ${CHANNELS.join(', ')} (got "${forceRaw}").`);
  }

  const http = argv.includes('--http');
  const fallbackRaw = get('--fallback') ?? process.env.WEATHER_FALLBACK;
  if (fallbackRaw && !['browser', 'conversational'].includes(fallbackRaw)) {
    throw new Error(`--fallback must be browser or conversational (got "${fallbackRaw}").`);
  }
  // A local stdio server can open the user's own browser. A hosted one cannot,
  // so it defers to the model instead of handing out a link nobody will click.
  const fallback = (fallbackRaw ?? (http ? 'conversational' : 'browser')) as ServerConfig['fallback'];

  return {
    transport: http ? 'http' : 'stdio',
    http: {
      // PORT is what most hosting platforms inject.
      port: num(get('--port') ?? process.env.WEATHER_HTTP_PORT ?? process.env.PORT, 3000),
      authToken: get('--auth-token') ?? process.env.WEATHER_AUTH_TOKEN,
      pathSecret: get('--path-secret') ?? process.env.WEATHER_PATH_SECRET,
    },
    config: {
      defaultTimeoutMs: num(get('--timeout') ?? process.env.WEATHER_TIMEOUT_SECONDS, 300) * 1000,
      formHost: get('--form-host') ?? process.env.WEATHER_FORM_HOST ?? '127.0.0.1',
      formPort: num(get('--form-port') ?? process.env.WEATHER_FORM_PORT, 0),
      publicBaseUrl: get('--public-url') ?? process.env.WEATHER_PUBLIC_URL,
      fallback,
      forceChannel: forceRaw as ServerConfig['forceChannel'],
      launchBrowser: !argv.includes('--no-launch') && process.env.WEATHER_NO_LAUNCH !== '1',
      citiesFile: get('--cities') ?? process.env.WEATHER_CITIES_FILE,
    },
  };
}

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

A weather MCP server that demonstrates elicitation: when the city or temperature
unit is missing, it asks the user through the client's own UI.

Usage:
  mcp-weather [options]              Run over stdio (Claude Code, Claude Desktop, VS Code Copilot)
  mcp-weather --http [options]       Run over Streamable HTTP (ChatGPT, Copilot Studio, remote)

Options:
  --http                    Serve over HTTP instead of stdio.
  --port <n>                HTTP port. Default 3000 (or $PORT).
  --auth-token <t>          Require "Authorization: Bearer <t>" on the MCP endpoint.
  --path-secret <s>         Serve MCP at /mcp/<s> instead of /mcp, for connector
                            UIs that cannot send a header. Weaker than a token.
  --timeout <seconds>       Default wait for a human answer. Default 300.
  --fallback <mode>         What to do when the client cannot elicit:
                              browser        serve a local form and open it
                              conversational let the model ask in chat
                            Default: browser for stdio, conversational for --http.
  --cities <file.json>      Replace the built-in city list with a JSON array of
                            { id, label, country } objects.
  --form-host <host>        Interface for the fallback form server. Default 127.0.0.1.
  --form-port <n>           Port for the fallback form server. Default 0 (ephemeral).
  --public-url <url>        Externally reachable base URL for fallback form links.
                            Required when the server is not on the user's machine.
  --no-launch               Do not auto-open a browser for fallback prompts; just
                            return the URL. Use on headless or remote hosts.
  --force-channel <c>       Force elicitation-form | elicitation-url | browser |
                            conversational. Testing aid.
  -h, --help                Show this message.

Every option also reads from an env var: WEATHER_TIMEOUT_SECONDS, WEATHER_FORM_HOST,
WEATHER_FORM_PORT, WEATHER_PUBLIC_URL, WEATHER_FORCE_CHANNEL, WEATHER_HTTP_PORT,
WEATHER_NO_LAUNCH=1, WEATHER_AUTH_TOKEN, WEATHER_PATH_SECRET, WEATHER_FALLBACK,
WEATHER_CITIES_FILE.`;

async function runStdio(config: ServerConfig): Promise<void> {
  const { server, dispose } = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('listening on stdio');

  const shutdown = async () => {
    await dispose();
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runHttp(config: ServerConfig, opts: HttpOptions): Promise<void> {
  const { port, authToken, pathSecret } = opts;
  const app = express();
  app.disable('x-powered-by');

  const publicBaseUrl = config.publicBaseUrl ?? `http://127.0.0.1:${port}`;

  // Hosted deployments usually expose exactly one port, so the fallback form is
  // served from this same app rather than a second listener. One shared instance
  // across sessions, owned here rather than by any single session.
  const formServer = new FormServer({ publicBaseUrl, attached: true });

  // Mounted before the JSON body parser: these submissions are form-encoded and
  // the form server reads the raw stream itself.
  app.all(/^\/p\//, (req, res) => formServer.handleRequest(req, res));

  app.use(express.json({ limit: '4mb' }));

  // One server + transport per MCP session. Elicitation is a server-initiated
  // request, so each session needs its own live connection to answer on.
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; dispose: () => Promise<void> }
  >();

  /** Constant-time bearer check, skipped entirely when no token is configured. */
  const authorized = (req: express.Request): boolean => {
    if (!authToken) return true;
    const header = req.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(authToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // A URL-embedded secret is the only option for connector UIs that do not let
  // you set a header. Weaker than a bearer token - URLs leak into logs and
  // history - so it is opt-in and never the default.
  const mcpPath = pathSecret ? `/mcp/${pathSecret}` : '/mcp';

  app.use(mcpPath, (req, res, next) => {
    if (!authorized(req)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
    next();
  });

  app.post(mcpPath, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unknown session' },
            id: null,
          });
          return;
        }
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Missing mcp-session-id header' },
          id: null,
        });
        return;
      }

      const { server, dispose } = buildServer(config, formServer);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, dispose });
          log(`session opened: ${id}`);
        },
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.delete(id)) log(`session closed: ${id}`);
        void dispose();
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`POST /mcp failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET opens the SSE stream that carries elicitation requests back to the
  // client; DELETE ends the session.
  const bySession = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).send('Unknown session');
      return;
    }
    await entry.transport.handleRequest(req, res);
  };

  app.get(mcpPath, bySession);
  app.delete(mcpPath, bySession);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, sessions: sessions.size });
  });

  const httpServer = app.listen(port, () => {
    log(`listening on port ${port}, MCP endpoint ${mcpPath}`);
    log(`prompt links will be issued under ${publicBaseUrl}/p/...`);
    if (!config.publicBaseUrl) {
      log('note: --public-url is unset, so fallback links point at localhost.');
      log('      Set it to your public HTTPS origin before exposing this server.');
    }
    if (!authToken && !pathSecret) {
      log('WARNING: no --auth-token or --path-secret set. Anyone who can reach this');
      log('         port can open a session. Do not expose it publicly like this.');
    }
  });

  const shutdown = async () => {
    for (const { transport, dispose } of sessions.values()) {
      await dispose();
      await transport.close().catch(() => {});
    }
    await formServer.close();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const cli = parseArgs(argv);
  if (cli.transport === 'http') await runHttp(cli.config, cli.http);
  else await runStdio(cli.config);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
