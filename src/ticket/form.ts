import { timingSafeEqual } from 'node:crypto';
import { coerceAndValidate } from '../elicit/fields.js';
import { renderClosedPage, renderFormPage } from '../elicit/html.js';
import { isExpired, type Ticket, type TicketStore } from './store.js';

/** `/f/<uuid>` - deliberately short, since a person types or taps this. */
const FORM_PATH = /^\/f\/([0-9a-fA-F-]{36})\/?$/;

export function isFormPath(pathname: string): boolean {
  return FORM_PATH.test(pathname);
}

export function formPathFor(ticket: Ticket): string {
  return `/f/${ticket.id}?t=${ticket.token}`;
}

function tokenMatches(ticket: Ticket, supplied: string | null): boolean {
  if (!supplied) return false;
  const a = Buffer.from(ticket.token);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

const GONE = () =>
  html(
    renderClosedPage(
      'This link is no longer open',
      'It was already used, or it expired. Ask the assistant for a fresh one.',
    ),
    410,
  );

/**
 * Serves the selection page and records the answer. Written against Web
 * Standard Request/Response so the same code runs on Netlify, Vercel, Workers
 * and the Node HTTP transport.
 */
export async function handleFormRequest(request: Request, store: TicketStore): Promise<Response> {
  const url = new URL(request.url);
  const match = FORM_PATH.exec(url.pathname);
  if (!match) return new Response('Not found', { status: 404 });

  const ticket = await store.get(match[1]);
  if (!ticket || isExpired(ticket)) return GONE();

  if (request.method === 'GET') {
    if (!tokenMatches(ticket, url.searchParams.get('t'))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (ticket.status !== 'pending') {
      return html(
        renderClosedPage(
          ticket.status === 'answered' ? 'Already submitted' : 'Cancelled',
          'Go back to the chat and ask the assistant to continue.',
        ),
        410,
      );
    }
    return html(renderFormPage(ticket, []));
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }

  const body = new URLSearchParams(await request.text());
  if (!tokenMatches(ticket, body.get('__token') ?? url.searchParams.get('t'))) {
    return new Response('Forbidden', { status: 403 });
  }
  if (ticket.status !== 'pending') return GONE();

  if (body.get('__intent') === 'decline') {
    await store.cancel(ticket.id);
    return html(
      renderClosedPage('Cancelled', 'Nothing was submitted. You can close this tab.'),
    );
  }

  const raw: Record<string, unknown> = {};
  for (const f of ticket.fields) {
    raw[f.name] = f.type === 'multiselect' ? body.getAll(f.name) : body.get(f.name) ?? undefined;
  }

  const checked = coerceAndValidate(ticket.fields, raw);
  if (!checked.ok) {
    // Re-render in place rather than losing the selection.
    return html(renderFormPage(ticket, checked.errors, raw), 400);
  }

  await store.answer(ticket.id, checked.values);
  return html(
    renderClosedPage(
      'Thanks - got it',
      'Your choices have been saved. Go back to the chat and tell the assistant you are done.',
    ),
  );
}
