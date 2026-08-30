import { z } from 'zod';
import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js';

/** A single option for select / multiselect fields. */
export const optionSchema = z.union([
  z.string(),
  z.object({
    value: z.string().describe('Value returned when this option is picked.'),
    label: z.string().optional().describe('Human-facing text. Defaults to the value.'),
  }),
]);

/**
 * The field vocabulary an agent uses to describe one input it wants from the user.
 *
 * Deliberately flat: MCP elicitation only permits a top-level object of primitives,
 * so nesting is impossible to render natively. Anything richer would silently
 * degrade on real clients.
 */
export const fieldSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be a valid identifier (letters, digits, underscore).')
    .describe('Key this answer appears under in the returned object.'),
  type: z
    .enum(['string', 'number', 'integer', 'boolean', 'select', 'multiselect'])
    .default('string')
    .describe('Input kind. "select" is one-of; "multiselect" is any-of.'),
  label: z.string().optional().describe('Short human-facing label. Defaults to the field name.'),
  description: z.string().optional().describe('Helper text shown under the field.'),
  required: z.boolean().optional().default(false),
  options: z.array(optionSchema).optional().describe('Required for select / multiselect.'),
  default: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional()
    .describe('Pre-filled value.'),
  format: z
    .enum(['email', 'uri', 'date', 'date-time'])
    .optional()
    .describe('String sub-format; drives validation and input type.'),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minItems: z.number().int().nonnegative().optional().describe('multiselect only.'),
  maxItems: z.number().int().positive().optional().describe('multiselect only.'),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Render as a textarea in the browser form. Native elicitation has no textarea, so elicitation-capable clients show a single-line input.',
    ),
});

export type FieldSpec = z.infer<typeof fieldSchema>;
export type NormalizedOption = { value: string; label: string };

export function normalizeOptions(field: FieldSpec): NormalizedOption[] {
  return (field.options ?? []).map((o) =>
    typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value },
  );
}

export function labelFor(field: FieldSpec): string {
  return field.label ?? field.name;
}

/** Throws on field definitions that cannot be rendered, so the agent gets a clear error. */
export function validateFields(fields: FieldSpec[]): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.name)) throw new Error(`Duplicate field name: "${f.name}".`);
    seen.add(f.name);
    if (f.type === 'select' || f.type === 'multiselect') {
      const opts = normalizeOptions(f);
      if (opts.length === 0) {
        throw new Error(`Field "${f.name}" is a ${f.type} and needs a non-empty "options" array.`);
      }
      if (new Set(opts.map((o) => o.value)).size !== opts.length) {
        throw new Error(`Field "${f.name}" has duplicate option values.`);
      }
    }
  }
}

/**
 * Convert our field list into the restricted JSON Schema subset that
 * `elicitation/create` accepts (flat object, primitives only).
 */
export function toElicitationSchema(fields: FieldSpec[]): {
  type: 'object';
  properties: Record<string, PrimitiveSchemaDefinition>;
  required?: string[];
} {
  const properties: Record<string, PrimitiveSchemaDefinition> = {};
  const required: string[] = [];

  for (const f of fields) {
    const base = { title: labelFor(f), description: f.description };
    let prop: Record<string, unknown>;

    switch (f.type) {
      case 'boolean':
        prop = { type: 'boolean', ...base, default: f.default };
        break;

      case 'number':
      case 'integer':
        prop = { type: f.type, ...base, minimum: f.minimum, maximum: f.maximum, default: f.default };
        break;

      case 'select': {
        const opts = normalizeOptions(f);
        const hasLabels = opts.some((o) => o.label !== o.value);
        // The spec's newer titled form is `oneOf: [{const,title}]`, but `enum` +
        // `enumNames` is what shipping clients actually render today, and it is
        // still accepted by the current schema. Revisit once adoption catches up.
        prop = {
          type: 'string',
          ...base,
          enum: opts.map((o) => o.value),
          ...(hasLabels ? { enumNames: opts.map((o) => o.label) } : {}),
          default: f.default,
        };
        break;
      }

      case 'multiselect': {
        const opts = normalizeOptions(f);
        const hasLabels = opts.some((o) => o.label !== o.value);
        prop = {
          type: 'array',
          ...base,
          // Labels cannot ride along on the untitled array form, so fold them
          // into the description rather than dropping them entirely.
          description: hasLabels
            ? [f.description, `Options: ${opts.map((o) => `${o.value} (${o.label})`).join(', ')}`]
                .filter(Boolean)
                .join(' — ')
            : f.description,
          items: { type: 'string', enum: opts.map((o) => o.value) },
          minItems: f.minItems,
          maxItems: f.maxItems,
          default: f.default,
        };
        break;
      }

      case 'string':
      default:
        prop = {
          type: 'string',
          ...base,
          minLength: f.minLength,
          maxLength: f.maxLength,
          format: f.format,
          default: f.default,
        };
        break;
    }

    properties[f.name] = stripUndefined(prop) as PrimitiveSchemaDefinition;
    if (f.required) required.push(f.name);
  }

  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export type AnswerValue = string | number | boolean | string[];

/**
 * Coerce and validate raw values (from the browser form, where everything is a
 * string) against the field specs. Returns typed values or a list of problems.
 */
export function coerceAndValidate(
  fields: FieldSpec[],
  raw: Record<string, unknown>,
): { ok: true; values: Record<string, AnswerValue> } | { ok: false; errors: string[] } {
  const values: Record<string, AnswerValue> = {};
  const errors: string[] = [];

  for (const f of fields) {
    const label = labelFor(f);
    const v = raw[f.name];
    const missing = v === undefined || v === null || v === '';

    if (missing && f.type !== 'boolean' && f.type !== 'multiselect') {
      if (f.required) errors.push(`${label} is required.`);
      continue;
    }

    switch (f.type) {
      case 'boolean':
        values[f.name] = v === true || v === 'true' || v === 'on' || v === '1';
        break;

      case 'number':
      case 'integer': {
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        if (Number.isNaN(n)) {
          errors.push(`${label} must be a number.`);
          break;
        }
        if (f.type === 'integer' && !Number.isInteger(n)) {
          errors.push(`${label} must be a whole number.`);
          break;
        }
        if (f.minimum !== undefined && n < f.minimum) errors.push(`${label} must be at least ${f.minimum}.`);
        if (f.maximum !== undefined && n > f.maximum) errors.push(`${label} must be at most ${f.maximum}.`);
        values[f.name] = n;
        break;
      }

      case 'select': {
        const allowed = new Set(normalizeOptions(f).map((o) => o.value));
        const s = String(v);
        if (!allowed.has(s)) errors.push(`${label} must be one of: ${[...allowed].join(', ')}.`);
        else values[f.name] = s;
        break;
      }

      case 'multiselect': {
        const arr = Array.isArray(v) ? v.map(String) : missing ? [] : [String(v)];
        const allowed = new Set(normalizeOptions(f).map((o) => o.value));
        const bad = arr.filter((x) => !allowed.has(x));
        if (bad.length) errors.push(`${label} has invalid selection(s): ${bad.join(', ')}.`);
        if (f.required && arr.length === 0) errors.push(`${label} requires at least one selection.`);
        if (f.minItems !== undefined && arr.length < f.minItems)
          errors.push(`${label} needs at least ${f.minItems} selection(s).`);
        if (f.maxItems !== undefined && arr.length > f.maxItems)
          errors.push(`${label} allows at most ${f.maxItems} selection(s).`);
        values[f.name] = arr;
        break;
      }

      case 'string':
      default: {
        const s = String(v);
        if (f.minLength !== undefined && s.length < f.minLength)
          errors.push(`${label} must be at least ${f.minLength} characters.`);
        if (f.maxLength !== undefined && s.length > f.maxLength)
          errors.push(`${label} must be at most ${f.maxLength} characters.`);
        if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
          errors.push(`${label} must be a valid email address.`);
        if (f.format === 'uri' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s))
          errors.push(`${label} must be a valid URL.`);
        values[f.name] = s;
        break;
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, values };
}
