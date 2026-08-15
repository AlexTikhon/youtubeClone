import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import type { AuthenticatedUser } from './auth.types.js';

@Injectable()
export class SessionAuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async authenticate(rawToken: string): Promise<AuthenticatedUser | null> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date())
      return null;

    return session.user;
  }
}
