import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { renderFormPage, renderClosedPage } from './html.js';
import { coerceAndValidate, type AnswerValue, type FieldSpec } from './fields.js';
import { log } from '../log.js';

export type PromptKind = 'confirm' | 'form';

export interface PendingPrompt {
  id: string;
  token: string;
  kind: PromptKind;
  title: string;
  message: string;
  details?: string;
  risk?: 'low' | 'medium' | 'high';
  submitLabel: string;
  cancelLabel: string;
  fields: FieldSpec[];
  resolve: (r: PromptOutcome) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export type PromptOutcome =
  | { action: 'accept'; content: Record<string, AnswerValue> }
  | { action: 'decline' }
  | { action: 'cancel'; reason: 'timeout' | 'dismissed' | 'shutdown' };

export interface FormServerOptions {
  host?: string;
  port?: number;
  /** Externally reachable base URL. Required in attached mode. */
  publicBaseUrl?: string;
  /**
   * Attached mode: do not open a port of our own. The caller routes `/p/...`
   * requests into `handleRequest`. This is what hosted deployments use, since
   * a platform typically exposes exactly one port.
   */
  attached?: boolean;
}

/**
 * Renders prompts the host client could not render itself. In standalone mode it
 * runs its own loopback HTTP server, started lazily on first use so a
 * pure-elicitation session never opens a port. In attached mode it borrows the
 * caller's server instead.
 */
export class FormServer {
  private server?: http.Server;
  private startPromise?: Promise<string>;
  private baseUrl?: string;
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly host: string;
  private readonly port: number;
  private readonly publicBaseUrl?: string;
  private readonly attached: boolean;

  constructor(opts: FormServerOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 0;
    this.publicBaseUrl = opts.publicBaseUrl;
    this.attached = opts.attached ?? false;
  }

  /** Idempotent; concurrent callers share one start. */
  private start(): Promise<string> {
    if (this.startPromise) return this.startPromise;

    if (this.attached) {
      if (!this.publicBaseUrl) {
        return Promise.reject(new Error('Attached FormServer requires a publicBaseUrl.'));
      }
      this.baseUrl = this.publicBaseUrl.replace(/\/$/, '');
      this.startPromise = Promise.resolve(this.baseUrl);
      return this.startPromise;
    }

    this.startPromise = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.on('error', reject);
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new Error('Could not determine form server address.'));
        this.server = server;
        this.baseUrl = this.publicBaseUrl?.replace(/\/$/, '') ?? `http://${this.host}:${addr.port}`;
        log(`form fallback listening on ${this.baseUrl}`);
        resolve(this.baseUrl);
      });
      // Do not hold the process open just because the fallback server exists.
      server.unref();
    });

    return this.startPromise;
  }

  /**
   * Register a prompt and return the URL that renders it. Resolution happens when
   * the user submits, dismisses, or the deadline passes.
   */
  async createPrompt(
    spec: Omit<PendingPrompt, 'id' | 'token' | 'resolve' | 'timer' | 'settled'>,
    timeoutMs: number,
  ): Promise<{ url: string; result: Promise<PromptOutcome> }> {
    const base = await this.start();
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');

    let resolve!: (r: PromptOutcome) => void;
    const result = new Promise<PromptOutcome>((r) => {
      resolve = r;
    });

    const timer = setTimeout(() => this.settle(id, { action: 'cancel', reason: 'timeout' }), timeoutMs);
    timer.unref();

    this.pending.set(id, { ...spec, id, token, resolve, timer, settled: false });

    const url = `${base}/p/${id}?t=${token}`;
    // Logged so the user can still reach the prompt if the browser fails to open.
    log(`prompt ready: ${url}`);
    return { url, result };
  }

  private settle(id: string, outcome: PromptOutcome): void {
    const p = this.pending.get(id);
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(outcome);
  }

  /** Constant-time token compare so a prompt URL cannot be brute-forced locally. */
  private authorized(p: PendingPrompt, supplied: string | null): boolean {
    if (!supplied) return false;
    const a = Buffer.from(p.token);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Public so a host application can route `/p/...` here in attached mode. */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const match = /^\/p\/([0-9a-fA-F-]{36})$/.exec(url.pathname);

    if (!match) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }

    const id = match[1];
    const prompt = this.pending.get(id);

    if (!prompt) {
      // Already answered, expired, or never existed - all look the same to a visitor.
      res
        .writeHead(410, { 'content-type': 'text/html; charset=utf-8' })
        .end(renderClosedPage('This request is no longer open', 'It was already answered, or it timed out.'));
      return;
    }

    if (req.method === 'GET') {
      if (!this.authorized(prompt, url.searchParams.get('t'))) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
        return;
      }
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        .end(renderFormPage(prompt, []));
      return;
    }

    if (req.method === 'POST') {
      this.readBody(req)
        .then((body) => {
          if (!this.authorized(prompt, body.get('__token') ?? url.searchParams.get('t'))) {
            res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
            return;
          }

          const intent = body.get('__intent');
          if (intent === 'decline') {
            this.settle(id, { action: 'decline' });
            res
              .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              .end(renderClosedPage('Declined', 'Your answer has been sent back. You can close this tab.'));
            return;
          }

          const raw: Record<string, unknown> = {};
          for (const f of prompt.fields) {
            raw[f.name] = f.type === 'multiselect' ? body.getAll(f.name) : body.get(f.name) ?? undefined;
          }

          const checked = coerceAndValidate(prompt.fields, raw);
          if (!checked.ok) {
            // Re-render in place with errors rather than losing what they typed.
            res
              .writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
              .end(renderFormPage(prompt, checked.errors, raw));
            return;
          }

          this.settle(id, { action: 'accept', content: checked.values });
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(renderClosedPage('Sent', 'Your answer has been sent back. You can close this tab.'));
        })
        .catch((err) => {
          log(`form submit failed: ${String(err)}`);
          res.writeHead(500, { 'content-type': 'text/plain' }).end('Server error');
        });
      return;
    }

    res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed');
  }

  private readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        // Bound the body; these forms are small and this is an open local port.
        if (size > 1_000_000) {
          reject(new Error('Body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }

  /** Cancel everything outstanding and release the port. */
  async close(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { action: 'cancel', reason: 'shutdown' });
    }
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
    // Attached mode has no port of its own; keep the resolved base URL so the
    // shared instance stays usable across sessions.
    if (!this.attached) this.startPromise = undefined;
  }
}

/**
 * Best-effort browser launch. Never throws: if this fails the user still has the
 * URL in the tool response, which is the actual contract.
 */
export function openInBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', (e) => log(`could not open browser: ${e.message}`));
    child.unref();
  } catch (e) {
    log(`could not open browser: ${String(e)}`);
  }
}
