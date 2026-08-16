import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

test('login, search, like, and save a seeded video to Watch Later', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('developer@example.test');
  await page
    .getByLabel('Password')
    .fill(process.env.DEV_SEED_PASSWORD ?? 'youtube-clone-dev');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByLabel('Search videos').fill('React Architecture');
  await page.getByLabel('Submit search').click();
  await expect(page).toHaveURL(/\/search\?q=React%20Architecture/);
  await page
    .getByRole('link', { name: /React Architecture in Practice/ })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: 'React Architecture in Practice' }),
  ).toBeVisible();

  await page.getByRole('button', { name: /^Like/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  const watchLater = page.getByLabel('Watch Later');
  if (!(await watchLater.isChecked())) await watchLater.click();
  await expect(watchLater).toBeChecked();
  await page.getByLabel('Close').click();

  await page.goto('/playlists');
  await page.getByRole('link', { name: /Watch Later/ }).click();
  await expect(
    page.getByRole('link', {
      name: 'React Architecture in Practice',
      exact: true,
    }),
  ).toBeVisible();
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
    'color=c=blue:s=320x180:d=2',
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
    await expect(page.getByLabel('Video player')).toBeVisible();
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
