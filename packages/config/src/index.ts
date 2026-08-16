import { z } from 'zod';

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const infrastructureSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_FORCE_PATH_STYLE: booleanFromEnvironment,
  S3_BUCKET_ORIGINALS: z.string().min(3).default('video-originals'),
  S3_BUCKET_STREAMS: z.string().min(3).default('video-streams'),
  S3_BUCKET_THUMBNAILS: z.string().min(3).default('video-thumbnails'),
});

export const apiEnvironmentSchema = infrastructureSchema.extend({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  WEB_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().min(1).default('ytc_session'),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(31_536_000)
    .default(604_800),
  MAX_UPLOAD_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
});

export const workerEnvironmentSchema = infrastructureSchema.extend({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  MEDIA_PROCESS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(900_000),
  MAX_VIDEO_DURATION_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(7_200),
});

export const webEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
});

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
export type WebEnvironment = z.infer<typeof webEnvironmentSchema>;

export function parseEnvironment<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
