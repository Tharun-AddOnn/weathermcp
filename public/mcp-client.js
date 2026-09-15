/**
 * A minimal MCP client, small enough to read in one sitting.
 *
 * It speaks the same JSON-RPC over Streamable HTTP that an AI agent uses, so
 * the demo page is a genuine client rather than a mock-up. What it does NOT do
 * is native elicitation: this deployment is stateless, so there is no reverse
 * channel for `elicitation/create`. The server answers with
 * `status: "input_required"` plus the valid options, and the page draws the
 * form from those - the same shape a native client would receive in a schema.
 *
 * Kept free of DOM access so the logic can be unit-tested directly.
 */

export const PROTOCOL_VERSION = '2025-06-18';

/** Builds a JSON-RPC 2.0 request envelope. */
export function rpc(method, params, id) {
  return { jsonrpc: '2.0', id, method, params };
}

/** Reads a JSON-RPC payload out of either a JSON or an SSE response body. */
export function parsePayload(contentType, text) {
  if ((contentType ?? '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (!line) throw new Error('Empty event stream from the server.');
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

/** Validates a selection before it is sent. Returns a map of field -> message. */
export function validateSelection(values, options) {
  const errors = {};
  const cityValues = (options.cities ?? []).map((c) => c.value);
  const unitValues = (options.units ?? []).map((u) => u.value);

  if (!values.city) errors.city = 'Please choose a city.';
  else if (cityValues.length && !cityValues.includes(values.city))
    errors.city = 'That city is not supported.';

  if (!values.unit) errors.unit = 'Please choose a temperature unit.';
  else if (unitValues.length && !unitValues.includes(values.unit))
    errors.unit = 'That temperature unit is not supported.';

  return errors;
}

/** Turns a successful tool result into the two lines the page displays. */
export function formatResult(structured) {
  if (!structured || structured.status !== 'ok') {
    throw new Error('No weather in that response.');
  }
  const symbol = structured.unit === 'F' ? '°F' : '°C';
  return {
    headline: `Weather in ${structured.city}: ${structured.temperature}${symbol}`,
    detail: structured.condition ?? '',
  };
}

export class McpBrowserClient {
  /**
   * @param endpoint  MCP endpoint, e.g. "/mcp"
   * @param fetchImpl injected in tests
   */
  constructor(endpoint = '/mcp', fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.nextId = 1;
  }

  async call(method, params) {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(rpc(method, params, this.nextId++)),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Server returned ${res.status}. ${text.slice(0, 160)}`);

    const payload = parsePayload(res.headers.get('content-type'), text);
    if (payload.error) throw new Error(payload.error.message ?? 'The server reported an error.');
    return payload.result;
  }

  /** Handshake. Stateless deployments issue no session id, so none is tracked. */
  initialize() {
    return this.call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-elicitation-poc-frontend', version: '1.0.0' },
    });
  }

  listTools() {
    return this.call('tools/list', {});
  }

  callTool(name, args) {
    return this.call('tools/call', { name, arguments: args });
  }

  /**
   * Asks for the weather with no arguments, exactly as an agent would when the
   * user has named neither a city nor a unit. Returns either the options the
   * server wants filled in, or a finished reading.
   */
  async startWeatherRequest() {
    const result = await this.callTool('get_weather', {});
    const s = result.structuredContent ?? {};

    if (s.status === 'ok') return { kind: 'weather', structured: s };
    if (s.status === 'input_required') {
      return {
        kind: 'needs-input',
        message: result.content?.[0]?.text ?? '',
        cities: s.availableCities ?? [],
        units: s.availableUnits ?? [],
      };
    }
    if (s.status === 'awaiting_selection') {
      // The hosted server may prefer its own link flow; the page has a form
      // already, so fall back to asking for the options directly.
      return { kind: 'needs-input', message: '', cities: [], units: [], selectionUrl: s.selectionUrl };
    }
    throw new Error(result.content?.[0]?.text ?? 'Unexpected response from the server.');
  }

  /** Second call, carrying what the user picked. */
  async submitWeatherRequest({ city, unit }) {
    const result = await this.callTool('get_weather', { city, temperatureUnit: unit });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'The request was rejected.');
    return formatResult(result.structuredContent);
  }
}
