import { fileURLToPath } from 'node:url';

import {
  workerEnvironmentSchema,
  parseEnvironment,
} from '@youtube-clone/config';
import { config } from 'dotenv';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
export const workerEnvironment = parseEnvironment(
  workerEnvironmentSchema,
  process.env,
);
