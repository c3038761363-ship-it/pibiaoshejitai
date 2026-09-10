export type NormalizedCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RasterData = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type TracedVector = {
  viewBoxWidth: number;
  viewBoxHeight: number;
  paths: string[];
};

export type TracePreprocessOptions = {
  threshold: number;
  cleanup: number;
  invert: boolean;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function boxBlur(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
) {
  if (radius <= 0) return new Float32Array(source);

  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  const windowSize = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += source[rowOffset + clamp(offset, 0, width - 1)];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[rowOffset + x] = sum / windowSize;
      const removeX = clamp(x - radius, 0, width - 1);
      const addX = clamp(x + radius + 1, 0, width - 1);
      sum += source[rowOffset + addX] - source[rowOffset + removeX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += horizontal[clamp(offset, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = sum / windowSize;
      const removeY = clamp(y - radius, 0, height - 1);
      const addY = clamp(y + radius + 1, 0, height - 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }

  return result;
}

function removeSmallBlackAreas(
  mask: Uint8Array,
  width: number,
  height: number,
  minimumArea: number,
) {
  if (minimumArea <= 1) return mask;

  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const component = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;

    let queueStart = 0;
    let queueEnd = 1;
    let componentSize = 0;
    queue[0] = start;
    visited[start] = 1;

    while (queueStart < queueEnd) {
      const current = queue[queueStart];
      queueStart += 1;
      component[componentSize] = current;
      componentSize += 1;

      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x < width - 1 ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y < height - 1 ? current + width : -1,
      ];

      for (const next of neighbors) {
        if (next >= 0 && mask[next] === 1 && visited[next] === 0) {
          visited[next] = 1;
          queue[queueEnd] = next;
          queueEnd += 1;
        }
      }
    }

    if (componentSize < minimumArea) {
      for (let index = 0; index < componentSize; index += 1) {
        mask[component[index]] = 0;
      }
    }
  }

  return mask;
}

export function preprocessForTrace(
  source: RasterData,
  options: TracePreprocessOptions,
): RasterData {
  const { width, height } = source;
  const gray = new Float32Array(width * height);
  let grayTotal = 0;

  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const dataIndex = pixel * 4;
    const value =
      source.data[dataIndex] * 0.299 +
      source.data[dataIndex + 1] * 0.587 +
      source.data[dataIndex + 2] * 0.114;
    gray[pixel] = value;
    grayTotal += value;
  }

  const cleanup = clamp(Math.round(options.cleanup), 0, 10);
  const fineBlurRadius = Math.floor(cleanup / 2);
  const smoothed = boxBlur(gray, width, height, fineBlurRadius);
  const backgroundRadius = Math.max(
    8,
    Math.min(42, Math.round(Math.min(width, height) * 0.045)),
  );
  const localBackground = boxBlur(smoothed, width, height, backgroundRadius);
  const globalMean = grayTotal / Math.max(1, gray.length);
  const mask = new Uint8Array(width * height);
  const threshold = clamp(options.threshold, 70, 180);

  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    // A local background estimate removes slow leather shading while retaining
    // embossed/engraved edges. A small global term keeps broad dark lettering.
    const normalized =
      128 +
      (smoothed[pixel] - localBackground[pixel]) * 2.05 +
      (smoothed[pixel] - globalMean) * 0.16;
    const selected = options.invert
      ? normalized > 256 - threshold
      : normalized < threshold;
    mask[pixel] = selected ? 1 : 0;
  }

  removeSmallBlackAreas(mask, width, height, cleanup * cleanup * 2);

  const output = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const value = mask[pixel] === 1 ? 0 : 255;
    const dataIndex = pixel * 4;
    output[dataIndex] = value;
    output[dataIndex + 1] = value;
    output[dataIndex + 2] = value;
    output[dataIndex + 3] = 255;
  }

  return { width, height, data: output };
}

export function extractBlackVectorPaths(svg: string): string[] {
  const tags = svg.match(/<path\b[^>]*>/giu) ?? [];
  const safePathPattern = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/u;

  return tags.flatMap((tag) => {
    const fill = tag.match(/\bfill="([^"]+)"/iu)?.[1] ?? '';
    const opacity = Number(tag.match(/\bopacity="([^"]+)"/iu)?.[1] ?? '1');
    const path = tag.match(/\bd="([^"]+)"/iu)?.[1]?.trim() ?? '';
    const isBlack = /rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|#000(?:000)?|black/iu.test(
      fill,
    );

    if (!isBlack || opacity <= 0 || !path || !safePathPattern.test(path)) {
      return [];
    }
    return [path];
  });
}
