import 'reflect-metadata';

import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new ConsoleLogger({ json: true, colors: false }),
  });
  application.enableShutdownHooks();
}

void bootstrap();
