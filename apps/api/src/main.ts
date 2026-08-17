import 'reflect-metadata';

import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';

import type { ApiEnvironment } from '@youtube-clone/config';

import { AppModule } from './app.module.js';
import { API_ENVIRONMENT } from './config/config.module.js';
import { ApiExceptionFilter } from './infrastructure/http/api-exception.filter.js';
import { RequestLoggingInterceptor } from './infrastructure/http/request-logging.interceptor.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true, colors: false }),
  });
  const environment = app.get<ApiEnvironment>(API_ENVIRONMENT);
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: environment.WEB_URL, credentials: true });
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    next();
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new RequestLoggingInterceptor());

  const openApiConfiguration = new DocumentBuilder()
    .setTitle('YouTubeClone API')
    .setDescription(
      'Video processing, discovery, social, history, and creator API',
    )
    .setVersion('1.0')
    .addCookieAuth(
      environment.SESSION_COOKIE_NAME,
      { type: 'apiKey', in: 'cookie' },
      'session',
    )
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, openApiConfiguration),
  );

  await app.listen(environment.API_PORT);
}

void bootstrap();
