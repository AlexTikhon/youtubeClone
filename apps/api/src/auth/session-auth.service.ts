import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import type { AuthenticatedUser } from './auth.types.js';
import { verifyPassword } from './password.js';

@Injectable()
export class SessionAuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async authenticate(rawToken: string): Promise<AuthenticatedUser | null> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            channel: { select: { id: true, name: true, handle: true } },
          },
        },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date())
      return null;

    return session.user.channel
      ? { ...session.user, channel: session.user.channel }
      : null;
  }

  async login(
    email: string,
    password: string,
    ttlSeconds: number,
  ): Promise<{ token: string; user: AuthenticatedUser }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        passwordHash: true,
        channel: { select: { id: true, name: true, handle: true } },
      },
    });
    if (
      !user ||
      !user.channel ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      throw new Error('INVALID_CREDENTIALS');
    }
    const token = randomBytes(32).toString('base64url');
    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        channel: user.channel,
      },
    };
  }

  async revoke(rawToken: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { tokenHash: this.hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
