import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { workerEnvironment } from './config.js';
import {
  fitWithin720p,
  parseProbeOutput,
  type MediaMetadata,
} from './media-metadata.js';
import { ProcessingError } from './processing-error.js';

@Injectable()
export class MediaToolsService {
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
    return parseProbeOutput(stdout);
  }

  async generateThumbnail(
    inputPath: string,
    outputPath: string,
    metadata: MediaMetadata,
  ): Promise<void> {
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
  }

  async generateHls(
    inputPath: string,
    outputDirectory: string,
    metadata: MediaMetadata,
  ): Promise<{ width: number; height: number }> {
    await mkdir(outputDirectory, { recursive: true });
    const size = fitWithin720p(metadata.width, metadata.height);
    await this.run(
      workerEnvironment.FFMPEG_PATH,
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        `scale=${size.width}:${size.height}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-hls_time',
        '4',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        join(outputDirectory, 'segment%03d.ts'),
        join(outputDirectory, 'index.m3u8'),
      ],
      'HLS transcoding',
    );
    return size;
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
