/**
 * The demo page's client logic, exercised against the real serverless handler.
 *
 * `McpBrowserClient` is given the handler as its `fetch`, so these are genuine
 * round trips through the MCP layer - only the DOM is absent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFetchHandler } from '../dist/serverless.js';
import { MemoryTicketStore } from '../dist/ticket/store.js';
import {
  McpBrowserClient,
  validateSelection,
  formatResult,
  parsePayload,
} from '../public/mcp-client.js';

const ORIGIN = 'https://demo.example';

/** Routes the browser client's fetch straight into the server handler. */
function connectedClient(handlerOptions = {}) {
  const handler = createFetchHandler({
    ticketStore: new MemoryTicketStore(),
    publicBaseUrl: ORIGIN,
    // The page has its own form, so ask the server to state what it needs
    // rather than issue a link.
    ...handlerOptions,
  });
  const fetchImpl = (path, init) => handler(new Request(`${ORIGIN}${path}`, init));
  return new McpBrowserClient('/mcp', fetchImpl);
}

// --- protocol helpers ------------------------------------------------------

test('parsePayload reads both JSON and SSE bodies', () => {
  assert.deepEqual(parsePayload('application/json', '{"result":1}'), { result: 1 });
  assert.deepEqual(
    parsePayload('text/event-stream', 'event: message\ndata: {"result":2}\n\n'),
    { result: 2 },
  );
  assert.throws(() => parsePayload('text/event-stream', 'event: message\n\n'), /Empty event stream/);
});

// --- validation (spec §8: city validation, unit selection) -----------------

test('validation rejects empty and unsupported selections', () => {
  const options = {
    cities: [{ value: 'mumbai', label: 'Mumbai' }],
    units: [{ value: 'C', label: 'Celsius (°C)' }],
  };

  assert.deepEqual(validateSelection({ city: '', unit: '' }, options), {
    city: 'Please choose a city.',
    unit: 'Please choose a temperature unit.',
  });

  assert.deepEqual(validateSelection({ city: 'atlantis', unit: 'C' }, options), {
    city: 'That city is not supported.',
  });

  assert.deepEqual(validateSelection({ city: 'mumbai', unit: 'K' }, options), {
    unit: 'That temperature unit is not supported.',
  });

  // A complete, valid selection produces no errors at all.
  assert.deepEqual(validateSelection({ city: 'mumbai', unit: 'C' }, options), {});
});

test('formatResult renders the headline the page shows', () => {
  assert.deepEqual(
    formatResult({ status: 'ok', city: 'Hyderabad', temperature: 29, unit: 'C', condition: 'Partly cloudy' }),
    { headline: 'Weather in Hyderabad: 29°C', detail: 'Partly cloudy' },
  );
  assert.equal(
    formatResult({ status: 'ok', city: 'London', temperature: 64.4, unit: 'F', condition: 'Cloudy' }).headline,
    'Weather in London: 64.4°F',
  );
  assert.throws(() => formatResult({ status: 'input_required' }), /No weather/);
});

// --- the page's actual flow ------------------------------------------------

test('initialize and tools/list succeed from the browser client', async () => {
  const client = connectedClient();
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'mcp-weather-elicitation');

  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'get_weather'));
});

test('asking with no arguments returns the options the form is built from', async () => {
  // No ticket store reachable -> the server states what it needs, which is what
  // the page wants: it draws its own form.
  const client = connectedClient({ ticketStore: brokenStore() });
  await client.initialize();

  const next = await client.startWeatherRequest();
  assert.equal(next.kind, 'needs-input');
  assert.equal(next.cities.length, 6);
  assert.deepEqual(next.cities[0], { value: 'hyderabad', label: 'Hyderabad' });
  assert.deepEqual(next.units.map((u) => u.value), ['C', 'F']);
});

test('submitting the form returns a formatted reading', async () => {
  const client = connectedClient();
  await client.initialize();

  const shown = await client.submitWeatherRequest({ city: 'hyderabad', unit: 'C' });
  assert.deepEqual(shown, { headline: 'Weather in Hyderabad: 29°C', detail: 'Partly cloudy' });

  const f = await client.submitWeatherRequest({ city: 'london', unit: 'F' });
  assert.equal(f.headline, 'Weather in London: 64.4°F');
});

test('a rejected submission surfaces the server message, not a crash', async () => {
  const client = connectedClient();
  await client.initialize();

  await assert.rejects(
    () => client.submitWeatherRequest({ city: 'atlantis', unit: 'C' }),
    /Unknown city "atlantis"/,
  );
});

test('an unreachable server produces a readable error', async () => {
  const client = new McpBrowserClient('/mcp', async () =>
    new Response('gateway blew up', { status: 502, headers: { 'content-type': 'text/plain' } }),
  );
  await assert.rejects(() => client.initialize(), /Server returned 502/);
});

test('a JSON-RPC error body becomes an Error, not a silent undefined', async () => {
  const client = new McpBrowserClient('/mcp', async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await assert.rejects(() => client.initialize(), /nope/);
});

/** A store whose create() always fails, so the server falls back to input_required. */
function brokenStore() {
  return {
    async create() {
      throw new Error('no storage');
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
}
