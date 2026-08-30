import type { City } from './cities.js';
import { fromCelsius, type TemperatureUnit } from './units.js';

export interface WeatherReading {
  city: string;
  temperature: number;
  unit: TemperatureUnit;
  condition: string;
  /** ISO-8601. A real provider would return its own observation timestamp. */
  observedAt: string;
}

/**
 * The seam between the MCP layer and whatever actually supplies weather.
 * Swapping the mock for a live API means implementing this one method - the
 * tool definition, elicitation flow, and validation all stay as they are.
 */
export interface WeatherService {
  getWeather(city: City, unit: TemperatureUnit): Promise<WeatherReading>;
}

export class WeatherServiceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WeatherServiceError';
  }
}

interface Observation {
  celsius: number;
  condition: string;
}

const FIXTURES: Record<string, Observation> = {
  hyderabad: { celsius: 29, condition: 'Partly cloudy' },
  bengaluru: { celsius: 24, condition: 'Cloudy' },
  mumbai: { celsius: 28, condition: 'Partly cloudy' },
  delhi: { celsius: 32, condition: 'Sunny' },
  chennai: { celsius: 30, condition: 'Sunny' },
  london: { celsius: 18, condition: 'Cloudy' },
};

/**
 * Fixed readings in Celsius, converted on the way out. Stands in for a real
 * provider so the POC has no network dependency or API key.
 */
export class MockWeatherService implements WeatherService {
  constructor(private readonly fixtures: Record<string, Observation> = FIXTURES) {}

  async getWeather(city: City, unit: TemperatureUnit): Promise<WeatherReading> {
    const observation = this.fixtures[city.id.toLowerCase()];
    if (!observation) {
      // Reachable when a city is added to the registry without a fixture - a
      // real provider would fail the same way for an unsupported location.
      throw new WeatherServiceError(`No weather data available for ${city.label}.`);
    }

    return {
      city: city.label,
      temperature: fromCelsius(observation.celsius, unit),
      unit,
      condition: observation.condition,
      observedAt: new Date().toISOString(),
    };
  }
}

/** Human-readable one-liner, e.g. "Hyderabad: 29°C, Partly cloudy". */
export function describeReading(r: WeatherReading): string {
  const symbol = r.unit === 'F' ? '°F' : '°C';
  return `${r.city}: ${r.temperature}${symbol}, ${r.condition}`;
}
