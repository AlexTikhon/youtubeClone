FROM node:24-alpine

RUN apk add --no-cache ffmpeg && corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build:packages \
  && pnpm prisma:generate \
  && pnpm --filter @youtube-clone/worker build

CMD ["pnpm", "--filter", "@youtube-clone/worker", "start"]
