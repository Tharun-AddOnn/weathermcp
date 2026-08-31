import { randomUUID, randomBytes } from 'node:crypto';
import type { AnswerValue, FieldSpec } from '../elicit/fields.js';

export type TicketStatus = 'pending' | 'answered' | 'cancelled';

export interface Ticket {
  id: string;
  /** Single-use secret in the form URL; the id alone is not enough to open it. */
  token: string;
  title: string;
  message: string;
  fields: FieldSpec[];
  status: TicketStatus;
  /**
   * Values already established before the form was issued. The redeeming tool
   * call carries only a ticket, so anything not asked about on the page would
   * otherwise be lost between the two calls.
   */
  context?: Record<string, AnswerValue>;
  answer?: Record<string, AnswerValue>;
  createdAt: number;
  expiresAt: number;
}

/**
 * Somewhere to park a question between two tool calls.
 *
 * A client without elicitation cannot be interrupted mid-call, so the dropdown
 * has to live on a web page instead: one tool call hands out a link, the user
 * answers it in their browser, and a second tool call collects the result. That
 * only works if something remembers the question in between - which a serverless
 * function does not, hence this seam.
 */
export interface CreateTicketInput {
  title: string;
  message: string;
  fields: FieldSpec[];
  ttlMs: number;
  context?: Record<string, AnswerValue>;
}

export interface TicketStore {
  create(input: CreateTicketInput): Promise<Ticket>;
  get(id: string): Promise<Ticket | undefined>;
  /** Records an answer. Returns undefined if the ticket is gone or already settled. */
  answer(id: string, answer: Record<string, AnswerValue>): Promise<Ticket | undefined>;
  cancel(id: string): Promise<Ticket | undefined>;
}

export function newTicket(input: CreateTicketInput): Ticket {
  const now = Date.now();
  return {
    id: randomUUID(),
    token: randomBytes(24).toString('base64url'),
    title: input.title,
    message: input.message,
    fields: input.fields,
    status: 'pending',
    ...(input.context ? { context: input.context } : {}),
    createdAt: now,
    expiresAt: now + input.ttlMs,
  };
}

export function isExpired(t: Ticket): boolean {
  return Date.now() > t.expiresAt;
}

/**
 * For stdio and long-lived HTTP, where the process itself is the store.
 * Useless on serverless - each invocation would get a fresh empty Map.
 */
export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, Ticket>();

  async create(input: CreateTicketInput): Promise<Ticket> {
    this.sweep();
    const ticket = newTicket(input);
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  async get(id: string): Promise<Ticket | undefined> {
    const t = this.tickets.get(id);
    if (!t) return undefined;
    if (isExpired(t)) {
      this.tickets.delete(id);
      return undefined;
    }
    return t;
  }

  async answer(id: string, answer: Record<string, AnswerValue>): Promise<Ticket | undefined> {
    const t = await this.get(id);
    if (!t || t.status !== 'pending') return undefined;
    t.status = 'answered';
    t.answer = answer;
    return t;
  }

  async cancel(id: string): Promise<Ticket | undefined> {
    const t = await this.get(id);
    if (!t || t.status !== 'pending') return undefined;
    t.status = 'cancelled';
    return t;
  }

  /** Keeps a long-running process from accumulating abandoned tickets. */
  private sweep(): void {
    for (const [id, t] of this.tickets) if (isExpired(t)) this.tickets.delete(id);
  }
}
