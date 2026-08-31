import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AnswerValue, FieldSpec } from './fields.js';
import { toElicitationSchema } from './fields.js';
import { FormServer, openInBrowser, type PromptOutcome } from './webform.js';
import { log } from '../log.js';

/**
 * How a prompt actually reached the user.
 *
 * `conversational` is not a UI at all: it means no interactive channel was
 * available, so the tool must hand the question back to the model and let it
 * ask in chat. That is the only fallback every MCP client can honour, because
 * it uses nothing but ordinary tool calls.
 */
export type Channel = 'elicitation-form' | 'elicitation-url' | 'browser' | 'conversational';

/** What to do when the client advertises no elicitation support. */
export type FallbackMode = 'browser' | 'conversational';

export interface AskRequest {
  kind: 'confirm' | 'form';
  title: string;
  message: string;
  details?: string;
  risk?: 'low' | 'medium' | 'high';
  submitLabel: string;
  cancelLabel: string;
  fields: FieldSpec[];
  timeoutMs: number;
}

/** `unsupported` = no interactive channel; the caller should ask in chat instead. */
export type AskOutcome = PromptOutcome | { action: 'unsupported' };

export interface AskResult {
  outcome: AskOutcome;
  channel: Channel;
  /** Set when the user must click something themselves; the agent should relay it. */
  url?: string;
}

export interface ElicitationSupport {
  form: boolean;
  url: boolean;
}

export function detectSupport(server: Server): ElicitationSupport {
  const caps = server.getClientCapabilities();
  const e = caps?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (!e) return { form: false, url: false };
  // The SDK normalizes a bare `{}` to `{ form: {} }`, so an object with neither
  // key present still means form-only rather than nothing.
  const form = e.form !== undefined || (e.url === undefined && Object.keys(e).length === 0);
  return { form, url: e.url !== undefined };
}

/** The channel a prompt would use right now, without sending one. */
export function plannedChannel(
  server: Server,
  fallback: FallbackMode,
  force?: Channel,
): Channel {
  if (force) return force;
  const support = detectSupport(server);
  if (support.form) return 'elicitation-form';
  if (support.url) return 'elicitation-url';
  return fallback;
}

/** Fold title/details into the single message string elicitation gives us. */
function composeMessage(req: AskRequest): string {
  const parts = [req.title === req.message ? undefined : req.title, req.message];
  if (req.risk && req.risk !== 'low') parts.push(`Risk level: ${req.risk}.`);
  if (req.details) parts.push(`\n${req.details}`);
  return parts.filter(Boolean).join('\n\n');
}

export class Asker {
  constructor(
    private readonly formServer: FormServer,
    private readonly fallback: FallbackMode = 'browser',
    private readonly forceChannel?: Channel,
    private readonly launchBrowser: boolean = true,
  ) {}

  /** The channel a prompt would use, without sending one. */
  channelFor(server: Server): Channel {
    return plannedChannel(server, this.fallback, this.forceChannel);
  }

  async ask(server: Server, req: AskRequest): Promise<AskResult> {
    const channel = plannedChannel(server, this.fallback, this.forceChannel);

    // Tier 1 - the host renders its own native confirmation/form UI.
    if (channel === 'elicitation-form') {
      try {
        return await this.viaElicitationForm(server, req);
      } catch (err) {
        log(`form elicitation failed, falling back: ${errText(err)}`);
      }
    }

    // Tier 2 - the host has no form UI but can hand the user a URL.
    if (channel === 'elicitation-url') {
      try {
        return await this.viaElicitationUrl(server, req);
      } catch (err) {
        log(`url elicitation failed, falling back: ${errText(err)}`);
      }
    }

    // Tier 3 - serve a form ourselves and point a browser at it.
    if (channel === 'browser' || this.fallback === 'browser') {
      try {
        return await this.viaBrowser(req);
      } catch (err) {
        log(`browser fallback failed, deferring to the model: ${errText(err)}`);
      }
    }

    // Tier 4 - nothing interactive is possible. The caller asks in chat.
    return { channel: 'conversational', outcome: { action: 'unsupported' } };
  }

  private async viaElicitationForm(server: Server, req: AskRequest): Promise<AskResult> {
    const result = await server.elicitInput(
      {
        mode: 'form',
        message: composeMessage(req),
        requestedSchema: toElicitationSchema(req.fields),
      },
      // Elicitation waits on a human, so the default request timeout is far too short.
      { timeout: req.timeoutMs, resetTimeoutOnProgress: true },
    );

    if (result.action === 'accept') {
      return {
        channel: 'elicitation-form',
        outcome: { action: 'accept', content: (result.content ?? {}) as Record<string, AnswerValue> },
      };
    }
    if (result.action === 'decline') return { channel: 'elicitation-form', outcome: { action: 'decline' } };
    return { channel: 'elicitation-form', outcome: { action: 'cancel', reason: 'dismissed' } };
  }

  private async viaElicitationUrl(server: Server, req: AskRequest): Promise<AskResult> {
    const { url, result } = await this.formServer.createPrompt(toPromptSpec(req), req.timeoutMs);

    const elicitationId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Register the notifier before the request so a fast submit cannot race it.
    const notifyComplete = server.createElicitationCompletionNotifier(elicitationId);

    const ack = await server.elicitInput(
      { mode: 'url', message: composeMessage(req), elicitationId, url },
      { timeout: req.timeoutMs, resetTimeoutOnProgress: true },
    );

    // In URL mode the immediate result only says whether the client accepted the
    // hand-off. A decline/cancel here means the user never opened the page.
    if (ack.action !== 'accept') {
      await notifyComplete().catch(() => {});
      return {
        channel: 'elicitation-url',
        url,
        outcome: ack.action === 'decline' ? { action: 'decline' } : { action: 'cancel', reason: 'dismissed' },
      };
    }

    const outcome = await result;
    await notifyComplete().catch(() => {});
    return { channel: 'elicitation-url', url, outcome };
  }

  private async viaBrowser(req: AskRequest): Promise<AskResult> {
    const { url, result } = await this.formServer.createPrompt(toPromptSpec(req), req.timeoutMs);

    // Pointless (or impossible) on a headless or remote host; the agent still
    // gets the URL back either way, which is the real contract.
    if (this.launchBrowser) openInBrowser(url);
    const outcome = await result;
    return { channel: 'browser', url, outcome };
  }
}

function toPromptSpec(req: AskRequest) {
  return {
    kind: req.kind,
    title: req.title,
    message: req.message,
    details: req.details,
    risk: req.risk,
    submitLabel: req.submitLabel,
    cancelLabel: req.cancelLabel,
    fields: req.fields,
  };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
