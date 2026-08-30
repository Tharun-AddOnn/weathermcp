import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer, SERVER_NAME, SERVER_VERSION, type ServerConfig } from './server.js';
import { log } from './log.js';

export interface ServerlessOptions {
  config?: Partial<ServerConfig>;
  /** Require `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Require the request path to end with this secret, for header-less clients. */
  pathSecret?: string;
}

/**
 * Serverless platforms (Netlify, Vercel, Cloudflare Workers, Deno Deploy) cannot
 * hold a connection open across requests, which rules out two things this server
 * does elsewhere:
 *
 *   - MCP sessions, because there is no process to keep them in
 *   - elicitation, because a server->client request needs a live stream, and the
 *     user's reply would arrive at a different function instance
 *
 * So this handler runs **stateless and conversational only**: every call is a
 * short request/response that either returns weather or returns
 * `status: "input_required"` for the model to ask about in chat. That finishes
 * in milliseconds, well inside any platform's function timeout.
 *
 * If you want the native selection dialog, you need a host that keeps a process
 * alive - see DEPLOY.md.
 */
export const SERVERLESS_CONFIG: ServerConfig = {
  defaultTimeoutMs: 0, // never waits on a human
  formHost: '127.0.0.1',
  formPort: 0,
  fallback: 'conversational',
  // Pinned, not merely defaulted: a client that *does* advertise elicitation
  // must still not be prompted, because there is no stream to answer on.
  forceChannel: 'conversational',
  launchBrowser: false,
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function unauthorized(): Response {
  return json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, 401);
}

/** Constant-time compare that does not leak length through early return. */
function secretMatches(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Build a standard `(Request) => Promise<Response>` handler. Every serverless
 * platform above accepts this shape, directly or with a one-line wrapper.
 */
export function createFetchHandler(options: ServerlessOptions = {}): (req: Request) => Promise<Response> {
  const config: ServerConfig = { ...SERVERLESS_CONFIG, ...options.config, ...{
    // These three are not negotiable in a serverless deployment.
    fallback: 'conversational' as const,
    forceChannel: 'conversational' as const,
    launchBrowser: false,
  } };

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/health')) {
      return json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, mode: 'serverless-stateless' }, 200);
    }

    if (options.pathSecret) {
      const last = url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
      if (!secretMatches(last, options.pathSecret)) return unauthorized();
    }

    if (options.authToken) {
      const header = request.headers.get('authorization') ?? '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!secretMatches(supplied, options.authToken)) return unauthorized();
    }

    // A fresh server and transport per request. Stateless mode means no session
    // id is issued and none is expected, so nothing needs to survive the call.
    const { server, dispose } = buildServer(config);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON rather than an SSE stream: there is nothing to stream, and
      // some platforms buffer SSE anyway.
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (err) {
      log(`serverless request failed: ${err instanceof Error ? err.message : String(err)}`);
      return json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, 500);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
      await dispose().catch(() => {});
    }
  };
}
