import type { Config, Context } from '@netlify/functions';
import { createFetchHandler } from '../../dist/serverless.js';

/**
 * Netlify Function entry point.
 *
 * The MCP endpoint is stateless: elicitation cannot work on a platform that
 * does not keep a process alive. Instead, /f/:id serves a real HTML page with
 * dropdowns, and Netlify Blobs carries the answer from that page back to the
 * next tool call.
 */
const handler = createFetchHandler({
  authToken: process.env.WEATHER_AUTH_TOKEN,
  pathSecret: process.env.WEATHER_PATH_SECRET,
  // Selection links are absolute, so they need the site's public origin.
  // Netlify sets URL automatically; WEATHER_PUBLIC_URL overrides it.
  publicBaseUrl: process.env.WEATHER_PUBLIC_URL ?? process.env.URL,
});

export default async (request: Request, _context: Context): Promise<Response> => handler(request);

export const config: Config = {
  // /f/:id is the selection page a user opens in their browser.
  path: ['/mcp', '/mcp/:secret', '/health', '/f/:id'],
};
