import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer, SERVER_NAME, SERVER_VERSION, type ServerConfig } from './server.js';
import { log } from './log.js';
import { BlobsTicketStore } from './ticket/blobs.js';
import { handleFormRequest, isFormPath } from './ticket/form.js';
import type { TicketStore } from './ticket/store.js';

export interface ServerlessOptions {
  config?: Partial<ServerConfig>;
  /** Require `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Require the request path to end with this secret, for header-less clients. */
  pathSecret?: string;
  /**
   * Public origin used to build selection links, e.g. https://site.netlify.app.
   * Without it the link-to-form dropdown flow is disabled and the server falls
   * back to asking in chat.
   */
  publicBaseUrl?: string;
  /** How long a selection link stays valid. Default 15 minutes. */
  ticketTtlMs?: number;
  /** Injected by tests; defaults to Netlify Blobs. */
  ticketStore?: TicketStore;
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
 * So this handler is **stateless**: every call is a short request/response that
 * finishes in milliseconds, well inside any platform's function timeout.
 *
 * To still offer real dropdowns, missing input is collected out of band: a tool
 * call issues a ticket and a link, the user picks from `<select>` menus on the
 * page at /f/:id, and a later call redeems the ticket. Netlify Blobs carries
 * the answer between those two invocations. Without a store, it degrades to
 * `status: "input_required"` and the model asks in chat.
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

  const ticketStore = options.ticketStore ?? new BlobsTicketStore();
  const ticketTtlMs = options.ticketTtlMs ?? 15 * 60_000;

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // The selection page itself. Served before auth: its own single-use token
    // is the credential, and the user opening it has no MCP header to send.
    if (isFormPath(url.pathname)) {
      return handleFormRequest(request, ticketStore);
    }

    // Netlify/Vercel capture stderr into the function log. When a client says
    // "no tools available" this is the only way to see what it actually sent.
    log(
      `${request.method} ${url.pathname} ` +
        `accept=${JSON.stringify(request.headers.get('accept'))} ` +
        `proto=${JSON.stringify(request.headers.get('mcp-protocol-version'))} ` +
        `session=${JSON.stringify(request.headers.get('mcp-session-id'))} ` +
        `ua=${JSON.stringify(request.headers.get('user-agent'))}`,
    );

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

    // Streamable HTTP's GET stream and DELETE teardown both assume a session
    // that outlives the request. Neither exists here, and letting the SDK
    // handle GET would open an SSE stream that never closes - the function
    // would just hang until the platform's timeout killed it.
    //
    // The spec allows a server that does not offer the optional stream to say
    // so with 405, and clients must cope with that. Answering immediately is
    // far better than a 30-second stall.
    if (request.method === 'GET' || request.method === 'DELETE') {
      return json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              'Method Not Allowed: this deployment is stateless, so it offers no SSE stream and no session teardown. Send JSON-RPC over POST.',
          },
          id: null,
        },
        405,
        { allow: 'POST' },
      );
    }

    // Streamable HTTP asks clients to accept both application/json and
    // text/event-stream on POST, and the SDK enforces it with a 406. Since this
    // deployment always answers with JSON (enableJsonResponse) and never opens a
    // stream, a client that accepts only JSON is perfectly serviceable - so
    // widen the header rather than reject a request we can honour.
    const accept = request.headers.get('accept') ?? '';
    const needsJson = !accept.includes('application/json');
    const needsSse = !accept.includes('text/event-stream');

    let effective = request;
    if (needsJson || needsSse) {
      const headers = new Headers(request.headers);
      headers.set('accept', 'application/json, text/event-stream');
      effective = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        // Required by undici whenever a body is present on a constructed Request.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    }

    // A fresh server and transport per request. Stateless mode means no session
    // id is issued and none is expected, so nothing needs to survive the call.
    const baseUrl = options.publicBaseUrl ?? url.origin;
    const { server, dispose } = buildServer({
      ...config,
      tickets: { store: ticketStore, baseUrl: baseUrl.replace(/\/$/, ''), ttlMs: ticketTtlMs },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON rather than an SSE stream: there is nothing to stream, and
      // some platforms buffer SSE anyway.
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(effective);
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
