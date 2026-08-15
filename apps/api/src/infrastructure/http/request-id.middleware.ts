import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import type { RequestWithContext } from './request-context.js';

const SAFE_REQUEST_ID = /^[a-zA-Z0-9._-]{1,100}$/;

@Injectable()
export class RequestIdMiddleware {
  use(
    request: RequestWithContext,
    response: Response,
    next: NextFunction,
  ): void {
    const suppliedRequestId = request.header('x-request-id');
    request.requestId =
      suppliedRequestId && SAFE_REQUEST_ID.test(suppliedRequestId)
        ? suppliedRequestId
        : randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}
