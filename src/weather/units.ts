export type TemperatureUnit = 'C' | 'F';

export interface UnitOption {
  id: TemperatureUnit;
  label: string;
}

/** Presented as structured choices, so the user never types "celsius". */
export const TEMPERATURE_UNITS: readonly UnitOption[] = Object.freeze([
  { id: 'C', label: 'Celsius (°C)' },
  { id: 'F', label: 'Fahrenheit (°F)' },
]);

export class UnknownUnitError extends Error {
  constructor(readonly requested: string) {
    super(
      `Unknown temperature unit "${requested}". Supported units: ${TEMPERATURE_UNITS.map((u) => `${u.id} (${u.label})`).join(', ')}.`,
    );
    this.name = 'UnknownUnitError';
  }
}

/**
 * Accepts what a model or a user might realistically produce - "C", "c",
 * "celsius", "°F", "fahrenheit" - and rejects anything else rather than
 * defaulting silently to one of them.
 *
 * @throws UnknownUnitError
 */
export function resolveUnit(requested: string): TemperatureUnit {
  const key = requested.trim().toLowerCase().replace(/^°/, '');
  if (key === 'c' || key === 'celsius') return 'C';
  if (key === 'f' || key === 'fahrenheit') return 'F';
  throw new UnknownUnitError(requested);
}

/** Canonical readings are stored in Celsius; this is the only conversion point. */
export function fromCelsius(celsius: number, unit: TemperatureUnit): number {
  const value = unit === 'F' ? celsius * (9 / 5) + 32 : celsius;
  // One decimal keeps 29C -> 84.2F exact without trailing float noise.
  return Math.round(value * 10) / 10;
}

export function unitSymbol(unit: TemperatureUnit): string {
  return unit === 'F' ? '°F' : '°C';
}
