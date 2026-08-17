import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

test('keeps primary navigation available at a mobile viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const documentResponse = await page.goto('/');
  expect(documentResponse?.headers()['x-content-type-options']).toBe('nosniff');
  expect(documentResponse?.headers()['x-frame-options']).toBe('DENY');
  const readiness = await page.request.get(
    `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/health/ready`,
  );
  expect(readiness.ok()).toBe(true);
  expect(readiness.headers()['x-content-type-options']).toBe('nosniff');
  await expect(readiness.json()).resolves.toMatchObject({
    status: 'ok',
    dependencies: { postgres: { status: 'up' }, redis: { status: 'up' } },
  });
  const navigation = page.getByRole('navigation', { name: 'Primary' }).last();
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Studio' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'History' })).toBeVisible();
});

test('supports skip navigation and keyboard search navigation', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  const search = page.getByLabel('Search videos');
  await search.focus();
  await search.fill('nonexistent release candidate');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=nonexistent%20release%20candidate/);
  await expect(page.getByText('No videos matched this search.')).toBeVisible();
});

test('login and browse honest metadata-only development state', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('developer@example.test');
  await page
    .getByLabel('Password')
    .fill(process.env.DEV_SEED_PASSWORD ?? 'youtube-clone-dev');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/studio');
  const demoHeading = page.getByRole('heading', {
    name: 'Demo metadata only — upload an MP4 to create playable media',
  });
  await expect(demoHeading).toBeVisible();
  const demoCard = page.getByRole('article').filter({ has: demoHeading });
  await expect(demoCard.getByText(/DRAFT.*PRIVATE/)).toBeVisible();
  await page.goto('/playlists');
  await expect(page.getByRole('link', { name: /Watch Later/ })).toBeVisible();
});

test('@media upload, transcode, and open HLS playback', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(
    process.env.RUN_MEDIA_E2E !== 'true',
    'The explicit media suite requires FFmpeg, MinIO, and a real MP4 fixture.',
  );
  const fixture = join(tmpdir(), `youtube-clone-e2e-${Date.now()}.mp4`);
  const ffmpegArguments = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30:duration=2',
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
  let uploadedVideoId: string | undefined;
  try {
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      ...ffmpegArguments,
      fixture,
    ]);
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      throw error;
    }
    execFileSync('docker', [
      'run',
      '--rm',
      '--volume',
      `${tmpdir()}:/fixtures`,
      '--entrypoint',
      'ffmpeg',
      'youtube-clone-worker:latest',
      ...ffmpegArguments,
      `/fixtures/${basename(fixture)}`,
    ]);
  }
  try {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/studio/upload');
    await page.getByLabel('Video file').setInputFiles(fixture);
    await page.getByLabel('Title').fill(`Media E2E ${Date.now()}`);
    await page.getByRole('button', { name: 'Start upload' }).click();
    await expect(page.getByText('4. Ready')).toHaveClass(/text-emerald-400/, {
      timeout: 120_000,
    });
    const watchLink = page.getByRole('link', { name: 'Watch' });
    const watchHref = await watchLink.getAttribute('href');
    uploadedVideoId = watchHref?.split('/').at(-1);
    await watchLink.click();
    const player = page.getByLabel('Video player');
    await expect(player).toBeVisible();
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    const thumbnail = await page.request.get(
      `${apiBase}/api/v1/media/videos/${uploadedVideoId}/thumbnail`,
    );
    expect(thumbnail.ok()).toBe(true);
    expect(thumbnail.headers()['content-type']).toContain('image/jpeg');
    expect((await thumbnail.body()).byteLength).toBeGreaterThan(0);

    const manifest = await page.request.get(
      `${apiBase}/api/v1/media/videos/${uploadedVideoId}/hls/master.m3u8`,
    );
    expect(manifest.ok()).toBe(true);
    const manifestText = await manifest.text();
    expect(manifestText).toContain('#EXTM3U');
    expect(manifestText.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(3);
    expect(manifestText).toContain('360p/index.m3u8');
    expect(manifestText).toContain('480p/index.m3u8');
    expect(manifestText).toContain('720p/index.m3u8');
    const variant = await page.request.get(
      `${apiBase}/api/v1/media/videos/${uploadedVideoId}/hls/360p/index.m3u8`,
    );
    expect(variant.ok()).toBe(true);
    const variantText = await variant.text();
    const segmentName = variantText.match(/segment\d{3,6}\.ts/)?.[0];
    expect(segmentName).toBeTruthy();
    const segment = await page.request.get(
      `${apiBase}/api/v1/media/videos/${uploadedVideoId}/hls/360p/${segmentName}`,
    );
    expect(segment.ok()).toBe(true);
    expect((await segment.body()).byteLength).toBeGreaterThan(0);

    await player.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await element.play();
    });
    await expect
      .poll(() =>
        player.evaluate((element: HTMLVideoElement) => element.currentTime),
      )
      .toBeGreaterThan(0);
  } finally {
    if (uploadedVideoId) {
      const cleanupResponse = await page.request.delete(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/videos/${uploadedVideoId}`,
      );
      expect(cleanupResponse.ok()).toBe(true);
    }
    rmSync(fixture, { force: true });
  }
});
