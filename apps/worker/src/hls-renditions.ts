export interface RenditionSpec {
  name: 'source' | '360p' | '480p' | '720p';
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  bandwidthBitsPerSecond: number;
}

export interface GeneratedRendition {
  spec: RenditionSpec;
  manifestPath: string;
  segmentCount: number;
}

interface LadderEntry {
  name: '360p' | '480p' | '720p';
  targetHeight: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

const RENDITION_LADDER: readonly LadderEntry[] = [
  {
    name: '360p',
    targetHeight: 360,
    videoBitrateKbps: 800,
    audioBitrateKbps: 96,
  },
  {
    name: '480p',
    targetHeight: 480,
    videoBitrateKbps: 1_400,
    audioBitrateKbps: 128,
  },
  {
    name: '720p',
    targetHeight: 720,
    videoBitrateKbps: 2_800,
    audioBitrateKbps: 128,
  },
];

const HLS_CONTAINER_OVERHEAD_PERCENT = 10;

export function selectRenditions(input: {
  sourceWidth: number;
  sourceHeight: number;
  hasAudio?: boolean;
}): RenditionSpec[] {
  assertUsableDimensions(input.sourceWidth, input.sourceHeight);
  const selected = RENDITION_LADDER.filter(
    (rendition) => rendition.targetHeight <= input.sourceHeight,
  ).map((rendition) => {
    const dimensions = scaleToHeight(
      input.sourceWidth,
      input.sourceHeight,
      rendition.targetHeight,
    );
    return createSpec(rendition, dimensions, input.hasAudio ?? true);
  });
  if (selected.length > 0) return selected;

  const dimensions = scaleToHeight(
    input.sourceWidth,
    input.sourceHeight,
    input.sourceHeight,
  );
  return [
    createSpec(
      {
        name: 'source',
        targetHeight: dimensions.height,
        videoBitrateKbps: 800,
        audioBitrateKbps: 96,
      },
      dimensions,
      input.hasAudio ?? true,
    ),
  ];
}

export function createMasterPlaylist(
  renditions: readonly GeneratedRendition[],
): string {
  if (renditions.length === 0)
    throw new Error('A master playlist requires at least one rendition');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const rendition of renditions) {
    const { spec } = rendition;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${spec.bandwidthBitsPerSecond},RESOLUTION=${spec.width}x${spec.height}`,
      `${spec.name}/index.m3u8`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function createSpec(
  entry: Omit<LadderEntry, 'name'> & { name: RenditionSpec['name'] },
  dimensions: { width: number; height: number },
  hasAudio: boolean,
): RenditionSpec {
  const audioBitrateKbps = hasAudio ? entry.audioBitrateKbps : 0;
  return {
    name: entry.name,
    ...dimensions,
    videoBitrateKbps: entry.videoBitrateKbps,
    audioBitrateKbps,
    bandwidthBitsPerSecond:
      Math.ceil(
        ((entry.videoBitrateKbps + audioBitrateKbps) *
          (100 + HLS_CONTAINER_OVERHEAD_PERCENT)) /
          100,
      ) * 1_000,
  };
}

function scaleToHeight(
  sourceWidth: number,
  sourceHeight: number,
  targetHeight: number,
): { width: number; height: number } {
  const scale = Math.min(1, targetHeight / sourceHeight);
  return {
    width: nearestEvenWithoutUpscale(sourceWidth * scale, sourceWidth),
    height: nearestEvenWithoutUpscale(sourceHeight * scale, sourceHeight),
  };
}

function nearestEvenWithoutUpscale(value: number, sourceDimension: number) {
  const largestSourceEven = Math.floor(sourceDimension / 2) * 2;
  return Math.max(2, Math.min(largestSourceEven, Math.round(value / 2) * 2));
}

function assertUsableDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2
  ) {
    throw new RangeError('Source dimensions must be integers of at least 2px');
  }
}
