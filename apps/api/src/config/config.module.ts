import { fileURLToPath } from 'node:url';

import { Global, Module } from '@nestjs/common';
import { config } from 'dotenv';

import { apiEnvironmentSchema, parseEnvironment } from '@youtube-clone/config';

export const API_ENVIRONMENT = Symbol('API_ENVIRONMENT');

config({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
  quiet: true,
});
const environment = parseEnvironment(apiEnvironmentSchema, process.env);

@Global()
@Module({
  providers: [{ provide: API_ENVIRONMENT, useValue: environment }],
  exports: [API_ENVIRONMENT],
})
export class ConfigurationModule {}
