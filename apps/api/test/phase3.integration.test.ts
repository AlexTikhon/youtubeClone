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

describe.skipIf(!enabled)('Phase 3 discovery and playlists integration', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl = '';
  let creatorId = '';
  let viewerId = '';
  let creatorCookie = '';
  let viewerCookie = '';
  let currentVideoId = '';
  let sameChannelVideoId = '';

  beforeAll(async () => {
    const passwordHash = await hashPassword('integration-password');
    const creator = await prisma.user.create({
      data: {
        email: `phase3-creator-${suffix}@example.test`,
        username: `phase3-creator-${suffix}`,
        passwordHash,
        channel: {
          create: { handle: `phase3-creator-${suffix}`, name: 'React Creator' },
        },
      },
      include: { channel: true },
    });
    const viewer = await prisma.user.create({
      data: {
        email: `phase3-viewer-${suffix}@example.test`,
        username: `phase3-viewer-${suffix}`,
        passwordHash,
        channel: {
          create: { handle: `phase3-viewer-${suffix}`, name: 'Viewer' },
        },
      },
      include: { channel: true },
    });
    creatorId = creator.id;
    viewerId = viewer.id;
    const createVideo = async (input: {
      title: string;
      description?: string;
      status?: 'READY' | 'PROCESSING';
      visibility?: 'PUBLIC' | 'PRIVATE';
      channelId?: string;
    }) => {
      const id = randomUUID();
      await prisma.video.create({
        data: {
          id,
          channelId: input.channelId ?? creator.channel!.id,
          title: input.title,
          description: input.description,
          status: input.status ?? 'READY',
          visibility: input.visibility ?? 'PUBLIC',
          durationSeconds: 60,
          publishedAt: new Date('2026-08-15T10:00:00Z'),
          assets: {
            create: [
              {
                kind: 'THUMBNAIL',
                bucket: 'integration',
                objectKey: `${id}/thumb.jpg`,
                mimeType: 'image/jpeg',
              },
              {
                kind: 'HLS_MANIFEST',
                bucket: 'integration',
                objectKey: `${id}/index.m3u8`,
                mimeType: 'application/vnd.apple.mpegurl',
              },
            ],
          },
        },
      });
      return id;
    };
    currentVideoId = await createVideo({ title: 'React Architecture' });
    sameChannelVideoId = await createVideo({
      title: 'A companion from this creator',
    });
    const descriptionOnly = await createVideo({
      title: 'Popular database discussion',
      description: 'A discussion of react architecture patterns',
      channelId: viewer.channel!.id,
    });
    await createVideo({
      title: 'React Architecture alternative',
      channelId: viewer.channel!.id,
    });
    await prisma.videoView.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        userId: index === 0 ? viewer.id : creator.id,
        videoId: descriptionOnly,
        windowStart: new Date(
          `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        ),
      })),
      skipDuplicates: true,
    });
    await createVideo({
      title: 'React Architecture private',
      visibility: 'PRIVATE',
    });
    await createVideo({
      title: 'React Architecture processing',
      status: 'PROCESSING',
    });

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const login = async (email: string) => {
      const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'integration-password' }),
      });
      expect(response.status).toBe(201);
      return response.headers.get('set-cookie')!.split(';')[0]!;
    };
    creatorCookie = await login(creator.email);
    viewerCookie = await login(viewer.email);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (creatorId)
      await prisma.user.deleteMany({
        where: { id: { in: [creatorId, viewerId] } },
      });
    await prisma.$disconnect();
  });

  const request = (
    path: string,
    cookie = viewerCookie,
    init: RequestInit = {},
  ) =>
    fetch(`${baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        cookie,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });

  it('ranks title matches above description popularity and never leaks unavailable videos', async () => {
    const response = await request(
      '/search?q=react%20architecture&limit=20',
      '',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; title: string }>;
    };
    expect(body.data[0]?.id).toBe(currentVideoId);
    expect(body.data.some((video) => video.title.includes('private'))).toBe(
      false,
    );
    expect(body.data.some((video) => video.title.includes('processing'))).toBe(
      false,
    );
    const firstPage = (await (
      await request('/search?q=react&limit=1', '')
    ).json()) as {
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    };
    expect(firstPage.page.nextCursor).toBeTruthy();
    const secondPage = (await (
      await request(
        `/search?q=react&limit=1&cursor=${encodeURIComponent(firstPage.page.nextCursor!)}`,
        '',
      )
    ).json()) as { data: Array<{ id: string }> };
    expect(secondPage.data[0]?.id).not.toBe(firstPage.data[0]?.id);
    expect((await request('/search?q=react&cursor=broken', '')).status).toBe(
      400,
    );
  });

  it('returns bounded related videos with same-channel priority and exclusions', async () => {
    const response = await request(
      `/videos/${currentVideoId}/related?limit=1`,
      '',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(sameChannelVideoId);
    expect(body.some((video) => video.id === currentVideoId)).toBe(false);
    const all = (await (
      await request(`/videos/${currentVideoId}/related?limit=20`, '')
    ).json()) as Array<{ id: string; title: string }>;
    expect(all.some((video) => video.id === currentVideoId)).toBe(false);
    expect(all.some((video) => video.title.includes('private'))).toBe(false);
  });

  it('enforces playlist ownership, visibility, idempotency, and Watch Later rules', async () => {
    const createdResponse = await request('/playlists', viewerCookie, {
      method: 'POST',
      body: JSON.stringify({ title: 'React Learning', visibility: 'PUBLIC' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    expect(
      (
        await request(
          `/playlists/${created.id}/videos/${currentVideoId}`,
          viewerCookie,
          { method: 'PUT' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/playlists/${created.id}/videos/${currentVideoId}`,
          viewerCookie,
          { method: 'PUT' },
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.playlistItem.count({
        where: { playlistId: created.id, videoId: currentVideoId },
      }),
    ).toBe(1);
    expect((await request(`/playlists/${created.id}`, '', {})).status).toBe(
      200,
    );
    expect(
      (
        await request(`/playlists/${created.id}`, creatorCookie, {
          method: 'PATCH',
          body: JSON.stringify({ title: 'Stolen' }),
        })
      ).status,
    ).toBe(404);

    const mine = (await (await request('/playlists/mine?limit=50')).json()) as {
      data: Array<{ id: string; type: string }>;
    };
    const watchLater = mine.data.find(
      (playlist) => playlist.type === 'WATCH_LATER',
    );
    expect(watchLater).toBeDefined();
    expect((await request(`/playlists/${watchLater!.id}`, '')).status).toBe(
      404,
    );
    expect(
      (
        await request(`/playlists/${watchLater!.id}`, viewerCookie, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/playlists/${created.id}/videos/${currentVideoId}`,
          viewerCookie,
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/playlists/${created.id}/videos/${currentVideoId}`,
          viewerCookie,
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(200);
  });
});
