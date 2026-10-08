import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const createdVideoIds: string[] = [];
const temporaryFiles: string[] = [];

/** Bytes that are accepted by storage but are not decodable media. */
function randomMp4(bytes: number): string {
  const path = join(tmpdir(), `youtube-clone-e2e-${Date.now()}-${bytes}.mp4`);
  writeFileSync(path, randomBytes(bytes));
  temporaryFiles.push(path);
  return path;
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('developer@example.test');
  await page
    .getByLabel('Password')
    .fill(process.env.DEV_SEED_PASSWORD ?? 'youtube-clone-dev');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** These scenarios upload to real MinIO, so they join the opt-in media suite. */
function requireStorageSuite() {
  test.skip(
    process.env.RUN_MEDIA_E2E !== 'true',
    'The explicit media suite requires FFmpeg, MinIO, and a real MP4 fixture.',
  );
}

function trackCreatedVideos(page: Page) {
  page.on('response', async (response) => {
    if (
      response.request().method() === 'POST' &&
      response.url() === `${apiBase}/api/v1/videos` &&
      response.ok()
    ) {
      const body = (await response.json()) as { id: string };
      createdVideoIds.push(body.id);
    }
  });
}

async function fillUploadForm(page: Page, file: string, title: string) {
  await page.goto('/studio/upload');
  await page.getByLabel('Video file').setInputFiles(file);
  await page.getByLabel('Title').fill(title);
}

test.afterEach(async ({ page }) => {
  for (const id of createdVideoIds.splice(0)) {
    await page.request.delete(`${apiBase}/api/v1/videos/${id}`);
  }
  for (const file of temporaryFiles.splice(0)) rmSync(file, { force: true });
});

test('@media direct storage upload reports progress, cancels, and uploads again', async ({
  page,
}) => {
  requireStorageSuite();
  test.setTimeout(120_000);
  trackCreatedVideos(page);
  await login(page);
  await fillUploadForm(
    page,
    randomMp4(6 * 1024 * 1024),
    `Cancel ${Date.now()}`,
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: 400 * 1024,
  });
  let completions = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/upload/complete')) completions += 1;
  });

  await page.getByRole('button', { name: 'Start upload' }).click();
  const progress = page.getByRole('progressbar', { name: 'Upload progress' });
  await expect
    .poll(async () => Number(await progress.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeLessThan(
    100,
  );

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Upload cancelled.')).toBeVisible();
  expect(completions).toBe(0);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await page.getByRole('button', { name: 'Retry upload' }).click();
  await expect(page.getByText('100% uploaded')).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => completions).toBe(1);
  await expect(page.locator('#upload-error')).toHaveCount(0);
});

test('@media object storage rejects more bytes than the declared size', async ({
  page,
}) => {
  requireStorageSuite();
  trackCreatedVideos(page);
  await login(page);
  await fillUploadForm(page, randomMp4(200 * 1024), `Oversize ${Date.now()}`);
  // The browser declares a small allowed size but sends a larger file.
  await page.route('**/api/v1/videos/*/upload', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({
      postData: JSON.stringify({ ...body, sizeBytes: 1_000 }),
    });
  });
  let completions = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/upload/complete')) completions += 1;
  });

  await page.getByRole('button', { name: 'Start upload' }).click();

  const alert = page.locator('#upload-error');
  await expect(alert).toContainText('Upload failed');
  await expect(alert).toContainText('larger than the size declared');
  expect(completions).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Retry upload' }),
  ).toBeVisible();
});

test('@media a lost completion response recovers without uploading again', async ({
  page,
}) => {
  requireStorageSuite();
  test.setTimeout(60_000);
  trackCreatedVideos(page);
  await login(page);
  await fillUploadForm(page, randomMp4(200 * 1024), `Lost ${Date.now()}`);
  const counts = { storage: 0, intent: 0, complete: 0 };
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/upload/complete')) counts.complete += 1;
    else if (/\/api\/v1\/videos\/[^/]+\/upload$/.test(request.url()))
      counts.intent += 1;
    else if (request.url().includes('/video-originals')) counts.storage += 1;
  });
  // The server commits the completion, but the browser never sees the response.
  await page.route('**/upload/complete', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });

  await page.getByRole('button', { name: 'Start upload' }).click();

  await expect(
    page.getByText(/Your upload was received|Processing failed/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Upload failed')).toHaveCount(0);
  await expect(page.getByText('could not confirm')).toHaveCount(0);
  expect(counts).toEqual({ storage: 1, intent: 1, complete: 1 });
});

function createFixture(seconds: number): string {
  const fixture = join(tmpdir(), `youtube-clone-e2e-${Date.now()}.mp4`);
  temporaryFiles.push(fixture);
  const ffmpegArguments = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=stereo',
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
  ];
  try {
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      ...ffmpegArguments,
      fixture,
    ]);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    execFileSync('docker', [
      'run',
      '--rm',
      '--volume',
      `${tmpdir()}:/fixtures`,
      '--entrypoint',
      'ffmpeg',
      process.env.FFMPEG_DOCKER_IMAGE ?? 'youtube-clone-worker:latest',
      ...ffmpegArguments,
      `/fixtures/${basename(fixture)}`,
    ]);
  }
  return fixture;
}

test('@media a watch metadata refetch does not restart active playback', async ({
  page,
}) => {
  test.setTimeout(240_000);
  test.skip(
    process.env.RUN_MEDIA_E2E !== 'true',
    'The explicit media suite requires FFmpeg, MinIO, and a real MP4 fixture.',
  );
  trackCreatedVideos(page);
  await login(page);
  await fillUploadForm(page, createFixture(40), `Stability ${Date.now()}`);
  await page.getByRole('button', { name: 'Start upload' }).click();
  await expect(page.getByText('4. Ready')).toHaveClass(/text-emerald-400/, {
    timeout: 120_000,
  });
  await page.getByRole('link', { name: 'Watch' }).click();
  const player = page.getByLabel('Video player');
  await expect(player).toBeVisible();
  const videoId = createdVideoIds.at(-1)!;
  let manifestRequests = 0;
  let detailResponses = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/hls/master.m3u8')) manifestRequests += 1;
  });
  page.on('response', (response) => {
    if (response.url() === `${apiBase}/api/v1/videos/${videoId}`)
      detailResponses += 1;
  });

  // Detect any backwards jump (a re-attach seeking to an older resume point).
  await player.evaluate((element: HTMLVideoElement) => {
    const state = { last: 0, regressed: false };
    (window as unknown as { __playback: typeof state }).__playback = state;
    element.addEventListener('timeupdate', () => {
      if (element.currentTime < state.last - 1) state.regressed = true;
      state.last = Math.max(state.last, element.currentTime);
    });
  });
  const play = () =>
    player.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await element.play();
    });
  await play();
  await expect
    .poll(
      () => player.evaluate((element: HTMLVideoElement) => element.currentTime),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(7);
  // Pausing saves the watch position, so the next watch-detail refetch reports
  // a new resume position for the same source.
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/v1/videos/${videoId}/history`) &&
      response.ok(),
  );
  await player.evaluate((element: HTMLVideoElement) => element.pause());
  await saved;
  const manifestsBefore = manifestRequests;
  const sourceBefore = await player.evaluate(
    (element: HTMLVideoElement) => element.currentSrc,
  );
  const detailsBefore = detailResponses;

  // Resuming accumulates enough forward playback for the counted-view request,
  // which invalidates and refetches the watch detail mid-playback.
  await play();
  await expect
    .poll(() => detailResponses, { timeout: 45_000 })
    .toBeGreaterThan(detailsBefore);
  await page.waitForTimeout(1_000);

  const after = await player.evaluate((element: HTMLVideoElement) => ({
    src: element.currentSrc,
    paused: element.paused,
    readyState: element.readyState,
    time: element.currentTime,
    regressed: (window as unknown as { __playback: { regressed: boolean } })
      .__playback.regressed,
  }));
  expect(manifestRequests).toBe(manifestsBefore);
  expect(after.src).toBe(sourceBefore);
  expect(after.regressed).toBe(false);
  expect(after.paused).toBe(false);
  expect(after.readyState).toBeGreaterThan(0);
  expect(after.time).toBeGreaterThan(7);
});
