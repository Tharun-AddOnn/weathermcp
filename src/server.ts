import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Asker, errText, type Channel, type FallbackMode } from './elicit/ask.js';
import { FormServer } from './elicit/webform.js';
import { registerGetWeather } from './tools/getWeather.js';
import { registerSupportTools } from './tools/support.js';
import { CityRegistry } from './weather/cities.js';
import { MockWeatherService, type WeatherService } from './weather/service.js';
import type { TicketConfig } from './tools/getWeather.js';
import { log } from './log.js';

export const SERVER_NAME = 'mcp-weather-elicitation';
export const SERVER_VERSION = '1.0.0';

const INSTRUCTIONS = `A weather assistant that demonstrates MCP elicitation.

When the user asks about the weather, call get_weather with only the arguments
they actually stated in words. "What's the weather?" names nothing, so it is a
call with no arguments at all.

Never supply a city the user did not name. Their location, timezone, IP address
and account profile are not answers to "which city?" - the whole point is that
the server asks them, showing a selection list in clients that support
elicitation. The same goes for Celsius versus Fahrenheit.

If a result comes back with status "input_required", the client cannot show a
selection UI: ask the user the question it describes and call get_weather again
with their answer.`;

export interface ServerConfig {
  defaultTimeoutMs: number;
  formHost: string;
  formPort: number;
  publicBaseUrl?: string;
  /** What to do when the client cannot elicit. */
  fallback: FallbackMode;
  forceChannel?: Channel;
  /** Open the fallback form in a browser automatically. Off for headless hosts. */
  launchBrowser: boolean;
  /** Optional path to a JSON array of extra cities. */
  citiesFile?: string;
  /** Enables the link-to-form dropdown flow for clients that cannot elicit. */
  tickets?: TicketConfig;
}

/**
 * @param sharedFormServer  In hosted HTTP mode every session shares one attached
 *   form server mounted on the main port, so it must not be disposed per session.
 * @param weatherService    Injected by tests; defaults to the mock provider.
 */
export function buildServer(
  config: ServerConfig,
  sharedFormServer?: FormServer,
  weatherService?: WeatherService,
): { server: McpServer; dispose: () => Promise<void> } {
  const formServer =
    sharedFormServer ??
    new FormServer({ host: config.formHost, port: config.formPort, publicBaseUrl: config.publicBaseUrl });

  const asker = new Asker(formServer, config.fallback, config.forceChannel, config.launchBrowser);
  const cities = config.citiesFile ? CityRegistry.fromFile(config.citiesFile) : new CityRegistry();
  const weather = weatherService ?? new MockWeatherService();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} }, instructions: INSTRUCTIONS },
  );

  registerGetWeather(server, {
    cities,
    weather,
    asker,
    defaultTimeoutMs: config.defaultTimeoutMs,
    tickets: config.tickets,
  });
  registerSupportTools(server, {
    cities,
    fallback: config.fallback,
    forceChannel: config.forceChannel,
    defaultTimeoutMs: config.defaultTimeoutMs,
  });

  return {
    server,
    dispose: async () => {
      if (sharedFormServer) return; // owned by the caller
      try {
        await formServer.close();
      } catch (err) {
        log(`error closing form server: ${errText(err)}`);
      }
    },
  };
}
