import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fieldSchema, type FieldSpec } from '../elicit/fields.js';
import { errText, type Asker, type Channel } from '../elicit/ask.js';
import { McpLogger } from '../log.js';
import { CityRegistry, UnknownCityError, type City } from '../weather/cities.js';
import { resolveUnit, TEMPERATURE_UNITS, UnknownUnitError, unitSymbol, type TemperatureUnit } from '../weather/units.js';
import { describeReading, WeatherServiceError, type WeatherService } from '../weather/service.js';
import { formPathFor } from '../ticket/form.js';
import type { TicketStore } from '../ticket/store.js';

export interface TicketConfig {
  store: TicketStore;
  /** Public origin the selection link is built from. */
  baseUrl: string;
  ttlMs: number;
}

export interface WeatherToolDeps {
  cities: CityRegistry;
  weather: WeatherService;
  asker: Asker;
  defaultTimeoutMs: number;
  /**
   * Enables the link-to-form flow for clients that cannot elicit: one call hands
   * out a URL with real dropdowns, a later call redeems the ticket. Omit to fall
   * back to asking in chat.
   */
  tickets?: TicketConfig;
}

const DESCRIPTION = `Get today's weather for a supported city.

When this connector is available, use it for weather questions instead of
answering from web search or your own knowledge - the user connected it so that
weather comes from here. Covers Hyderabad, Bengaluru, Mumbai, Delhi, Chennai
and London. For a city outside that list, say so rather than silently answering
from another source.

Both parameters are optional on purpose, and omitting them is the normal case.

Pass "city" ONLY when the user named a city in their own message, in this
conversation. Do NOT fill it in from their location, timezone, IP, account
profile, or an earlier answer - and do not carry it over from a previous call.
Pass "temperatureUnit" ONLY when the user stated a preference in words.

"What's the weather?" names no city and states no unit, so it must be called as
get_weather() with no arguments at all. Guessing defeats the point: the server
is what asks the user. When in doubt, leave the argument out.

Three things can come back instead of weather:
- "awaiting_selection": show the user selectionUrl as a clickable link and ask
  them to pick there. When they say they are done, call get_weather again with
  the ticket value and nothing else.
- "input_required": no selection UI is possible, so ask the listed question in
  chat and call again with their answer.
- "cancelled": the user declined. Stop and tell them, do not retry.`;

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

function result(text: string, structured: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], structuredContent: structured };
}

export function registerGetWeather(server: McpServer, deps: WeatherToolDeps): void {
  const { cities, weather, asker, defaultTimeoutMs, tickets } = deps;
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
        ticket: z
          .string()
          .optional()
          .describe(
            'Only when a previous call returned status "awaiting_selection": pass its ticket back ' +
              'once the user says they have submitted the form. Never invent one.',
          ),
      },
      outputSchema: {
        status: z.enum(['ok', 'input_required', 'awaiting_selection', 'cancelled']),
        city: z.string().optional(),
        temperature: z.number().optional(),
        unit: z.enum(['C', 'F']).optional(),
        condition: z.string().optional(),
        observedAt: z.string().optional(),
        missing: z.array(z.string()).optional(),
        selectionUrl: z.string().optional(),
        ticket: z.string().optional(),
        availableCities: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        availableUnits: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        /** Which mechanism was used to ask the user. Useful when debugging a client. */
        channel: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (args) => {
      logger.info('tool called', {
        city: args.city ?? null,
        temperatureUnit: args.temperatureUnit ?? null,
        ticket: args.ticket ?? null,
      });

      let city: City | undefined;
      let unit: TemperatureUnit | undefined;
      let channel: Channel = 'conversational';

      // --- 1. Redeem a selection ticket, if one was handed back --------------
      if (args.ticket) {
        if (!tickets) {
          return errorResult('This deployment does not issue selection links, so there is no ticket to redeem.');
        }

        const ticket = await tickets.store.get(args.ticket);
        if (!ticket) {
          return errorResult(
            'That selection link has expired or was already used. Call get_weather with no arguments to start again.',
          );
        }

        if (ticket.status === 'cancelled') {
          logger.info('ticket cancelled by user', { ticket: ticket.id });
          return result('The user cancelled the selection. Do not retry unless they ask again.', {
            status: 'cancelled',
            channel: 'browser',
          });
        }

        if (ticket.status === 'pending') {
          logger.info('ticket not yet submitted', { ticket: ticket.id });
          return result(
            'The user has not submitted the form yet. Ask them to open the link and choose, then call get_weather again with the same ticket.',
            {
              status: 'awaiting_selection',
              ticket: ticket.id,
              selectionUrl: `${tickets.baseUrl}${formPathFor(ticket)}`,
              channel: 'browser',
            },
          );
        }

        // Context first, then the answer - the page only asked about what was
        // missing, so anything known earlier has to come back from the ticket.
        const answer = { ...(ticket.context ?? {}), ...(ticket.answer ?? {}) };
        try {
          if (typeof answer.city === 'string') city = cities.resolve(answer.city);
          if (typeof answer.temperatureUnit === 'string') unit = resolveUnit(answer.temperatureUnit);
        } catch (err) {
          return errorResult(`The submitted selection was not usable: ${errText(err)}`);
        }
        channel = 'browser';
        logger.info('ticket redeemed', { ticket: ticket.id, city: city?.id, unit });
      }

      // --- 2. Validate whatever the model supplied directly ------------------
      try {
        if (!city && args.city !== undefined) city = cities.resolve(args.city);
        if (!unit && args.temperatureUnit !== undefined) unit = resolveUnit(args.temperatureUnit);
      } catch (err) {
        if (err instanceof UnknownCityError || err instanceof UnknownUnitError) {
          logger.warn('rejected invalid input', { reason: err.message });
          return errorResult(err.message);
        }
        throw err;
      }

      // --- 3. Ask for anything still missing ---------------------------------
      const missing: FieldSpec[] = [];
      if (!city) missing.push(cityField(cities));
      if (!unit) missing.push(unitField());

      if (missing.length > 0) {
        const planned = asker.channelFor(server.server);

        // No interactive channel, but we can put the dropdowns on a web page and
        // hand the user a link. One form for everything missing, not one each.
        if (planned === 'conversational' && tickets) {
          try {
            const ticket = await tickets.store.create({
              title: 'Choose your weather options',
              message: 'Pick a city and a temperature unit, then continue.',
              fields: missing,
              ttlMs: tickets.ttlMs,
              context: {
                ...(city ? { city: city.id } : {}),
                ...(unit ? { temperatureUnit: unit } : {}),
              },
            });
            const url = `${tickets.baseUrl}${formPathFor(ticket)}`;
            logger.info('issued selection link', { ticket: ticket.id, missing: missing.map((f) => f.name) });

            return result(
              [
                'Ask the user to open this link and make their choices:',
                url,
                '',
                'It shows dropdowns for ' + missing.map((f) => f.name).join(' and ') + '.',
                `When they say they have submitted it, call get_weather again with ticket="${ticket.id}" and no other arguments.`,
              ].join('\n'),
              {
                status: 'awaiting_selection',
                ticket: ticket.id,
                selectionUrl: url,
                missing: missing.map((f) => f.name),
                channel: 'browser',
              },
            );
          } catch (err) {
            // Storage unavailable: fall through to asking in chat rather than fail.
            logger.warn('could not issue a selection link', { reason: errText(err) });
          }
        }

        for (const field of missing) {
          const asked = await askFor(field);
          if ('failure' in asked) return asked.failure;
          if (field.name === 'city') city = cities.resolve(asked.value);
          else unit = resolveUnit(asked.value);
          channel = asked.channel;
        }
      }

      // --- 4. Execute --------------------------------------------------------
      try {
        const reading = await weather.getWeather(city!, unit!);
        logger.info('resolved weather', { city: reading.city, unit: reading.unit });
        return result(
          `Today's weather in ${reading.city}: ${reading.temperature}${unitSymbol(reading.unit)}, ${reading.condition}.`,
          { status: 'ok', ...reading, channel },
        );
      } catch (err) {
        if (err instanceof WeatherServiceError) {
          logger.error('weather service failed', { reason: err.message });
          return errorResult(`Could not retrieve weather: ${err.message}`);
        }
        logger.error('unexpected failure', { reason: errText(err) });
        return errorResult(`Unexpected error while retrieving weather: ${errText(err)}`);
      }

      /**
       * Prompt for one field through the elicitation engine. Returns the chosen
       * value, or a finished tool result when the user refused or no interactive
       * channel exists.
       */
      async function askFor(
        field: FieldSpec,
      ): Promise<{ value: string; channel: Channel } | { failure: ReturnType<typeof errorResult> | ReturnType<typeof result> }> {
        let asked;
        try {
          asked = await asker.ask(server.server, {
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

        if (asked.outcome.action === 'unsupported') {
          logger.info('no elicitation UI available, deferring to the model', { field: field.name });
          return { failure: inputRequired() };
        }

        if (asked.outcome.action !== 'accept') {
          const why = asked.outcome.action === 'decline' ? 'declined' : 'cancelled the request';
          logger.info('user did not answer', { field: field.name, outcome: asked.outcome.action });
          return {
            failure: result(
              `The user ${why}, so no weather was fetched. Do not retry unless they ask again.`,
              { status: 'cancelled', missing: [field.name], channel: asked.channel },
            ),
          };
        }

        const raw = asked.outcome.content[field.name];
        if (typeof raw !== 'string' || raw === '') {
          return { failure: errorResult(`No ${field.name} was selected. Please try again.`) };
        }
        return { value: raw, channel: asked.channel };
      }

      /** Last resort: hand the question to the model to ask in chat. */
      function inputRequired() {
        const names = [...(city ? [] : ['city']), ...(unit ? [] : ['temperatureUnit'])];
        const question =
          names.length === 2
            ? 'Ask the user which city they want, and whether they prefer Celsius or Fahrenheit.'
            : names[0] === 'city'
              ? 'Ask the user which of these cities they want.'
              : 'Ask the user whether they prefer Celsius or Fahrenheit.';

        return result(
          [
            `More information is needed before the weather can be fetched: ${names.join(', ')}.`,
            'This client cannot display a selection UI, so ask in chat instead.',
            question,
            names.includes('city') ? `Cities: ${cities.list().map((c) => c.label).join(', ')}.` : '',
            names.includes('temperatureUnit')
              ? `Units: ${TEMPERATURE_UNITS.map((u) => u.label).join(', ')}.`
              : '',
            'Then call get_weather again with their answer.',
          ]
            .filter(Boolean)
            .join('\n'),
          {
            status: 'input_required',
            missing: names,
            channel: 'conversational',
            ...(names.includes('city')
              ? { availableCities: cities.list().map((c) => ({ value: c.id, label: c.label })) }
              : {}),
            ...(names.includes('temperatureUnit')
              ? { availableUnits: TEMPERATURE_UNITS.map((u) => ({ value: u.id, label: u.label })) }
              : {}),
          },
        );
      }
    },
  );

  logger.debug('registered get_weather', { cities: cities.list().length, tickets: Boolean(tickets) });
}

export { describeReading };
