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

  console.log(
    JSON.stringify({
      event: 'development.seed.completed',
      userId: user.id,
      channelId: user.channel?.id,
      loginEmail: user.email,
      loginPassword: password,
      warning:
        'Development credentials only. Set DEV_SEED_PASSWORD to override the password.',
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
