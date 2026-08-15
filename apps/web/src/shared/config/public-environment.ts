import { parseEnvironment, webEnvironmentSchema } from '@youtube-clone/config';

export const publicEnvironment = parseEnvironment(webEnvironmentSchema, {
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
