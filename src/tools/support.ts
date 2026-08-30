import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { detectSupport, plannedChannel, type Channel, type FallbackMode } from '../elicit/ask.js';
import type { CityRegistry } from '../weather/cities.js';
import { TEMPERATURE_UNITS } from '../weather/units.js';

export interface SupportToolDeps {
  cities: CityRegistry;
  fallback: FallbackMode;
  forceChannel?: Channel;
  defaultTimeoutMs: number;
}

export function registerSupportTools(server: McpServer, deps: SupportToolDeps): void {
  const { cities, fallback, forceChannel, defaultTimeoutMs } = deps;

  server.registerTool(
    'list_cities',
    {
      title: 'List supported cities',
      description:
        'Return the cities get_weather can report on, with the id to pass as its "city" argument. ' +
        'Use this when the user asks what is available, or to phrase a question yourself in a client ' +
        'that cannot render a selection list.',
      inputSchema: {},
      outputSchema: {
        cities: z.array(z.object({ id: z.string(), label: z.string(), country: z.string() })),
        temperatureUnits: z.array(z.object({ id: z.string(), label: z.string() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      const list = cities.list();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Supported cities: ${list.map((c) => `${c.label} (${c.country})`).join(', ')}.\nUnits: ${TEMPERATURE_UNITS.map((u) => u.label).join(', ')}.`,
          },
        ],
        structuredContent: {
          cities: list,
          temperatureUnits: TEMPERATURE_UNITS.map((u) => ({ id: u.id, label: u.label })),
        },
      };
    },
  );

  /**
   * The line this POC exists to draw: what the *server* offers versus what the
   * connected *client* can actually render. Calling it prompts nobody.
   */
  server.registerTool(
    'client_capabilities',
    {
      title: 'Inspect interactive UI support',
      description:
        'Diagnostic. Reports which MCP client is connected, whether it supports elicitation, and how ' +
        'get_weather will therefore ask for missing input - a native selection dialog, a link, a local ' +
        'browser form, or a plain chat question. Does not prompt the user.',
      inputSchema: {},
      outputSchema: {
        client: z.string(),
        protocolVersion: z.string().optional(),
        serverOffers: z.array(z.string()),
        clientSupportsElicitationForm: z.boolean(),
        clientSupportsElicitationUrl: z.boolean(),
        channel: z.string(),
        rendering: z.string(),
        fallbackMode: z.string(),
        defaultTimeoutSeconds: z.number(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      const support = detectSupport(server.server);
      const info = server.server.getClientVersion();
      const channel = plannedChannel(server.server, fallback, forceChannel);
      const client = info ? `${info.name} ${info.version}` : 'unknown';

      const rendering: Record<Channel, string> = {
        'elicitation-form': 'A native selection dialog rendered by the client itself.',
        'elicitation-url': 'The client hands the user a link to a form served by this server.',
        browser: 'A local browser page served by this server.',
        conversational:
          'No interactive UI. get_weather returns status "input_required" and the model asks in chat.',
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Client: ${client}`,
              `Elicitation - form: ${support.form ? 'yes' : 'no'}, url: ${support.url ? 'yes' : 'no'}`,
              `Prompts will use: ${channel}${forceChannel ? ' (forced)' : ''}`,
              rendering[channel],
            ].join('\n'),
          },
        ],
        structuredContent: {
          client,
          protocolVersion: info ? undefined : undefined,
          // What this server declares it can do, independent of the client.
          serverOffers: ['tools', 'logging', 'elicitation/create (form)', 'elicitation/create (url)'],
          clientSupportsElicitationForm: support.form,
          clientSupportsElicitationUrl: support.url,
          channel,
          rendering: rendering[channel],
          fallbackMode: fallback,
          defaultTimeoutSeconds: defaultTimeoutMs / 1000,
        },
      };
    },
  );
}
