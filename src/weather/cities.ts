import { readFileSync } from 'node:fs';

export interface City {
  /** Stable identifier passed to the weather tool. */
  id: string;
  /** Human-facing text shown in a dropdown or list. */
  label: string;
  country: string;
}

/**
 * The starter set. Extending the POC is a matter of adding entries here or
 * pointing `--cities <file.json>` at a JSON array of the same shape - no change
 * to the tool schema or the elicitation flow is needed.
 */
export const DEFAULT_CITIES: readonly City[] = Object.freeze([
  { id: 'hyderabad', label: 'Hyderabad', country: 'India' },
  { id: 'bengaluru', label: 'Bengaluru', country: 'India' },
  { id: 'mumbai', label: 'Mumbai', country: 'India' },
  { id: 'delhi', label: 'Delhi', country: 'India' },
  { id: 'chennai', label: 'Chennai', country: 'India' },
  { id: 'london', label: 'London', country: 'United Kingdom' },
]);

export class UnknownCityError extends Error {
  constructor(
    readonly requested: string,
    readonly known: readonly City[],
  ) {
    super(
      `Unknown city "${requested}". Supported cities: ${known.map((c) => c.label).join(', ')}.`,
    );
    this.name = 'UnknownCityError';
  }
}

/**
 * Lookup and validation for the supported cities. Resolution is deliberately
 * forgiving - a model may pass "Hyderabad", "hyderabad", or " HYDERABAD " - but
 * it never guesses at a city that is not on the list.
 */
export class CityRegistry {
  private readonly byId = new Map<string, City>();

  constructor(cities: readonly City[] = DEFAULT_CITIES) {
    for (const c of cities) this.add(c);
  }

  /** Load an extension list from a JSON file of `City` objects. */
  static fromFile(path: string): CityRegistry {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read city list at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`City list at ${path} must be a JSON array.`);

    const cities = parsed.map((entry, i) => {
      const c = entry as Partial<City>;
      if (!c || typeof c.id !== 'string' || typeof c.label !== 'string') {
        throw new Error(`City list at ${path}, entry ${i}: needs string "id" and "label".`);
      }
      return { id: c.id, label: c.label, country: typeof c.country === 'string' ? c.country : 'Unknown' };
    });

    if (cities.length === 0) throw new Error(`City list at ${path} is empty.`);
    return new CityRegistry(cities);
  }

  add(city: City): void {
    this.byId.set(city.id.toLowerCase(), city);
  }

  list(): City[] {
    return [...this.byId.values()];
  }

  /** Case- and whitespace-insensitive; also matches on the display label. */
  find(requested: string): City | undefined {
    const key = requested.trim().toLowerCase();
    const direct = this.byId.get(key);
    if (direct) return direct;
    return this.list().find((c) => c.label.toLowerCase() === key);
  }

  /** @throws UnknownCityError when the city is not supported. */
  resolve(requested: string): City {
    const found = this.find(requested);
    if (!found) throw new UnknownCityError(requested, this.list());
    return found;
  }
}
