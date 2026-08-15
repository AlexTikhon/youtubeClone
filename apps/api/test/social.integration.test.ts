import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { hashPassword } from '../src/auth/password.js';
import { ApiExceptionFilter } from '../src/infrastructure/http/api-exception.filter.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!enabled)('Phase 2 social API integration', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl = '';
  let viewerId = '';
  let creatorId = '';
  let channelId = '';
  let videoId = '';
  let cookie = '';

  beforeAll(async () => {
    const passwordHash = await hashPassword('integration-password');
    const creator = await prisma.user.create({
      data: {
        email: `creator-${suffix}@example.test`,
        username: `creator-${suffix}`,
        passwordHash,
        channel: {
          create: { handle: `creator-${suffix}`, name: 'Integration Creator' },
        },
      },
      include: { channel: true },
    });
    const viewer = await prisma.user.create({
      data: {
        email: `viewer-${suffix}@example.test`,
        username: `viewer-${suffix}`,
        passwordHash,
        channel: {
          create: { handle: `viewer-${suffix}`, name: 'Integration Viewer' },
        },
      },
    });
    creatorId = creator.id;
    viewerId = viewer.id;
    channelId = creator.channel!.id;
    const video = await prisma.video.create({
      data: {
        channelId,
        title: 'Integration video',
        status: 'READY',
        visibility: 'PUBLIC',
        durationSeconds: 30,
        publishedAt: new Date(),
        assets: {
          create: [
            {
              kind: 'THUMBNAIL',
              bucket: 'integration',
              objectKey: `${suffix}/thumbnail.jpg`,
              mimeType: 'image/jpeg',
            },
            {
              kind: 'HLS_MANIFEST',
              bucket: 'integration',
              objectKey: `${suffix}/index.m3u8`,
              mimeType: 'application/vnd.apple.mpegurl',
            },
          ],
        },
      },
    });
    videoId = video.id;
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `viewer-${suffix}@example.test`,
        password: 'integration-password',
      }),
    });
    expect(login.status).toBe(201);
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (viewerId)
      await prisma.user.deleteMany({
        where: { id: { in: [viewerId, creatorId] } },
      });
    await prisma.$disconnect();
  });

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        cookie,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });

  it('persists idempotent likes, comments, subscriptions, views, and history', async () => {
    expect(
      (await request(`/videos/${videoId}/like`, { method: 'PUT' })).status,
    ).toBe(200);
    expect(
      (await request(`/videos/${videoId}/like`, { method: 'PUT' })).status,
    ).toBe(200);
    expect(
      await prisma.videoLike.count({ where: { videoId, userId: viewerId } }),
    ).toBe(1);
    expect(
      (
        await request(`/videos/${videoId}/comments`, {
          method: 'POST',
          body: JSON.stringify({ content: 'Integration comment' }),
        })
      ).status,
    ).toBe(201);
    expect(
      (await request(`/channels/${channelId}/subscription`, { method: 'PUT' }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(`/videos/${videoId}/view`, {
          method: 'POST',
          body: JSON.stringify({ watchedSeconds: 10 }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(`/videos/${videoId}/history`, {
          method: 'PUT',
          body: JSON.stringify({ positionSeconds: 12 }),
        })
      ).status,
    ).toBe(200);
    const history = (await (await request('/history')).json()) as {
      data: unknown[];
    };
    expect(history.data).toHaveLength(1);
  });

  it('serves the channel and subscriptions feed, then safely unlikes', async () => {
    expect((await request(`/channels/creator-${suffix}`)).status).toBe(200);
    const feed = (await (await request('/feeds/subscriptions')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(feed.data.map((video) => video.id)).toContain(videoId);
    expect(
      (await request(`/videos/${videoId}/like`, { method: 'DELETE' })).status,
    ).toBe(200);
    expect(
      (await request(`/videos/${videoId}/like`, { method: 'DELETE' })).status,
    ).toBe(200);
  });
});
