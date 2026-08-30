/**
 * Exercises the browser-fallback tier directly: page rendering, submission,
 * server-side validation, token auth and timeout.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { FormServer } from '../dist/elicit/webform.js';

const server = new FormServer({ host: '127.0.0.1', port: 0 });
after(() => server.close());

const BASE = {
  kind: 'form',
  title: 'Deployment details',
  message: 'Confirm before I ship.',
  submitLabel: 'Submit',
  cancelLabel: 'Cancel',
};

const field = (o) => ({ required: false, type: 'string', ...o });

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

test('renders the fields and returns coerced values on submit', async () => {
  const fields = [
    field({ name: 'email', label: 'Contact', format: 'email', required: true }),
    field({ name: 'replicas', type: 'integer', minimum: 1, maximum: 5 }),
    field({ name: 'urgent', type: 'boolean' }),
    field({ name: 'tier', type: 'select', options: [{ value: 'pro', label: 'Pro plan' }, 'free'] }),
    field({ name: 'tags', type: 'multiselect', options: ['x', 'y', 'z'] }),
    field({ name: 'notes', multiline: true }),
  ];
  const { url, result } = await server.createPrompt({ ...BASE, fields }, 10_000);

  const page = await (await fetch(url)).text();
  assert.match(page, /Deployment details/);
  assert.match(page, /name="email"/);
  assert.match(page, /type="email"/);
  assert.match(page, /<textarea[^>]*name="notes"/);
  assert.match(page, /Pro plan/);
  assert.match(page, /type="checkbox"[^>]*name="tags"[^>]*value="x"/);

  const token = /name="__token" value="([^"]+)"/.exec(page)[1];
  const res = await post(url, [
    ['__token', token],
    ['__intent', 'accept'],
    ['email', 'dev@example.com'],
    ['replicas', '3'],
    ['urgent', 'true'],
    ['tier', 'pro'],
    ['tags', 'x'],
    ['tags', 'z'],
    ['notes', 'ship it'],
  ]);
  assert.equal(res.status, 200);

  const outcome = await result;
  assert.equal(outcome.action, 'accept');
  assert.deepEqual(outcome.content, {
    email: 'dev@example.com',
    replicas: 3, // coerced from string
    urgent: true,
    tier: 'pro',
    tags: ['x', 'z'],
    notes: 'ship it',
  });
});

test('re-renders with errors and keeps input when validation fails', async () => {
  const fields = [
    field({ name: 'email', label: 'Contact', format: 'email', required: true }),
    field({ name: 'replicas', type: 'integer', minimum: 1, maximum: 5 }),
  ];
  const { url, result } = await server.createPrompt({ ...BASE, fields }, 10_000);
  const token = /name="__token" value="([^"]+)"/.exec(await (await fetch(url)).text())[1];

  const bad = await post(url, [
    ['__token', token],
    ['__intent', 'accept'],
    ['email', 'not-an-email'],
    ['replicas', '99'],
  ]);
  assert.equal(bad.status, 400);
  const html = await bad.text();
  assert.match(html, /Contact must be a valid email address/);
  assert.match(html, /must be at most 5/);
  assert.match(html, /value="not-an-email"/, 'should preserve what the user typed');

  // Still open: a failed submit must not settle the promise.
  const good = await post(url, [
    ['__token', token],
    ['__intent', 'accept'],
    ['email', 'dev@example.com'],
    ['replicas', '4'],
  ]);
  assert.equal(good.status, 200);
  assert.equal((await result).action, 'accept');
});

test('declining resolves as a denial', async () => {
  const { url, result } = await server.createPrompt({ ...BASE, kind: 'confirm', fields: [] }, 10_000);
  const token = /name="__token" value="([^"]+)"/.exec(await (await fetch(url)).text())[1];

  await post(url, [
    ['__token', token],
    ['__intent', 'decline'],
  ]);
  assert.equal((await result).action, 'decline');
});

test('rejects a wrong or missing token', async () => {
  const { url } = await server.createPrompt({ ...BASE, fields: [] }, 10_000);
  const noToken = url.split('?')[0];

  assert.equal((await fetch(noToken)).status, 403);
  assert.equal((await fetch(`${noToken}?t=wrong`)).status, 403);
  assert.equal((await post(noToken, [['__intent', 'accept']])).status, 403);
});

test('a prompt can only be answered once', async () => {
  const { url, result } = await server.createPrompt({ ...BASE, fields: [] }, 10_000);
  const token = /name="__token" value="([^"]+)"/.exec(await (await fetch(url)).text())[1];

  await post(url, [
    ['__token', token],
    ['__intent', 'accept'],
  ]);
  await result;

  // Second visit finds nothing to answer.
  assert.equal((await fetch(url)).status, 410);
});

test('times out into a cancel', async () => {
  const started = Date.now();
  const { result } = await server.createPrompt({ ...BASE, fields: [] }, 300);
  const outcome = await result;

  assert.deepEqual(outcome, { action: 'cancel', reason: 'timeout' });
  assert.ok(Date.now() - started >= 250);
});

test('escapes agent-supplied text rather than injecting it', async () => {
  const fields = [field({ name: 'x', label: '<img src=x onerror=alert(1)>' })];
  const { url } = await server.createPrompt(
    { ...BASE, title: '</title><script>alert(1)</script>', details: '<b>raw</b>', fields },
    10_000,
  );
  const page = await (await fetch(url)).text();

  assert.ok(!page.includes('<script>alert(1)</script>'), 'title must be escaped');
  assert.ok(!page.includes('<img src=x'), 'label must be escaped');
  assert.ok(!page.includes('<b>raw</b>'), 'details must be escaped');
  assert.match(page, /&lt;script&gt;/);
});

test('unknown paths 404', async () => {
  const { url } = await server.createPrompt({ ...BASE, fields: [] }, 5000);
  const origin = new URL(url).origin;
  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal((await fetch(`${origin}/p/not-a-uuid`)).status, 404);
});
