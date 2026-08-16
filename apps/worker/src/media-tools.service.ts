import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { workerEnvironment } from './config.js';
import {
  fitWithin720p,
  parseProbeOutput,
  type MediaMetadata,
} from './media-metadata.js';
import { ProcessingError } from './processing-error.js';
import {
  createMasterPlaylist,
  type GeneratedRendition,
  type RenditionSpec,
} from './hls-renditions.js';

const HLS_SEGMENT_DURATION_SECONDS = 6;

@Injectable()
export class MediaToolsService {
  async checkReady(): Promise<void> {
    await Promise.all([
      this.run(workerEnvironment.FFMPEG_PATH, ['-version'], 'ffmpeg readiness'),
      this.run(
        workerEnvironment.FFPROBE_PATH,
        ['-version'],
        'ffprobe readiness',
      ),
    ]);
  }

  async probe(inputPath: string): Promise<MediaMetadata> {
    const stdout = await this.run(
      workerEnvironment.FFPROBE_PATH,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputPath,
      ],
      'ffprobe',
    );
    const metadata = parseProbeOutput(stdout);
    if (
      metadata.durationSeconds > workerEnvironment.MAX_VIDEO_DURATION_SECONDS
    ) {
      throw new ProcessingError(
        `Video duration ${metadata.durationSeconds}s exceeds the configured ${workerEnvironment.MAX_VIDEO_DURATION_SECONDS}s limit`,
        false,
        'The uploaded video is too long',
      );
    }
    return metadata;
  }

  async generateThumbnail(
    inputPath: string,
    outputPath: string,
    metadata: MediaMetadata,
  ): Promise<{ width: number; height: number }> {
    const size = fitWithin720p(metadata.width, metadata.height);
    const timestamp = Math.max(
      0,
      Math.min(metadata.durationSeconds * 0.1, metadata.durationSeconds - 0.05),
    );
    await this.run(
      workerEnvironment.FFMPEG_PATH,
      [
        '-y',
        '-ss',
        timestamp.toFixed(3),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${size.width}:${size.height}`,
        '-q:v',
        '3',
        outputPath,
      ],
      'thumbnail generation',
    );
    return size;
  }

  async generateHlsRendition(
    inputPath: string,
    outputDirectory: string,
    spec: RenditionSpec,
  ): Promise<GeneratedRendition> {
    const renditionDirectory = join(outputDirectory, spec.name);
    await mkdir(renditionDirectory, { recursive: true });
    const audioArguments =
      spec.audioBitrateKbps > 0
        ? ['-c:a', 'aac', '-b:a', `${spec.audioBitrateKbps}k`, '-ac', '2']
        : ['-an'];
    await this.run(
      workerEnvironment.FFMPEG_PATH,
      [
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        `scale=${spec.width}:${spec.height}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        `${spec.videoBitrateKbps}k`,
        '-maxrate',
        `${spec.videoBitrateKbps}k`,
        '-bufsize',
        `${spec.videoBitrateKbps * 2}k`,
        '-pix_fmt',
        'yuv420p',
        '-sc_threshold',
        '0',
        '-force_key_frames',
        `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION_SECONDS})`,
        ...audioArguments,
        '-hls_time',
        String(HLS_SEGMENT_DURATION_SECONDS),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_filename',
        join(renditionDirectory, 'segment%03d.ts'),
        join(renditionDirectory, 'index.m3u8'),
      ],
      `${spec.name} HLS transcoding`,
    );
    const segmentCount = (await readdir(renditionDirectory)).filter((name) =>
      /^segment\d{3,6}\.ts$/.test(name),
    ).length;
    if (segmentCount === 0) {
      throw new ProcessingError(
        `${spec.name} transcoding produced no HLS segments`,
        false,
        'The video could not be packaged for playback',
      );
    }
    return {
      spec,
      manifestPath: join(renditionDirectory, 'index.m3u8'),
      segmentCount,
    };
  }

  async generateHlsMaster(
    outputDirectory: string,
    renditions: readonly GeneratedRendition[],
  ): Promise<string> {
    const manifestPath = join(outputDirectory, 'master.m3u8');
    await writeFile(manifestPath, createMasterPlaylist(renditions), 'utf8');
    return manifestPath;
  }

  private run(
    executable: string,
    args: string[],
    operation: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const append = (current: string, chunk: Buffer) =>
        (current + chunk.toString()).slice(-2_000_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, workerEnvironment.MEDIA_PROCESS_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(
          new ProcessingError(
            `${operation} could not start: ${error.message}`,
            false,
            'The media processor is unavailable',
            { cause: error },
          ),
        );
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(
            new ProcessingError(
              `${operation} timed out`,
              true,
              'Video processing timed out',
            ),
          );
        } else if (code !== 0) {
          reject(
            new ProcessingError(
              `${operation} failed with exit code ${String(code)}: ${stderr}`,
              false,
              operation === 'ffprobe'
                ? 'The uploaded file is not a valid video'
                : 'The video could not be transcoded',
            ),
          );
        } else {
          resolve(stdout);
        }
      });
    });
  }
}
