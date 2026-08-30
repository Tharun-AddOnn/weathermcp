/**
 * End-to-end against the built binary, spawned as a subprocess the way
 * Claude Desktop / Claude Code / Copilot launch it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('the shipped binary serves tools over stdio', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js', '--timeout', '10'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });

  const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: { elicitation: {} } });
  // Answer whichever field is being asked for.
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const key = Object.keys(req.params.requestedSchema.properties)[0];
    return { action: 'accept', content: { [key]: key === 'city' ? 'hyderabad' : 'C' } };
  });

  await client.connect(transport);

  const status = await client.callTool({ name: 'client_capabilities', arguments: {} });
  assert.equal(status.structuredContent.channel, 'elicitation-form');
  assert.equal(status.structuredContent.defaultTimeoutSeconds, 10);

  // The headline flow, through the real binary: no arguments -> two prompts -> weather.
  const weather = await client.callTool({ name: 'get_weather', arguments: {} });
  assert.equal(weather.structuredContent.status, 'ok');
  assert.equal(weather.structuredContent.city, 'Hyderabad');
  assert.equal(weather.structuredContent.temperature, 29);
  assert.equal(weather.structuredContent.unit, 'C');

  await client.close();
});

test('nothing but JSON-RPC is written to stdout', async () => {
  // A single stray console.log in the server corrupts the stream and the client
  // drops the session, so assert the logger really is stderr-only.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: process.cwd() });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  // Long enough for Node startup + module load on a cold cache.
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  await new Promise((r) => child.on('exit', r));

  assert.equal(stdout, '', `stdout must stay clean, got: ${stdout}`);
  assert.match(stderr, /listening on stdio/);
});
