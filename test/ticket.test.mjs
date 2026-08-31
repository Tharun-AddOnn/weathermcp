/**
 * The link-to-form flow: how a client with no elicitation support still gets
 * real dropdowns. One tool call issues a link, the user picks on a web page,
 * a second call redeems the ticket.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFetchHandler } from '../dist/serverless.js';
import { MemoryTicketStore } from '../dist/ticket/store.js';

const BASE = 'https://weather.example.app';

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function newHandler(extra = {}) {
  // MemoryTicketStore stands in for Netlify Blobs: same interface, and the
  // handler is constructed once so state survives between calls exactly as
  // Blobs would across invocations.
  return createFetchHandler({ ticketStore: new MemoryTicketStore(), publicBaseUrl: BASE, ...extra });
}

function call(handler, args, id = 1) {
  return handler(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(rpc('tools/call', { name: 'get_weather', arguments: args }, id)),
    }),
  );
}

const out = async (res) => (await res.json()).result;

test('the whole round trip: link, dropdowns, redeem', async () => {
  const handler = newHandler();

  // 1. No arguments -> a selection link instead of a chat question.
  const first = await out(await call(handler, {}));
  const s = first.structuredContent;

  assert.equal(s.status, 'awaiting_selection');
  assert.equal(s.channel, 'browser');
  assert.deepEqual(s.missing, ['city', 'temperatureUnit']);
  assert.ok(s.ticket, 'a ticket must come back');
  assert.ok(s.selectionUrl.startsWith(`${BASE}/f/`), `unexpected url ${s.selectionUrl}`);
  assert.match(first.content[0].text, /open this link/i);

  // 2. The page must contain real dropdowns, not a text box.
  const page = await (await handler(new Request(s.selectionUrl))).text();
  assert.match(page, /<select[^>]*name="city"/);
  assert.match(page, /<select[^>]*name="temperatureUnit"/);
  assert.match(page, /<option value="hyderabad"[^>]*>Hyderabad<\/option>/);
  assert.match(page, /<option value="london"[^>]*>London<\/option>/);
  assert.match(page, /Celsius \(°C\)/);
  assert.match(page, /Fahrenheit \(°F\)/);

  // 3. Submit the form the way a browser would.
  const token = /name="__token" value="([^"]+)"/.exec(page)[1];
  const submit = await handler(
    new Request(s.selectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__token', token],
        ['__intent', 'accept'],
        ['city', 'london'],
        ['temperatureUnit', 'F'],
      ]).toString(),
    }),
  );
  assert.equal(submit.status, 200);
  assert.match(await submit.text(), /got it/i);

  // 4. Redeem.
  const second = await out(await call(handler, { ticket: s.ticket }, 2));
  assert.equal(second.structuredContent.status, 'ok');
  assert.equal(second.structuredContent.city, 'London');
  assert.equal(second.structuredContent.temperature, 64.4); // 18C -> F
  assert.equal(second.structuredContent.unit, 'F');
  assert.equal(second.structuredContent.channel, 'browser');
  assert.match(second.content[0].text, /London: 64\.4°F|64\.4°F/);
});

test('only the missing field appears on the form', async () => {
  const handler = newHandler();
  const s = (await out(await call(handler, { city: 'mumbai' }))).structuredContent;

  assert.deepEqual(s.missing, ['temperatureUnit']);
  const page = await (await handler(new Request(s.selectionUrl))).text();
  assert.match(page, /<select[^>]*name="temperatureUnit"/);
  assert.ok(!/<select[^>]*name="city"/.test(page), 'city is already known, so must not be asked');

  const token = /name="__token" value="([^"]+)"/.exec(page)[1];
  await handler(
    new Request(s.selectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['__token', token], ['__intent', 'accept'], ['temperatureUnit', 'C']]).toString(),
    }),
  );

  // The city from the first call has to survive into the redeeming call.
  const done = (await out(await call(handler, { ticket: s.ticket }, 2))).structuredContent;
  assert.equal(done.city, 'Mumbai');
  assert.equal(done.temperature, 28);
  assert.equal(done.unit, 'C');
});

test('redeeming before submission says so instead of guessing', async () => {
  const handler = newHandler();
  const s = (await out(await call(handler, {}))).structuredContent;

  const early = (await out(await call(handler, { ticket: s.ticket }, 2))).structuredContent;
  assert.equal(early.status, 'awaiting_selection');
  assert.equal(early.ticket, s.ticket);
  assert.ok(early.selectionUrl, 'the link must be repeated so the model can re-show it');
});

test('cancelling on the page is reported as cancelled', async () => {
  const handler = newHandler();
  const s = (await out(await call(handler, {}))).structuredContent;
  const page = await (await handler(new Request(s.selectionUrl))).text();
  const token = /name="__token" value="([^"]+)"/.exec(page)[1];

  await handler(
    new Request(s.selectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['__token', token], ['__intent', 'decline']]).toString(),
    }),
  );

  const after = (await out(await call(handler, { ticket: s.ticket }, 2))).structuredContent;
  assert.equal(after.status, 'cancelled');
});

test('the form link is single-use and token protected', async () => {
  const handler = newHandler();
  const s = (await out(await call(handler, {}))).structuredContent;
  const bare = s.selectionUrl.split('?')[0];

  assert.equal((await handler(new Request(bare))).status, 403, 'no token');
  assert.equal((await handler(new Request(`${bare}?t=wrong`))).status, 403, 'wrong token');

  const page = await (await handler(new Request(s.selectionUrl))).text();
  const token = /name="__token" value="([^"]+)"/.exec(page)[1];
  await handler(
    new Request(s.selectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__token', token],
        ['__intent', 'accept'],
        ['city', 'delhi'],
        ['temperatureUnit', 'C'],
      ]).toString(),
    }),
  );

  // Reopening an answered ticket must not offer a second submission.
  assert.equal((await handler(new Request(s.selectionUrl))).status, 410);
});

test('an expired ticket is refused with a recoverable message', async () => {
  const store = new MemoryTicketStore();
  const handler = createFetchHandler({ ticketStore: store, publicBaseUrl: BASE, ticketTtlMs: 1 });
  const s = (await out(await call(handler, {}))).structuredContent;

  await new Promise((r) => setTimeout(r, 30));

  const res = await out(await call(handler, { ticket: s.ticket }, 2));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /expired or was already used/i);
  assert.match(res.content[0].text, /no arguments to start again/i);

  assert.equal((await handler(new Request(s.selectionUrl))).status, 410);
});

test('an unknown ticket is refused', async () => {
  const handler = newHandler();
  const res = await out(await call(handler, { ticket: '11111111-2222-3333-4444-555555555555' }));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /expired or was already used/i);
});

test('form submissions are validated server-side', async () => {
  const handler = newHandler();
  const s = (await out(await call(handler, {}))).structuredContent;
  const page = await (await handler(new Request(s.selectionUrl))).text();
  const token = /name="__token" value="([^"]+)"/.exec(page)[1];

  // A tampered option value must not reach the weather service.
  const bad = await handler(
    new Request(s.selectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__token', token],
        ['__intent', 'accept'],
        ['city', 'atlantis'],
        ['temperatureUnit', 'C'],
      ]).toString(),
    }),
  );
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /must be one of/i);

  // Still open, so a correct submission afterwards works.
  const good = await handler(
    new Request(s.selectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__token', token],
        ['__intent', 'accept'],
        ['city', 'chennai'],
        ['temperatureUnit', 'C'],
      ]).toString(),
    }),
  );
  assert.equal(good.status, 200);
  assert.equal((await out(await call(handler, { ticket: s.ticket }, 2))).structuredContent.city, 'Chennai');
});

test('without a ticket store it falls back to asking in chat', async () => {
  // Storage unavailable must degrade, not break the tool.
  const broken = {
    async create() {
      throw new Error('blobs unavailable');
    },
    async get() {
      return undefined;
    },
    async answer() {
      return undefined;
    },
    async cancel() {
      return undefined;
    },
  };
  const handler = createFetchHandler({ ticketStore: broken, publicBaseUrl: BASE });
  const s = (await out(await call(handler, {}))).structuredContent;

  assert.equal(s.status, 'input_required');
  assert.equal(s.channel, 'conversational');
  assert.equal(s.availableCities.length, 6);
});
