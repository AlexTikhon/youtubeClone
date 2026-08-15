import { Injectable, Logger } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import type { RequestWithContext } from './request-context.js';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const startedAt = performance.now();
    return next.handle().pipe(
      tap({
        next: () => this.log(request, startedAt, 'http.request.completed'),
        error: () => this.log(request, startedAt, 'http.request.rejected'),
      }),
    );
  }

  private log(
    request: RequestWithContext,
    startedAt: number,
    event: string,
  ): void {
    this.logger.log({
      event,
      requestId: request.requestId,
      userId: request.user?.id,
      method: request.method,
      path: request.originalUrl,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  }
}
