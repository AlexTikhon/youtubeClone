FROM node:22-alpine

RUN apk add --no-cache ffmpeg && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/validation/package.json packages/validation/package.json
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN pnpm build:packages \
  && pnpm prisma:generate \
  && pnpm --filter @youtube-clone/worker build

USER node

CMD ["node", "apps/worker/dist/main.js"]
