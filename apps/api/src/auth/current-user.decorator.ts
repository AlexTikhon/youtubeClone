import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import type { AuthenticatedUser } from './auth.types.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (!request.user)
      throw new Error('SessionGuard must run before CurrentUser');
    return request.user;
  },
);
