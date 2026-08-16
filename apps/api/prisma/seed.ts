import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';

const prisma = new PrismaClient();

async function main() {
  const password = process.env.DEV_SEED_PASSWORD ?? 'youtube-clone-dev';
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email: 'developer@example.test' },
    update: { passwordHash },
    create: {
      email: 'developer@example.test',
      username: 'developer',
      passwordHash,
      channel: {
        create: {
          handle: 'developer',
          name: 'Developer Channel',
          description: 'Local development channel',
        },
      },
    },
    include: { channel: true },
  });

  const demoUsers = await Promise.all(
    [
      {
        email: 'alice@example.test',
        username: 'alice',
        handle: 'alice',
        name: 'Alice Builds',
      },
      {
        email: 'bob@example.test',
        username: 'bob',
        handle: 'bob',
        name: 'Bob Explains',
      },
    ].map((demo) =>
      prisma.user.upsert({
        where: { email: demo.email },
        update: { passwordHash },
        create: {
          email: demo.email,
          username: demo.username,
          passwordHash,
          channel: {
            create: {
              handle: demo.handle,
              name: demo.name,
              description: `Demo channel for ${demo.name}`,
            },
          },
        },
        include: { channel: true },
      }),
    ),
  );
  for (const demo of demoUsers) {
    if (demo.channel) {
      await prisma.subscription.upsert({
        where: {
          subscriberId_channelId: {
            subscriberId: user.id,
            channelId: demo.channel.id,
          },
        },
        create: { subscriberId: user.id, channelId: demo.channel.id },
        update: {},
      });
    }
  }

  const demoChannel = demoUsers[0]?.channel;
  if (demoChannel) {
    const demoVideoId = '11111111-1111-4111-8111-111111111111';
    await prisma.video.upsert({
      where: { id: demoVideoId },
      update: {
        channelId: demoChannel.id,
        title: 'React Architecture in Practice',
        description: 'A seeded READY video for fast product and browser tests.',
        status: 'READY',
        visibility: 'PUBLIC',
        durationSeconds: 90,
        publishedAt: new Date('2026-08-15T10:00:00Z'),
      },
      create: {
        id: demoVideoId,
        channelId: demoChannel.id,
        title: 'React Architecture in Practice',
        description: 'A seeded READY video for fast product and browser tests.',
        status: 'READY',
        visibility: 'PUBLIC',
        durationSeconds: 90,
        publishedAt: new Date('2026-08-15T10:00:00Z'),
      },
    });
    await Promise.all([
      prisma.videoAsset.upsert({
        where: {
          bucket_objectKey: {
            bucket: 'video-thumbnails',
            objectKey: `fixtures/${demoVideoId}/thumbnail.jpg`,
          },
        },
        create: {
          videoId: demoVideoId,
          kind: 'THUMBNAIL',
          bucket: 'video-thumbnails',
          objectKey: `fixtures/${demoVideoId}/thumbnail.jpg`,
          mimeType: 'image/jpeg',
        },
        update: {},
      }),
      prisma.videoAsset.upsert({
        where: {
          bucket_objectKey: {
            bucket: 'video-streams',
            objectKey: `fixtures/${demoVideoId}/index.m3u8`,
          },
        },
        create: {
          videoId: demoVideoId,
          kind: 'HLS_MANIFEST',
          bucket: 'video-streams',
          objectKey: `fixtures/${demoVideoId}/index.m3u8`,
          mimeType: 'application/vnd.apple.mpegurl',
        },
        update: {},
      }),
    ]);
  }

  console.log(
    JSON.stringify({
      event: 'development.seed.completed',
      userId: user.id,
      channelId: user.channel?.id,
      loginEmail: user.email,
      warning:
        'Development account only. Credentials are documented in the local README; override DEV_SEED_PASSWORD outside throwaway environments.',
    }),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
