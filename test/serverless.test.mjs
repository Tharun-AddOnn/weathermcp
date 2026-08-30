/**
 * The serverless shape: a plain (Request) => Response handler, stateless, with
 * no process kept alive between calls. This is exactly how Netlify, Vercel,
 * Cloudflare Workers and Deno Deploy invoke it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFetchHandler } from '../dist/serverless.js';

const BASE = 'https://example.netlify.app';

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function post(path, body, headers = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const INIT = rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'serverless-test', version: '1.0.0' },
});

/** Reads a JSON-RPC payload out of either a JSON or an SSE response. */
async function payload(res) {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

test('health check needs no auth and reports the mode', async () => {
  const handler = createFetchHandler();
  const res = await handler(new Request(`${BASE}/health`));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'serverless-stateless');
});

test('initialize succeeds and issues no session id', async () => {
  const handler = createFetchHandler();
  const res = await handler(post('/mcp', INIT));
  assert.equal(res.status, 200);

  // Stateless: nothing for a serverless platform to have to remember.
  assert.equal(res.headers.get('mcp-session-id'), null);

  const body = await payload(res);
  assert.equal(body.result.serverInfo.name, 'mcp-weather-elicitation');
  assert.ok(body.result.capabilities.tools);
});

test('a cold instance still lists tools', async () => {
  // The decisive serverless question: each request may hit a different instance
  // that never saw the initialize call.
  const handler = createFetchHandler();
  const res = await handler(post('/mcp', rpc('tools/list'), 2));
  assert.equal(res.status, 200);

  const body = await payload(res);
  assert.ok(body.result, `expected a result, got ${JSON.stringify(body)}`);
  const names = body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['client_capabilities', 'get_weather', 'list_cities']);
});

test('get_weather with both arguments returns weather', async () => {
  const handler = createFetchHandler();
  const res = await handler(
    post('/mcp', rpc('tools/call', { name: 'get_weather', arguments: { city: 'delhi', temperatureUnit: 'F' } }, 3)),
  );

  const body = await payload(res);
  const out = body.result.structuredContent;
  assert.equal(out.status, 'ok');
  assert.equal(out.city, 'Delhi');
  assert.equal(out.temperature, 89.6); // 32C
  assert.equal(out.channel, 'conversational');
});

test('missing arguments come back as input_required, never a hang', async () => {
  const handler = createFetchHandler();
  const started = Date.now();
  const res = await handler(post('/mcp', rpc('tools/call', { name: 'get_weather', arguments: {} }, 4)));

  // Must resolve immediately - a serverless function cannot wait on a human.
  assert.ok(Date.now() - started < 2000, 'handler must not block waiting for input');

  const out = (await payload(res)).result.structuredContent;
  assert.equal(out.status, 'input_required');
  assert.deepEqual(out.missing, ['city', 'temperatureUnit']);
  assert.equal(out.availableCities.length, 6);
});

test('elicitation is never attempted even if the client advertises it', async () => {
  // A client can claim elicitation support; without a live stream to answer on,
  // prompting it would hang the function until the platform kills it.
  const handler = createFetchHandler();
  const init = rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { elicitation: {} },
    clientInfo: { name: 'eager-client', version: '1.0.0' },
  });
  await handler(post('/mcp', init));

  const started = Date.now();
  const res = await handler(post('/mcp', rpc('tools/call', { name: 'get_weather', arguments: {} }, 5)));
  assert.ok(Date.now() - started < 2000, 'must not try to elicit');

  const out = (await payload(res)).result.structuredContent;
  assert.equal(out.status, 'input_required');
  assert.equal(out.channel, 'conversational');
});

test('client_capabilities reports the serverless limitation honestly', async () => {
  const handler = createFetchHandler();
  const res = await handler(post('/mcp', rpc('tools/call', { name: 'client_capabilities', arguments: {} }, 6)));
  const out = (await payload(res)).result.structuredContent;

  assert.equal(out.channel, 'conversational');
  assert.match(out.rendering, /No interactive UI/i);
});

test('bearer token auth', async () => {
  const handler = createFetchHandler({ authToken: 'sekret' });

  assert.equal((await handler(post('/mcp', INIT))).status, 401);
  assert.equal((await handler(post('/mcp', INIT, { authorization: 'Bearer wrong' }))).status, 401);
  assert.equal((await handler(post('/mcp', INIT, { authorization: 'Bearer sekret' }))).status, 200);

  // Probes must keep working without credentials.
  assert.equal((await handler(new Request(`${BASE}/health`))).status, 200);
});

test('path secret auth, for clients that cannot send a header', async () => {
  const handler = createFetchHandler({ pathSecret: 'abc123' });

  assert.equal((await handler(post('/mcp', INIT))).status, 401);
  assert.equal((await handler(post('/mcp/nope', INIT))).status, 401);
  assert.equal((await handler(post('/mcp/abc123', INIT))).status, 200);
  assert.equal((await handler(post('/mcp/abc123/', INIT))).status, 200, 'trailing slash tolerated');
});

test('an unknown city is still validated in serverless mode', async () => {
  const handler = createFetchHandler();
  const res = await handler(
    post('/mcp', rpc('tools/call', { name: 'get_weather', arguments: { city: 'Atlantis' } }, 7)),
  );
  const result = (await payload(res)).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown city "Atlantis"/);
});

test('GET on the MCP endpoint answers 405 immediately instead of hanging', async () => {
  // A Streamable HTTP client may try to open the optional SSE stream. Letting
  // the SDK handle it would keep the connection open until the platform's
  // function timeout; the spec permits 405 when the stream is not offered.
  const handler = createFetchHandler();

  const started = Date.now();
  const res = await handler(
    new Request(`${BASE}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } }),
  );
  const elapsed = Date.now() - started;

  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  assert.ok(elapsed < 2000, `must answer at once, took ${elapsed}ms`);
  assert.match((await res.json()).error.message, /stateless/i);
});

test('a browser-style GET is also refused promptly', async () => {
  // What a person visiting /mcp in a tab sends. Previously reached the SDK and
  // came back 406; 405 is the clearer answer and never opens a stream.
  const handler = createFetchHandler();
  const res = await handler(
    new Request(`${BASE}/mcp`, { method: 'GET', headers: { accept: 'text/html' } }),
  );
  assert.equal(res.status, 405);
});

test('DELETE session teardown is refused, since there are no sessions', async () => {
  const handler = createFetchHandler();
  const res = await handler(new Request(`${BASE}/mcp`, { method: 'DELETE' }));
  assert.equal(res.status, 405);
});

test('health still answers on GET despite the method guard', async () => {
  const handler = createFetchHandler();
  const res = await handler(new Request(`${BASE}/health`, { method: 'GET' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('auth is still enforced ahead of the method guard', async () => {
  const handler = createFetchHandler({ authToken: 'sekret' });
  const res = await handler(new Request(`${BASE}/mcp`, { method: 'GET' }));
  assert.equal(res.status, 401, 'must not reveal the endpoint shape to anonymous callers');
});

test('a client that accepts only application/json still gets tools', async () => {
  // The likeliest cause of "connector has no tools available": the SDK enforces
  // Accept containing BOTH json and event-stream on POST and 406s otherwise.
  // This deployment always answers with JSON, so such a client is serviceable.
  const handler = createFetchHandler();

  const res = await handler(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(rpc('tools/list', {}, 20)),
    }),
  );

  assert.equal(res.status, 200, 'must not 406 a JSON-only client');
  const body = await payload(res);
  assert.equal(body.result.tools.length, 3);
});

test('a client sending no Accept header at all still gets tools', async () => {
  const handler = createFetchHandler();
  const res = await handler(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc('tools/list', {}, 21)),
    }),
  );
  assert.equal(res.status, 200);
  assert.equal((await payload(res)).result.tools.length, 3);
});

test('widening Accept does not corrupt the request body', async () => {
  // The body is a stream; rebuilding the Request must preserve it intact.
  const handler = createFetchHandler();
  const res = await handler(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        rpc('tools/call', { name: 'get_weather', arguments: { city: 'chennai', temperatureUnit: 'F' } }, 22),
      ),
    }),
  );

  const out = (await payload(res)).result.structuredContent;
  assert.equal(out.status, 'ok');
  assert.equal(out.city, 'Chennai');
  assert.equal(out.temperature, 86); // 30C -> 86F
});
