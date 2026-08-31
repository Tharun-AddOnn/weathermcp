import type { AnswerValue } from '../elicit/fields.js';
import { isExpired, newTicket, type CreateTicketInput, type Ticket, type TicketStore } from './store.js';

/** The slice of @netlify/blobs we use, so the import can stay lazy and optional. */
interface BlobStore {
  get(key: string, opts: { type: 'json' }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Netlify Blobs backing, so a ticket created by one function invocation is
 * still there when a later invocation - on a different instance - looks it up.
 *
 * Netlify injects the credentials automatically inside a deployed function, so
 * there is nothing to configure. The import is deferred and failures degrade to
 * "ticket not found" rather than crashing a tool call.
 */
export class BlobsTicketStore implements TicketStore {
  private store?: BlobStore;

  constructor(private readonly name = 'weather-tickets') {}

  private async open(): Promise<BlobStore | undefined> {
    if (this.store) return this.store;
    try {
      const { getStore } = (await import('@netlify/blobs')) as unknown as {
        getStore: (name: string) => BlobStore;
      };
      this.store = getStore(this.name);
      return this.store;
    } catch {
      // Not running on Netlify, or the package is unavailable.
      return undefined;
    }
  }

  async create(input: CreateTicketInput): Promise<Ticket> {
    const ticket = newTicket(input);
    const store = await this.open();
    if (!store) throw new Error('Ticket storage is unavailable on this deployment.');
    await store.setJSON(ticket.id, ticket);
    return ticket;
  }

  async get(id: string): Promise<Ticket | undefined> {
    const store = await this.open();
    if (!store) return undefined;

    let raw: unknown;
    try {
      raw = await store.get(id, { type: 'json' });
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== 'object') return undefined;

    const ticket = raw as Ticket;
    if (isExpired(ticket)) {
      // Blobs has no TTL of its own, so expiry is enforced on read.
      await store.delete(id).catch(() => {});
      return undefined;
    }
    return ticket;
  }

  private async settle(
    id: string,
    status: 'answered' | 'cancelled',
    answer?: Record<string, AnswerValue>,
  ): Promise<Ticket | undefined> {
    const store = await this.open();
    if (!store) return undefined;

    const ticket = await this.get(id);
    if (!ticket || ticket.status !== 'pending') return undefined;

    const updated: Ticket = { ...ticket, status, ...(answer ? { answer } : {}) };
    await store.setJSON(id, updated);
    return updated;
  }

  answer(id: string, answer: Record<string, AnswerValue>): Promise<Ticket | undefined> {
    return this.settle(id, 'answered', answer);
  }

  cancel(id: string): Promise<Ticket | undefined> {
    return this.settle(id, 'cancelled');
  }
}
