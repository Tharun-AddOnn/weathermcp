import { createFetchHandler } from '../dist/serverless.js';

/** Vercel entry point. Same stateless, conversational-only constraints as Netlify. */
const handler = createFetchHandler({
  authToken: process.env.WEATHER_AUTH_TOKEN,
  pathSecret: process.env.WEATHER_PATH_SECRET,
  publicBaseUrl: process.env.WEATHER_PUBLIC_URL,
});

export default handler;
export const config = { runtime: 'edge' };
