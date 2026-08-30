/**
 * The elicitation flow end to end, driven by a real MCP client that answers
 * elicitation requests the way Claude Code or VS Code Copilot would.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../dist/server.js';

const CONFIG = {
  defaultTimeoutMs: 5000,
  formHost: '127.0.0.1',
  formPort: 0,
  fallback: 'conversational',
  launchBrowser: false,
};

/** Records every call that reaches the weather provider. */
function spyService(inner) {
  const calls = [];
  return {
    calls,
    async getWeather(city, unit) {
      calls.push({ cityId: city.id, unit });
      return inner.getWeather(city, unit);
    },
  };
}

/**
 * @param answer  (params) => ElicitResult, or null for a client that cannot elicit
 */
async function connect(answer, { capabilities, overrides = {}, service } = {}) {
  const { MockWeatherService } = await import('../dist/weather/service.js');
  const weather = spyService(service ?? new MockWeatherService());
  const { server, dispose } = buildServer({ ...CONFIG, ...overrides }, undefined, weather);

  const caps = capabilities ?? (answer ? { elicitation: {} } : {});
  const client = new Client({ name: 'flow-test', version: '1.0.0' }, { capabilities: caps });

  const prompts = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params);
      return answer(req.params, prompts.length);
    });
  }

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);

  return {
    client,
    prompts,
    weather,
    cleanup: async () => {
      await client.close();
      await dispose();
      await server.close();
    },
  };
}

/** Answers each elicitation in turn with the supplied values. */
function answerWith(...values) {
  return (params, n) => {
    const key = Object.keys(params.requestedSchema.properties)[0];
    return { action: 'accept', content: { [key]: values[n - 1] } };
  };
}

// --- discovery -------------------------------------------------------------

test('the client discovers get_weather with both params optional', async () => {
  const s = await connect(answerWith());
  const { tools } = await s.client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['client_capabilities', 'get_weather', 'list_cities']);

  const weather = tools.find((t) => t.name === 'get_weather');
  assert.equal(weather.inputSchema.type, 'object');
  // Neither is required: that is what lets the model call the tool with nothing
  // and hand the questions to the server.
  assert.ok(!weather.inputSchema.required || weather.inputSchema.required.length === 0);
  assert.deepEqual(weather.inputSchema.properties.temperatureUnit.enum, ['C', 'F']);
  assert.match(weather.inputSchema.properties.city.description, /Hyderabad/);
  await s.cleanup();
});

test('list_cities exposes the ids the tool accepts', async () => {
  const s = await connect(answerWith());
  const res = await s.client.callTool({ name: 'list_cities', arguments: {} });
  assert.equal(res.structuredContent.cities.length, 6);
  assert.deepEqual(res.structuredContent.cities[0], {
    id: 'hyderabad',
    label: 'Hyderabad',
    country: 'India',
  });
  assert.deepEqual(res.structuredContent.temperatureUnits.map((u) => u.id), ['C', 'F']);
  await s.cleanup();
});

// --- the headline flow -----------------------------------------------------

test('calling with no arguments elicits city then unit, as structured choices', async () => {
  const s = await connect(answerWith('hyderabad', 'C'));
  const res = await s.client.callTool({ name: 'get_weather', arguments: {} });

  // Two sequential prompts, in the order the spec describes.
  assert.equal(s.prompts.length, 2);

  const cityProp = s.prompts[0].requestedSchema.properties.city;
  assert.match(s.prompts[0].message, /city/i);
  assert.deepEqual(cityProp.enum, ['hyderabad', 'bengaluru', 'mumbai', 'delhi', 'chennai', 'london']);
  assert.deepEqual(cityProp.enumNames, ['Hyderabad', 'Bengaluru', 'Mumbai', 'Delhi', 'Chennai', 'London']);
  assert.deepEqual(s.prompts[0].requestedSchema.required, ['city']);

  const unitProp = s.prompts[1].requestedSchema.properties.temperatureUnit;
  assert.deepEqual(unitProp.enum, ['C', 'F']);
  assert.deepEqual(unitProp.enumNames, ['Celsius (°C)', 'Fahrenheit (°F)']);

  // The selections must arrive at the provider unchanged.
  assert.deepEqual(s.weather.calls, [{ cityId: 'hyderabad', unit: 'C' }]);

  assert.equal(res.structuredContent.status, 'ok');
  assert.equal(res.structuredContent.city, 'Hyderabad');
  assert.equal(res.structuredContent.temperature, 29);
  assert.equal(res.structuredContent.unit, 'C');
  assert.equal(res.structuredContent.condition, 'Partly cloudy');
  assert.equal(res.structuredContent.channel, 'elicitation-form');
  assert.match(res.content[0].text, /Hyderabad: 29°C, Partly cloudy|29°C, Partly cloudy/);
  await s.cleanup();
});

test('only the missing parameter is elicited', async () => {
  // City supplied -> one prompt, for the unit only.
  const s = await connect(answerWith('F'));
  const res = await s.client.callTool({ name: 'get_weather', arguments: { city: 'London' } });

  assert.equal(s.prompts.length, 1);
  assert.ok(s.prompts[0].requestedSchema.properties.temperatureUnit);
  assert.equal(res.structuredContent.temperature, 64.4); // 18C -> 64.4F
  assert.equal(res.structuredContent.unit, 'F');
  await s.cleanup();
});

test('nothing is elicited when both parameters are supplied', async () => {
  const s = await connect(answerWith());
  const res = await s.client.callTool({
    name: 'get_weather',
    arguments: { city: 'delhi', temperatureUnit: 'F' },
  });

  assert.equal(s.prompts.length, 0, 'must not prompt for what it already knows');
  assert.equal(res.structuredContent.temperature, 89.6); // 32C -> 89.6F
  assert.deepEqual(s.weather.calls, [{ cityId: 'delhi', unit: 'F' }]);
  await s.cleanup();
});

// --- refusal ---------------------------------------------------------------

test('declining or cancelling stops the tool without calling the provider', async () => {
  for (const action of ['decline', 'cancel']) {
    const s = await connect(() => ({ action }));
    const res = await s.client.callTool({ name: 'get_weather', arguments: {} });

    assert.equal(res.structuredContent.status, 'cancelled');
    assert.equal(s.weather.calls.length, 0, 'no weather lookup after a refusal');
    assert.match(res.content[0].text, /Do not retry/);
    await s.cleanup();
  }
});

// --- validation ------------------------------------------------------------

test('an unsupported city is rejected with the list of valid ones', async () => {
  const s = await connect(answerWith());
  const res = await s.client.callTool({ name: 'get_weather', arguments: { city: 'Paris' } });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown city "Paris"/);
  assert.match(res.content[0].text, /Hyderabad, Bengaluru/);
  assert.equal(s.weather.calls.length, 0);
  await s.cleanup();
});

test('an unsupported unit is rejected by the schema, before the handler runs', async () => {
  // Two validation layers by design: the unit is a closed set so it is an enum
  // in the tool schema and the protocol rejects anything else; the city list is
  // extensible, so it cannot be an enum and is validated in the handler instead.
  const s = await connect(answerWith());

  const res = await s.client.callTool({
    name: 'get_weather',
    arguments: { city: 'mumbai', temperatureUnit: 'kelvin' },
  });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Input validation error/);
  assert.match(res.content[0].text, /expected one of "C"\|"F"/);
  assert.equal(s.prompts.length, 0, 'must not prompt for an invalid call');
  assert.equal(s.weather.calls.length, 0);
  await s.cleanup();
});

test('the handler still normalises unit spellings that reach it', async () => {
  // Defence in depth for values arriving from an elicitation response rather
  // than from the validated tool arguments.
  const { resolveUnit } = await import('../dist/weather/units.js');
  assert.equal(resolveUnit('Celsius'), 'C');
  assert.equal(resolveUnit('fahrenheit'), 'F');
});

test('a provider failure becomes a clean tool error, not a crash', async () => {
  const { WeatherServiceError } = await import('../dist/weather/service.js');
  const broken = {
    async getWeather() {
      throw new WeatherServiceError('upstream timed out');
    },
  };
  const s = await connect(answerWith(), { service: broken });
  const res = await s.client.callTool({
    name: 'get_weather',
    arguments: { city: 'chennai', temperatureUnit: 'C' },
  });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not retrieve weather: upstream timed out/);
  await s.cleanup();
});

test('an unexpected provider crash is still reported cleanly', async () => {
  const s = await connect(answerWith(), {
    service: {
      async getWeather() {
        throw new TypeError('boom');
      },
    },
  });
  const res = await s.client.callTool({
    name: 'get_weather',
    arguments: { city: 'chennai', temperatureUnit: 'C' },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unexpected error while retrieving weather: boom/);
  await s.cleanup();
});

// --- the universal fallback ------------------------------------------------

test('a client without elicitation gets a structured input_required result', async () => {
  const s = await connect(null); // no elicitation capability at all
  const res = await s.client.callTool({ name: 'get_weather', arguments: {} });

  assert.equal(res.isError, undefined, 'this is a normal result, not an error');
  assert.equal(res.structuredContent.status, 'input_required');
  assert.deepEqual(res.structuredContent.missing, ['city', 'temperatureUnit']);
  assert.equal(res.structuredContent.channel, 'conversational');

  // The model needs the options to be able to ask a useful question.
  assert.equal(res.structuredContent.availableCities.length, 6);
  assert.deepEqual(res.structuredContent.availableUnits.map((u) => u.value), ['C', 'F']);
  assert.match(res.content[0].text, /ask in chat/i);
  assert.match(res.content[0].text, /call get_weather again/i);
  assert.equal(s.weather.calls.length, 0);
  await s.cleanup();
});

test('the fallback narrows to just the parameter that is missing', async () => {
  const s = await connect(null);
  const res = await s.client.callTool({ name: 'get_weather', arguments: { city: 'mumbai' } });

  assert.deepEqual(res.structuredContent.missing, ['temperatureUnit']);
  assert.equal(res.structuredContent.availableCities, undefined, 'city is already known');
  assert.deepEqual(res.structuredContent.availableUnits.map((u) => u.value), ['C', 'F']);
  await s.cleanup();
});

test('the second call, with the answer, completes normally', async () => {
  // Simulates the model asking in chat and calling back with what it learned.
  const s = await connect(null);
  const first = await s.client.callTool({ name: 'get_weather', arguments: {} });
  assert.equal(first.structuredContent.status, 'input_required');

  const second = await s.client.callTool({
    name: 'get_weather',
    arguments: { city: 'hyderabad', temperatureUnit: 'C' },
  });
  assert.equal(second.structuredContent.status, 'ok');
  assert.equal(second.structuredContent.temperature, 29);
  await s.cleanup();
});

// --- server vs client capability ------------------------------------------

test('client_capabilities separates what the server offers from what the client renders', async () => {
  const withUi = await connect(answerWith());
  let res = await withUi.client.callTool({ name: 'client_capabilities', arguments: {} });
  assert.equal(res.structuredContent.clientSupportsElicitationForm, true);
  assert.equal(res.structuredContent.channel, 'elicitation-form');
  assert.match(res.structuredContent.rendering, /native selection dialog/i);
  assert.ok(res.structuredContent.serverOffers.includes('elicitation/create (form)'));
  await withUi.cleanup();

  const withoutUi = await connect(null);
  res = await withoutUi.client.callTool({ name: 'client_capabilities', arguments: {} });
  assert.equal(res.structuredContent.clientSupportsElicitationForm, false);
  assert.equal(res.structuredContent.channel, 'conversational');
  assert.match(res.structuredContent.rendering, /No interactive UI/i);
  // The server still advertises elicitation - the gap is on the client side.
  assert.ok(res.structuredContent.serverOffers.includes('elicitation/create (form)'));
  await withoutUi.cleanup();
});
