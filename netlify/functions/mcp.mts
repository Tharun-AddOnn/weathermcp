import type { Config, Context } from '@netlify/functions';
import { createFetchHandler } from '../../dist/serverless.js';

/**
 * Netlify Function entry point. The MCP endpoint is stateless and
 * conversational-only - see src/serverless.ts for why elicitation cannot work
 * on a platform that does not keep a process alive.
 */
const handler = createFetchHandler({
  authToken: process.env.WEATHER_AUTH_TOKEN,
  pathSecret: process.env.WEATHER_PATH_SECRET,
});

export default async (request: Request, _context: Context): Promise<Response> => handler(request);

export const config: Config = {
  // Matches /mcp, /mcp/<secret> and /health.
  path: ['/mcp', '/mcp/:secret', '/health'],
};
