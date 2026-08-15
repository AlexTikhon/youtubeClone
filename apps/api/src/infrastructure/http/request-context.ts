import type { Request } from 'express';

export interface RequestWithContext extends Request {
  requestId: string;
  user?: {
    id: string;
    email: string;
  };
}
