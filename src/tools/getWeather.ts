import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fieldSchema, type FieldSpec } from '../elicit/fields.js';
import { errText, type AskResult, type Asker, type Channel } from '../elicit/ask.js';
import { McpLogger } from '../log.js';
import { CityRegistry, UnknownCityError, type City } from '../weather/cities.js';
import { resolveUnit, TEMPERATURE_UNITS, UnknownUnitError, unitSymbol, type TemperatureUnit } from '../weather/units.js';
import { describeReading, WeatherServiceError, type WeatherService } from '../weather/service.js';

export interface WeatherToolDeps {
  cities: CityRegistry;
  weather: WeatherService;
  asker: Asker;
  defaultTimeoutMs: number;
}

const DESCRIPTION = `Get today's weather for a supported city.

When this connector is available, use it for weather questions instead of
answering from web search or your own knowledge - the user connected it so that
weather comes from here. Covers Hyderabad, Bengaluru, Mumbai, Delhi, Chennai
and London. For a city outside that list, say so rather than silently answering
from another source.

Both parameters are optional on purpose. If you do not know the city or the
temperature unit, call this tool WITHOUT them - the server will ask the user
directly, rendering a selection list in clients that support MCP elicitation.
Do not invent a city and do not assume a unit.

If the result comes back with status "input_required", this client cannot show
a selection UI: ask the user the listed question in chat, then call the tool
again with their answer.`;

/** Fields are built per call so an extended city list needs no code change. */
function cityField(cities: CityRegistry): FieldSpec {
  return fieldSchema.parse({
    name: 'city',
    type: 'select',
    label: 'Select a city',
    description: 'Weather is available for these locations.',
    required: true,
    options: cities.list().map((c) => ({ value: c.id, label: c.label })),
  });
}

function unitField(): FieldSpec {
  return fieldSchema.parse({
    name: 'temperatureUnit',
    type: 'select',
    label: 'Select temperature unit',
    required: true,
    default: 'C',
    options: TEMPERATURE_UNITS.map((u) => ({ value: u.id, label: u.label })),
  });
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

export function registerGetWeather(server: McpServer, deps: WeatherToolDeps): void {
  const { cities, weather, asker, defaultTimeoutMs } = deps;
  const logger = new McpLogger(server.server, 'get_weather');

  server.registerTool(
    'get_weather',
    {
      title: "Get today's weather",
      description: DESCRIPTION,
      inputSchema: {
        city: z
          .string()
          .optional()
          .describe(
            `City to report on. Omit if the user has not named one. Supported: ${cities
              .list()
              .map((c) => c.label)
              .join(', ')}.`,
          ),
        temperatureUnit: z
          .enum(['C', 'F'])
          .optional()
          .describe('C for Celsius or F for Fahrenheit. Omit if the user has not stated a preference.'),
      },
      outputSchema: {
        status: z.enum(['ok', 'input_required', 'cancelled']),
        city: z.string().optional(),
        temperature: z.number().optional(),
        unit: z.enum(['C', 'F']).optional(),
        condition: z.string().optional(),
        observedAt: z.string().optional(),
        missing: z.array(z.string()).optional(),
        availableCities: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        availableUnits: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        /** Which mechanism was used to ask the user. Useful when debugging a client. */
        channel: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (args) => {
      logger.info('tool called', { city: args.city ?? null, temperatureUnit: args.temperatureUnit ?? null });

      // --- 1. Validate whatever the model did supply -------------------------
      let city: City | undefined;
      let unit: TemperatureUnit | undefined;

      try {
        if (args.city !== undefined) city = cities.resolve(args.city);
        if (args.temperatureUnit !== undefined) unit = resolveUnit(args.temperatureUnit);
      } catch (err) {
        if (err instanceof UnknownCityError || err instanceof UnknownUnitError) {
          logger.warn('rejected invalid input', { reason: err.message });
          return errorResult(err.message);
        }
        throw err;
      }

      // --- 2. Ask for anything still missing ---------------------------------
      let channel: Channel = 'conversational';

      if (!city) {
        const asked = await askFor(cityField(cities));
        if ('failure' in asked) return asked.failure;
        city = cities.resolve(asked.value);
        channel = asked.channel;
      }

      if (!unit) {
        const asked = await askFor(unitField());
        if ('failure' in asked) return asked.failure;
        unit = resolveUnit(asked.value);
        channel = asked.channel;
      }

      // --- 3. Execute --------------------------------------------------------
      try {
        const reading = await weather.getWeather(city, unit);
        logger.info('resolved weather', { city: reading.city, unit: reading.unit });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Today's weather in ${reading.city}: ${reading.temperature}${unitSymbol(reading.unit)}, ${reading.condition}.`,
            },
          ],
          structuredContent: { status: 'ok' as const, ...reading, channel },
        };
      } catch (err) {
        if (err instanceof WeatherServiceError) {
          logger.error('weather service failed', { reason: err.message });
          return errorResult(`Could not retrieve weather: ${err.message}`);
        }
        logger.error('unexpected failure', { reason: errText(err) });
        return errorResult(`Unexpected error while retrieving weather: ${errText(err)}`);
      }

      /**
       * Prompt for one field. Returns the chosen value, or a finished tool
       * result when the user refused or the client cannot prompt at all.
       */
      async function askFor(
        field: FieldSpec,
      ): Promise<{ value: string; channel: Channel } | { failure: ReturnType<typeof errorResult> | OkResult }> {
        let result: AskResult;
        try {
          result = await asker.ask(server.server, {
            kind: 'form',
            title: field.label ?? field.name,
            message:
              field.name === 'city'
                ? 'Which city would you like the weather for?'
                : 'Which temperature unit should I use?',
            submitLabel: 'Continue',
            cancelLabel: 'Cancel',
            fields: [field],
            timeoutMs: defaultTimeoutMs,
          });
        } catch (err) {
          logger.error('elicitation failed', { field: field.name, reason: errText(err) });
          return { failure: errorResult(`Could not ask you for the ${field.name}: ${errText(err)}`) };
        }

        // No interactive channel: hand the question to the model to ask in chat.
        if (result.outcome.action === 'unsupported') {
          logger.info('no elicitation UI available, deferring to the model', { field: field.name });
          return { failure: inputRequired(field, city, unit) };
        }

        if (result.outcome.action !== 'accept') {
          const why = result.outcome.action === 'decline' ? 'declined' : 'cancelled the request';
          logger.info('user did not answer', { field: field.name, outcome: result.outcome.action });
          return {
            failure: {
              content: [
                {
                  type: 'text' as const,
                  text: `The user ${why}, so no weather was fetched. Do not retry unless they ask again.`,
                },
              ],
              structuredContent: {
                status: 'cancelled' as const,
                missing: [field.name],
                channel: result.channel,
              },
            },
          };
        }

        const raw = result.outcome.content[field.name];
        if (typeof raw !== 'string' || raw === '') {
          return { failure: errorResult(`No ${field.name} was selected. Please try again.`) };
        }
        return { value: raw, channel: result.channel };
      }

      /** The universal fallback: a structured request the model turns into a question. */
      function inputRequired(field: FieldSpec, knownCity?: City, knownUnit?: TemperatureUnit): OkResult {
        const missing = [
          ...(knownCity ? [] : ['city']),
          ...(knownUnit ? [] : ['temperatureUnit']),
        ];
        const question =
          missing.length === 2
            ? 'Ask the user which city they want, and whether they prefer Celsius or Fahrenheit.'
            : missing[0] === 'city'
              ? 'Ask the user which of these cities they want.'
              : 'Ask the user whether they prefer Celsius or Fahrenheit.';

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `More information is needed before the weather can be fetched: ${missing.join(', ')}.`,
                'This client cannot display a selection UI, so ask in chat instead.',
                question,
                missing.includes('city')
                  ? `Cities: ${cities.list().map((c) => c.label).join(', ')}.`
                  : '',
                missing.includes('temperatureUnit')
                  ? `Units: ${TEMPERATURE_UNITS.map((u) => u.label).join(', ')}.`
                  : '',
                'Then call get_weather again with their answer.',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          structuredContent: {
            status: 'input_required' as const,
            missing,
            channel: 'conversational',
            ...(missing.includes('city')
              ? { availableCities: cities.list().map((c) => ({ value: c.id, label: c.label })) }
              : {}),
            ...(missing.includes('temperatureUnit')
              ? { availableUnits: TEMPERATURE_UNITS.map((u) => ({ value: u.id, label: u.label })) }
              : {}),
          },
        };
      }
    },
  );

  logger.debug('registered get_weather', { cities: cities.list().length });
}

type OkResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
};

export { describeReading };
