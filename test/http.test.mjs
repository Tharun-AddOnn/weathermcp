/**
 * Covers the hosted deployment shape: one port serving both the MCP endpoint and
 * the fallback form, plus endpoint auth.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'test-secret-token';

/** Boot the built binary in HTTP mode and wait for it to report readiness. */
async function boot(extraArgs) {
  const port = 3400 + Math.floor(Math.random() * 300);
  const child = spawn(
    process.execPath,
    [
      'dist/index.js',
      '--http',
      '--port',
      String(port),
      '--no-launch',
      '--public-url',
      `http://127.0.0.1:${port}`,
      ...extraArgs,
    ],
    { cwd: process.cwd() },
  );

  const logs = [];
  child.stderr.on('data', (d) => logs.push(String(d)));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server never came up. logs:\n${logs.join('')}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    port,
    logs,
    stop: async () => {
      child.kill();
      await new Promise((r) => child.on('exit', r));
    },
  };
}

test('serves the fallback form on the same port as the MCP endpoint', async () => {
  const srv = await boot(['--force-channel', 'browser']);
  try {
    // A plain client with no elicitation capability -> browser tier.
    const client = new Client({ name: 'hosted-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));

    const call = client.callTool({ name: 'get_weather', arguments: { temperatureUnit: 'C' } });

    // The prompt URL must be on the main port, not a second ephemeral one.
    let url;
    const deadline = Date.now() + 15_000;
    while (!url && Date.now() < deadline) {
      const m = /prompt ready: (\S+)/.exec(srv.logs.join(''));
      if (m) url = m[1];
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(url, 'no prompt URL was logged');
    assert.ok(
      url.startsWith(`http://127.0.0.1:${srv.port}/p/`),
      `prompt URL must live on the main port, got ${url}`,
    );

    const page = await (await fetch(url)).text();
    assert.match(page, /Select a city/);
    assert.match(page, /Hyderabad/);
    const token = /name="__token" value="([^"]+)"/.exec(page)[1];

    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__token', token],
        ['__intent', 'accept'],
        ['city', 'mumbai'],
      ]).toString(),
    });

    const res = await call;
    assert.equal(res.structuredContent.status, 'ok');
    assert.equal(res.structuredContent.city, 'Mumbai');
    assert.equal(res.structuredContent.temperature, 28);
    assert.equal(res.structuredContent.channel, 'browser');
    await client.close();
  } finally {
    await srv.stop();
  }
});

test('--auth-token gates the MCP endpoint but not /health', async () => {
  const srv = await boot(['--auth-token', TOKEN]);
  const base = `http://127.0.0.1:${srv.port}`;
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'curl', version: '1' },
    },
  };
  const headers = (auth) => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(auth ? { authorization: auth } : {}),
  });

  try {
    assert.equal((await fetch(`${base}/health`)).status, 200, 'health must stay open for probes');

    const anon = await fetch(`${base}/mcp`, { method: 'POST', headers: headers(), body: JSON.stringify(init) });
    assert.equal(anon.status, 401);

    const wrong = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers('Bearer nope'),
      body: JSON.stringify(init),
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers(`Bearer ${TOKEN}`),
      body: JSON.stringify(init),
    });
    assert.equal(ok.status, 200);
  } finally {
    await srv.stop();
  }
});

test('--path-secret moves the endpoint and /mcp stops existing', async () => {
  const srv = await boot(['--path-secret', 's3cr3t']);
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const client = new Client({ name: 'hosted-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/s3cr3t`)));
    const { tools } = await client.listTools();
    assert.ok(tools.length === 3);
    await client.close();

    const plain = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    assert.equal(plain.status, 404);
  } finally {
    await srv.stop();
  }
});
