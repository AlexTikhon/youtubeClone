import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/auth.types.js';

export interface RequestWithContext extends Request {
  requestId: string;
  user?: AuthenticatedUser;
}
