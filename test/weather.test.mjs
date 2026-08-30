/**
 * The weather domain in isolation - no MCP involved. These are the pieces that
 * get replaced when a real provider is wired in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CityRegistry, UnknownCityError, DEFAULT_CITIES } from '../dist/weather/cities.js';
import { resolveUnit, fromCelsius, UnknownUnitError, TEMPERATURE_UNITS } from '../dist/weather/units.js';
import { MockWeatherService, WeatherServiceError, describeReading } from '../dist/weather/service.js';

test('ships the six starter cities', () => {
  const labels = new CityRegistry().list().map((c) => c.label);
  assert.deepEqual(labels, ['Hyderabad', 'Bengaluru', 'Mumbai', 'Delhi', 'Chennai', 'London']);
  assert.equal(DEFAULT_CITIES.length, 6);
});

test('city lookup tolerates case and whitespace but never guesses', () => {
  const reg = new CityRegistry();
  assert.equal(reg.resolve('hyderabad').label, 'Hyderabad');
  assert.equal(reg.resolve('  HYDERABAD ').label, 'Hyderabad');
  assert.equal(reg.resolve('Hyderabad').id, 'hyderabad');

  assert.throws(() => reg.resolve('Paris'), UnknownCityError);
  // The error must name the alternatives so the model can recover.
  assert.throws(() => reg.resolve('Paris'), /Supported cities: Hyderabad, Bengaluru/);
});

test('the city list is extensible at runtime and from a file', () => {
  const reg = new CityRegistry();
  reg.add({ id: 'porto', label: 'Porto', country: 'Portugal' });
  assert.equal(reg.resolve('porto').country, 'Portugal');
  assert.equal(reg.list().length, 7);

  const dir = mkdtempSync(join(tmpdir(), 'cities-'));
  const file = join(dir, 'cities.json');
  writeFileSync(file, JSON.stringify([{ id: 'oslo', label: 'Oslo', country: 'Norway' }]));

  const loaded = CityRegistry.fromFile(file);
  assert.equal(loaded.list().length, 1);
  assert.equal(loaded.resolve('Oslo').id, 'oslo');
});

test('a malformed city file fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cities-'));
  const notArray = join(dir, 'a.json');
  writeFileSync(notArray, '{"id":"x"}');
  assert.throws(() => CityRegistry.fromFile(notArray), /must be a JSON array/);

  const missingLabel = join(dir, 'b.json');
  writeFileSync(missingLabel, '[{"id":"x"}]');
  assert.throws(() => CityRegistry.fromFile(missingLabel), /needs string "id" and "label"/);

  assert.throws(() => CityRegistry.fromFile(join(dir, 'nope.json')), /Could not read city list/);
});

test('unit parsing accepts what a model or user would realistically send', () => {
  for (const input of ['C', 'c', 'Celsius', ' celsius ', '°C']) {
    assert.equal(resolveUnit(input), 'C', `${input} should resolve to C`);
  }
  for (const input of ['F', 'f', 'Fahrenheit', '°F']) {
    assert.equal(resolveUnit(input), 'F', `${input} should resolve to F`);
  }
  assert.throws(() => resolveUnit('kelvin'), UnknownUnitError);
  assert.throws(() => resolveUnit(''), UnknownUnitError);
  assert.deepEqual(TEMPERATURE_UNITS.map((u) => u.id), ['C', 'F']);
});

test('celsius to fahrenheit conversion', () => {
  // The worked example from the spec.
  assert.equal(fromCelsius(29, 'F'), 84.2);
  assert.equal(fromCelsius(29, 'C'), 29);
  assert.equal(fromCelsius(0, 'F'), 32);
  assert.equal(fromCelsius(100, 'F'), 212);
  assert.equal(fromCelsius(-40, 'F'), -40);
  assert.equal(fromCelsius(18, 'F'), 64.4);
});

test('mock service returns the documented fixtures', async () => {
  const svc = new MockWeatherService();
  const reg = new CityRegistry();

  const expected = [
    ['hyderabad', 29, 'Partly cloudy'],
    ['bengaluru', 24, 'Cloudy'],
    ['mumbai', 28, 'Partly cloudy'],
    ['delhi', 32, 'Sunny'],
    ['chennai', 30, 'Sunny'],
    ['london', 18, 'Cloudy'],
  ];

  for (const [id, celsius, condition] of expected) {
    const r = await svc.getWeather(reg.resolve(id), 'C');
    assert.equal(r.temperature, celsius);
    assert.equal(r.condition, condition);
    assert.equal(r.unit, 'C');
    assert.ok(!Number.isNaN(Date.parse(r.observedAt)), 'observedAt must be a real timestamp');
  }

  const f = await svc.getWeather(reg.resolve('hyderabad'), 'F');
  assert.equal(f.temperature, 84.2);
  assert.equal(describeReading(f), 'Hyderabad: 84.2°F, Partly cloudy');
});

test('a city with no fixture surfaces a service error', async () => {
  const svc = new MockWeatherService();
  await assert.rejects(
    () => svc.getWeather({ id: 'atlantis', label: 'Atlantis', country: '?' }, 'C'),
    WeatherServiceError,
  );
});
