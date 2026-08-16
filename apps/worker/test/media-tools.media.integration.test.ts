import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { selectRenditions } from '../src/hls-renditions.js';
import { MediaToolsService } from '../src/media-tools.service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('real FFmpeg ABR generation', () => {
  it('creates and validates a three-variant master for a 720p source', async () => {
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, 'source.mp4');
    const hlsDirectory = join(directory, 'hls');
    await generateFixture(sourcePath, '1280x720', true);

    const service = new MediaToolsService();
    const metadata = await service.probe(sourcePath);
    const specs = selectRenditions({
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      hasAudio: metadata.audioCodec !== null,
    });
    const generated = [];
    for (const spec of specs) {
      generated.push(
        await service.generateHlsRendition(sourcePath, hlsDirectory, spec),
      );
    }
    const masterPath = await service.generateHlsMaster(hlsDirectory, generated);

    expect(await readFile(masterPath, 'utf8')).toContain('720p/index.m3u8');
    for (const name of ['360p', '480p', '720p']) {
      const files = await readdir(join(hlsDirectory, name));
      expect(files).toContain('index.m3u8');
      expect(files.some((file) => /^segment\d{3,6}\.ts$/.test(file))).toBe(
        true,
      );
    }
    await runProcess(process.env.FFPROBE_PATH ?? 'ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      masterPath,
    ]);
  });

  it('creates only a video-only 360p variant for a 360p source', async () => {
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, 'source.mp4');
    const hlsDirectory = join(directory, 'hls');
    await generateFixture(sourcePath, '640x360', false);

    const service = new MediaToolsService();
    const metadata = await service.probe(sourcePath);
    const specs = selectRenditions({
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      hasAudio: metadata.audioCodec !== null,
    });
    expect(specs.map((spec) => spec.name)).toEqual(['360p']);
    const generated = [
      await service.generateHlsRendition(sourcePath, hlsDirectory, specs[0]!),
    ];
    await service.generateHlsMaster(hlsDirectory, generated);

    expect((await readdir(hlsDirectory)).sort()).toEqual([
      '360p',
      'master.m3u8',
    ]);
    expect(generated[0]!.spec.audioBitrateKbps).toBe(0);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-clone-media-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function generateFixture(
  outputPath: string,
  dimensions: string,
  withAudio: boolean,
): Promise<void> {
  const arguments_ = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${dimensions}:rate=30:duration=2`,
    ...(withAudio
      ? [
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=1000:sample_rate=48000:duration=2',
          '-shortest',
        ]
      : []),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(withAudio ? ['-c:a', 'aac'] : ['-an']),
    outputPath,
  ];
  await runProcess(process.env.FFMPEG_PATH ?? 'ffmpeg', arguments_);
}

function runProcess(executable: string, arguments_: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-100_000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${executable} exited with ${String(code)}: ${stderr}`),
        );
    });
  });
}
