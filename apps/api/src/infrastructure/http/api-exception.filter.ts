import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import type { ApiErrorEnvelope } from '@youtube-clone/types';

import { AppError } from './app-error.js';
import type { RequestWithContext } from './request-context.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const appError = exception instanceof AppError ? exception : undefined;
    const message = appError?.message ?? this.getMessage(exception, status);

    if (status >= 500) {
      this.logger.error({
        event: 'http.request.failed',
        requestId: request.requestId,
        method: request.method,
        path: request.originalUrl,
        error: exception instanceof Error ? exception.stack : String(exception),
      });
    }

    const body: ApiErrorEnvelope = {
      error: {
        code: appError?.code ?? this.defaultCode(status),
        message,
        requestId: request.requestId,
        ...(appError?.details === undefined
          ? {}
          : { details: appError.details }),
      },
    };
    response.status(status).json(body);
  }

  private getMessage(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') return body;
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const message = body.message;
        return Array.isArray(message) ? message.join(', ') : String(message);
      }
    }
    return status >= 500 ? 'An unexpected error occurred' : 'Request failed';
  }

  private defaultCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_FAILED';
      case HttpStatus.UNAUTHORIZED:
        return 'AUTH_REQUIRED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'ROUTE_NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
