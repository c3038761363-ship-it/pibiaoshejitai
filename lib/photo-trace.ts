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
  edgeCleanupPercent: number;
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
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
            continue;
          }
          const next = nextY * width + nextX;
          if (mask[next] === 1 && visited[next] === 0) {
            visited[next] = 1;
            queue[queueEnd] = next;
            queueEnd += 1;
          }
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

function removeEdgeConnectedBlackAreas(
  mask: Uint8Array,
  width: number,
  height: number,
  edgeCleanupPercent: number,
) {
  const percentage = clamp(edgeCleanupPercent, 0, 20);
  if (percentage === 0) return mask;

  const marginX = Math.max(1, Math.round((width * percentage) / 100));
  const marginY = Math.max(1, Math.round((height * percentage) / 100));
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const component = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;

    let queueStart = 0;
    let queueEnd = 1;
    let componentSize = 0;
    let edgePixelCount = 0;
    let minimumX = width;
    let minimumY = height;
    let maximumX = -1;
    let maximumY = -1;
    queue[0] = start;
    visited[start] = 1;

    while (queueStart < queueEnd) {
      const current = queue[queueStart];
      queueStart += 1;
      component[componentSize] = current;
      componentSize += 1;

      const x = current % width;
      const y = Math.floor(current / width);
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      if (
        x < marginX ||
        x >= width - marginX ||
        y < marginY ||
        y >= height - marginY
      ) {
        edgePixelCount += 1;
      }

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
            continue;
          }
          const next = nextY * width + nextX;
          if (mask[next] === 1 && visited[next] === 0) {
            visited[next] = 1;
            queue[queueEnd] = next;
            queueEnd += 1;
          }
        }
      }
    }

    const mostlyInEdgeBand = edgePixelCount / componentSize >= 0.7;
    const looksLikeSurroundingFrame =
      edgePixelCount > 0 &&
      (maximumX - minimumX + 1) / width >= 0.72 &&
      (maximumY - minimumY + 1) / height >= 0.72;

    if (mostlyInEdgeBand || looksLikeSurroundingFrame) {
      for (let index = 0; index < componentSize; index += 1) {
        mask[component[index]] = 0;
      }
    }
  }

  return mask;
}

function maskToTrimmedRaster(mask: Uint8Array, width: number, height: number) {
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;

  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (mask[pixel] === 0) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
  }

  if (maximumX < minimumX || maximumY < minimumY) {
    return {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(2 * 2 * 4).fill(255),
    };
  }

  const inkWidth = maximumX - minimumX + 1;
  const inkHeight = maximumY - minimumY + 1;
  const padding = Math.max(
    2,
    Math.round(Math.max(inkWidth, inkHeight) * 0.025),
  );
  const left = Math.max(0, minimumX - padding);
  const top = Math.max(0, minimumY - padding);
  const right = Math.min(width - 1, maximumX + padding);
  const bottom = Math.min(height - 1, maximumY + padding);
  const outputWidth = right - left + 1;
  const outputHeight = bottom - top + 1;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);

  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const sourcePixel = (top + y) * width + left + x;
      const value = mask[sourcePixel] === 1 ? 0 : 255;
      const outputIndex = (y * outputWidth + x) * 4;
      output[outputIndex] = value;
      output[outputIndex + 1] = value;
      output[outputIndex + 2] = value;
      output[outputIndex + 3] = 255;
    }
  }

  return { width: outputWidth, height: outputHeight, data: output };
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

  removeEdgeConnectedBlackAreas(
    mask,
    width,
    height,
    options.edgeCleanupPercent,
  );
  removeSmallBlackAreas(mask, width, height, cleanup * cleanup * 2);

  // Trimming after removing the old label body makes the new vector scale from
  // the artwork itself instead of from the customer's photographed leather.
  return maskToTrimmedRaster(mask, width, height);
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
