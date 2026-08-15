import { createHash, randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'developer@example.test' },
    update: {},
    create: {
      email: 'developer@example.test',
      username: 'developer',
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

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await prisma.authSession.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  console.log(
    JSON.stringify({
      event: 'development.seed.completed',
      userId: user.id,
      channelId: user.channel?.id,
      sessionCookie: `ytc_session=${rawToken}`,
      warning: 'The session token is shown once for local development only.',
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
