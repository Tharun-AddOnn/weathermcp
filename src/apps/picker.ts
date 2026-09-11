import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CityRegistry } from '../weather/cities.js';
import { TEMPERATURE_UNITS } from '../weather/units.js';
import { escapeHtml } from '../elicit/html.js';
import { log } from '../log.js';

/**
 * MCP Apps (SEP-1865) - the only mechanism by which an MCP server can put real
 * HTML *inside* the chat, rather than sending a schema for the client to render
 * (elicitation) or a link the user opens in a browser tab (our ticket flow).
 *
 * EXPERIMENTAL. Anthropic's rollout centres on directory connectors, and
 * ext-apps#671 reports custom connectors negotiating the UI capability and
 * having the resource fetched while no iframe ever renders. This is here to
 * find out empirically whether that is still true.
 *
 * It is purely additive: a client that ignores `_meta.ui` sees exactly the
 * behaviour it saw before, so the link flow remains the working path.
 */
export const PICKER_URI = 'ui://weather/picker.html';

/** The MIME type MCP Apps uses to mark a resource as an inline UI template. */
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

function pickerHtml(cities: { id: string; label: string }[]): string {
  const cityOptions = cities
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`)
    .join('');
  const unitOptions = TEMPERATURE_UNITS.map(
    (u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.label)}</option>`,
  ).join('');

  // Deliberately self-contained: no external scripts, fonts or styles. A host
  // renders this in a locked-down iframe, and anything fetched cross-origin
  // would simply be blocked.
  return `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:16px; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { max-width:420px; border:1px solid rgba(128,128,128,.35); border-radius:12px; padding:16px; }
  h1 { margin:0 0 4px; font-size:15px; font-weight:650; }
  p.sub { margin:0 0 14px; opacity:.7; font-size:13px; }
  label { display:block; font-weight:550; margin:12px 0 5px; }
  select { width:100%; padding:8px 10px; border-radius:8px; border:1px solid rgba(128,128,128,.4);
           background:transparent; color:inherit; font:inherit; }
  button { margin-top:16px; width:100%; padding:9px 14px; border-radius:8px; border:0;
           background:#4f46e5; color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .out { margin-top:14px; padding:10px 12px; border-radius:8px;
         background:rgba(128,128,128,.12); font-size:13px; white-space:pre-wrap; }
  .diag { margin-top:12px; font-size:11px; opacity:.55; font-family:ui-monospace,Menlo,Consolas,monospace; }
</style>
<div class="card">
  <h1>Choose your weather options</h1>
  <p class="sub">Rendered inline by the MCP host.</p>

  <label for="city">City</label>
  <select id="city">${cityOptions}</select>

  <label for="unit">Temperature unit</label>
  <select id="unit">${unitOptions}</select>

  <button id="go">Get weather</button>
  <div class="out" id="out" hidden></div>
  <div class="diag" id="diag">bridge: connecting…</div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const diag = $('diag'), out = $('out'), go = $('go');

  // Minimal MCP Apps bridge: JSON-RPC over postMessage to the host frame.
  let nextId = 1;
  const pending = new Map();

  const notify = (method, params) =>
    parent.postMessage({ jsonrpc: '2.0', method, params }, '*');

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(method + ' timed out'));
      }, 10000);
    });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message ?? 'rpc error')) : p.resolve(msg.result);
    }
  });

  const sizeChanged = () =>
    notify('ui/notifications/size-changed', { height: document.body.scrollHeight });

  go.addEventListener('click', async () => {
    go.disabled = true;
    out.hidden = false;
    out.textContent = 'Fetching…';
    try {
      const res = await request('tools/call', {
        name: 'get_weather',
        arguments: { city: $('city').value, temperatureUnit: $('unit').value },
      });
      out.textContent = res?.content?.[0]?.text ?? JSON.stringify(res);
    } catch (err) {
      out.textContent = 'Could not call the tool: ' + err.message;
    } finally {
      go.disabled = false;
      sizeChanged();
    }
  });

  // Handshake. The form is already visible and usable-looking regardless, so a
  // failed handshake still tells us whether the host rendered anything at all.
  request('ui/initialize', { capabilities: {} })
    .then(() => {
      notify('ui/notifications/initialized', {});
      diag.textContent = 'bridge: connected';
      sizeChanged();
    })
    .catch((err) => {
      diag.textContent = 'bridge: not connected (' + err.message + ')';
    });
})();
</script>`;
}

/**
 * Registers the inline picker as an MCP App resource and links `get_weather`
 * to it. A host that does not understand `_meta.ui` ignores both.
 */
export function registerPickerApp(server: McpServer, cities: CityRegistry): void {
  server.registerResource(
    'weather-picker',
    PICKER_URI,
    {
      title: 'Weather picker',
      description: 'Inline city and temperature-unit selector for get_weather.',
      mimeType: APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: PICKER_URI,
          mimeType: APP_MIME_TYPE,
          text: pickerHtml(cities.list().map((c) => ({ id: c.id, label: c.label }))),
        },
      ],
    }),
  );

  log(`registered MCP App resource ${PICKER_URI}`);
}
