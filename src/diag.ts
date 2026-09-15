import { log } from './log.js';

/**
 * Records what the last connecting client declared at `initialize`.
 *
 * Capabilities are exchanged once per connection and never repeated, so on a
 * serverless deployment they vanish the moment the invocation ends. That makes
 * "does this client support X?" unanswerable after the fact - which is exactly
 * the question worth asking of a hosted client like Claude.ai, whose handshake
 * nobody can observe directly.
 *
 * Stashing the last one under a fixed key makes it readable over HTTP at
 * /diag. Capability declarations are not secrets: they are the same fields any
 * MCP server on the other end of that connection already sees.
 */
export interface LastClient {
  at: string;
  clientInfo: unknown;
  capabilities: unknown;
  protocolVersion: unknown;
}

const KEY = '_last-client';
const STORE = 'weather-diagnostics';

interface BlobStore {
  get(key: string, opts: { type: 'json' }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<void>;
}

let memory: LastClient | undefined;

async function open(): Promise<BlobStore | undefined> {
  try {
    const { getStore } = (await import('@netlify/blobs')) as unknown as {
      getStore: (name: string) => BlobStore;
    };
    return getStore(STORE);
  } catch {
    return undefined; // not on Netlify; the in-memory copy still works
  }
}

/** Best-effort: a diagnostic must never break a real request. */
export async function recordClient(params: unknown): Promise<void> {
  const p = params as { clientInfo?: unknown; capabilities?: unknown; protocolVersion?: unknown };
  const entry: LastClient = {
    at: new Date().toISOString(),
    clientInfo: p?.clientInfo ?? null,
    capabilities: p?.capabilities ?? null,
    protocolVersion: p?.protocolVersion ?? null,
  };
  memory = entry;
  log(`initialize from ${JSON.stringify(entry.clientInfo)} caps=${JSON.stringify(entry.capabilities)}`);

  const store = await open();
  await store?.setJSON(KEY, entry).catch(() => {});
}

export async function readLastClient(): Promise<LastClient | undefined> {
  const store = await open();
  if (store) {
    try {
      const raw = await store.get(KEY, { type: 'json' });
      if (raw && typeof raw === 'object') return raw as LastClient;
    } catch {
      /* fall through to memory */
    }
  }
  return memory;
}
