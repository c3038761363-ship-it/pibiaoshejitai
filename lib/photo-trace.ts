export type NormalizedPoint = {
  x: number;
  y: number;
};

export type NormalizedQuad = {
  nw: NormalizedPoint;
  ne: NormalizedPoint;
  se: NormalizedPoint;
  sw: NormalizedPoint;
};

export type RasterData = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VectorOverlay = {
  paths: string[];
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
};

export type TracedVector = {
  viewBoxWidth: number;
  viewBoxHeight: number;
  paths: string[];
  coordinateSpace?: 'artwork' | 'label';
  calibratedWidth?: number;
  calibratedHeight?: number;
  overlays?: VectorOverlay[];
  sourcePixelsPerMillimeter?: number;
  tracePixelsPerMillimeter?: number;
  manualTextCount?: number;
  expectedTextRegionCount?: number;
  photoTextRegionCount?: number;
  fontTextRegionCount?: number;
  tracedGraphicRegionCount?: number;
  geometricRegionCount?: number;
  traceVersionId?: string;
  productionBlockedReasons?: string[];
  qualityWarnings?: string[];
  excludedRegionCount?: number;
  reconstructedFromConfirmedRegions?: boolean;
};

export type TracePreprocessOptions = {
  detailSensitivity: number;
  cleanup: number;
  edgeCleanupPercent: number;
  preserveCanvas?: boolean;
  preserveFineDetail?: boolean;
  polarity?: 'auto' | 'dark' | 'light';
  pixelsPerMillimeter?: number;
  minimumFeatureMm?: number;
  fillSmallHoles?: boolean;
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

function extremaFilter2D(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
  maximum: boolean,
) {
  if (radius <= 0) return new Float32Array(source);

  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  const windowSize = radius * 2 + 1;
  const queueCapacity = Math.max(width, height) + radius * 2;
  const queueIndices = new Int32Array(queueCapacity);
  const queueValues = new Float32Array(queueCapacity);

  function filterLine(
    input: Float32Array,
    output: Float32Array,
    start: number,
    stride: number,
    length: number,
  ) {
    let queueStart = 0;
    let queueEnd = 0;
    const virtualLength = length + radius * 2;

    for (let position = 0; position < virtualLength; position += 1) {
      const sourcePosition = clamp(position - radius, 0, length - 1);
      const value = input[start + sourcePosition * stride];
      while (
        queueEnd > queueStart &&
        (maximum
          ? value >= queueValues[queueEnd - 1]
          : value <= queueValues[queueEnd - 1])
      ) {
        queueEnd -= 1;
      }
      queueIndices[queueEnd] = position;
      queueValues[queueEnd] = value;
      queueEnd += 1;

      const firstVisiblePosition = position - (windowSize - 1);
      while (
        queueEnd > queueStart &&
        queueIndices[queueStart] < firstVisiblePosition
      ) {
        queueStart += 1;
      }

      if (position >= windowSize - 1) {
        const outputPosition = position - (windowSize - 1);
        output[start + outputPosition * stride] = queueValues[queueStart];
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    filterLine(source, horizontal, y * width, 1, width);
  }
  for (let x = 0; x < width; x += 1) {
    filterLine(horizontal, result, x, width, height);
  }

  return result;
}

function structuralResponse(upper: Float32Array, lower: Float32Array) {
  const response = new Uint8Array(upper.length);
  for (let pixel = 0; pixel < response.length; pixel += 1) {
    response[pixel] = clamp(
      Math.round(Math.max(0, upper[pixel] - lower[pixel])),
      0,
      255,
    );
  }
  return response;
}

function analysisBounds(
  width: number,
  height: number,
  edgeCleanupPercent: number,
) {
  const percentage = clamp(edgeCleanupPercent, 0, 20);
  const marginX = Math.min(
    Math.floor((width - 1) / 2),
    Math.max(0, Math.round((width * percentage) / 100)),
  );
  const marginY = Math.min(
    Math.floor((height - 1) / 2),
    Math.max(0, Math.round((height * percentage) / 100)),
  );
  return {
    left: marginX,
    top: marginY,
    right: width - marginX,
    bottom: height - marginY,
  };
}

function otsuThreshold(
  response: Uint8Array,
  width: number,
  bounds: ReturnType<typeof analysisBounds>,
) {
  const histogram = new Uint32Array(256);
  let total = 0;
  let totalSum = 0;

  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const value = response[y * width + x];
      histogram[value] += 1;
      total += 1;
      totalSum += value;
    }
  }

  let backgroundCount = 0;
  let backgroundSum = 0;
  let bestThreshold = 0;
  let bestVariance = -1;

  for (let value = 0; value < histogram.length; value += 1) {
    backgroundCount += histogram[value];
    backgroundSum += value * histogram[value];
    const foregroundCount = total - backgroundCount;
    if (backgroundCount === 0) continue;
    if (foregroundCount === 0) break;

    const backgroundMean = backgroundSum / backgroundCount;
    const foregroundMean = (totalSum - backgroundSum) / foregroundCount;
    const difference = backgroundMean - foregroundMean;
    const variance =
      backgroundCount * foregroundCount * difference * difference;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = value;
    }
  }

  return bestThreshold;
}

function responseCandidate(
  response: Uint8Array,
  width: number,
  height: number,
  bounds: ReturnType<typeof analysisBounds>,
  detailSensitivity: number,
) {
  const sensitivity = clamp(detailSensitivity, 0, 100);
  const threshold = clamp(
    Math.round(
      otsuThreshold(response, width, bounds) + 4 + (50 - sensitivity) * 0.12,
    ),
    4,
    180,
  );
  const mask = new Uint8Array(response.length);
  let selectedInside = 0;
  const totalInside = Math.max(
    1,
    (bounds.right - bounds.left) * (bounds.bottom - bounds.top),
  );

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (response[pixel] < threshold) continue;
      mask[pixel] = 1;
      if (
        x >= bounds.left &&
        x < bounds.right &&
        y >= bounds.top &&
        y < bounds.bottom
      ) {
        selectedInside += 1;
      }
    }
  }

  return { mask, fraction: selectedInside / totalInside };
}

function chooseStructuralMask(
  dark: ReturnType<typeof responseCandidate>,
  light: ReturnType<typeof responseCandidate>,
) {
  const isUseful = (fraction: number) => fraction >= 0.01 && fraction <= 0.42;
  const darkIsUseful = isUseful(dark.fraction);
  const lightIsUseful = isUseful(light.fraction);

  if (darkIsUseful && !lightIsUseful) return dark.mask;
  if (lightIsUseful && !darkIsUseful) return light.mask;
  // The sparser response is often just the photographed stitch or a pair of
  // rules. Do not discard a usable lettering candidate for that reason.
  if (dark.fraction < 0.025 && light.fraction >= 0.025 && light.fraction <= 0.42)
    return light.mask;
  if (light.fraction < 0.025 && dark.fraction >= 0.025 && dark.fraction <= 0.42)
    return dark.mask;
  return dark.fraction <= light.fraction ? dark.mask : light.mask;
}

function closeSinglePixelGaps(mask: Uint8Array, width: number, height: number) {
  const dilated = new Uint8Array(mask.length);
  const closed = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let selected = false;
      for (let offsetY = -1; offsetY <= 1 && !selected; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (
            nextX >= 0 &&
            nextX < width &&
            nextY >= 0 &&
            nextY < height &&
            mask[nextY * width + nextX] === 1
          ) {
            selected = true;
            break;
          }
        }
      }
      dilated[y * width + x] = selected ? 1 : 0;
    }
  }

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let selected = true;
      for (let offsetY = -1; offsetY <= 1 && selected; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (dilated[(y + offsetY) * width + x + offsetX] === 0) {
            selected = false;
            break;
          }
        }
      }
      closed[y * width + x] = selected ? 1 : 0;
    }
  }

  return closed;
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

function fillSmallWhiteHoles(
  mask: Uint8Array,
  width: number,
  height: number,
  maximumArea: number,
) {
  if (maximumArea < 1) return mask;

  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const component = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 1 || visited[start] === 1) continue;

    let queueStart = 0;
    let queueEnd = 1;
    let componentSize = 0;
    let touchesEdge = false;
    queue[0] = start;
    visited[start] = 1;

    while (queueStart < queueEnd) {
      const current = queue[queueStart];
      queueStart += 1;
      component[componentSize] = current;
      componentSize += 1;

      const x = current % width;
      const y = Math.floor(current / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesEdge = true;
      }
      const neighbours = [current - 1, current + 1, current - width, current + width];
      for (const next of neighbours) {
        if (next < 0 || next >= mask.length) continue;
        const nextX = next % width;
        const nextY = Math.floor(next / width);
        if (Math.abs(nextX - x) + Math.abs(nextY - y) !== 1) continue;
        if (mask[next] === 0 && visited[next] === 0) {
          visited[next] = 1;
          queue[queueEnd] = next;
          queueEnd += 1;
        }
      }
    }

    if (!touchesEdge && componentSize <= maximumArea) {
      for (let index = 0; index < componentSize; index += 1) {
        mask[component[index]] = 1;
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

function maskToRaster(mask: Uint8Array, width: number, height: number) {
  const output = new Uint8ClampedArray(width * height * 4);

  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const value = mask[pixel] === 1 ? 0 : 255;
    const outputIndex = pixel * 4;
    output[outputIndex] = value;
    output[outputIndex + 1] = value;
    output[outputIndex + 2] = value;
    output[outputIndex + 3] = 255;
  }

  return { width, height, data: output };
}

export function eraseRasterRegions(
  source: RasterData,
  regions: NormalizedRect[],
): RasterData {
  if (regions.length === 0) return source;
  const output = new Uint8ClampedArray(source.data);
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x * source.width));
    const top = Math.max(0, Math.floor(region.y * source.height));
    const right = Math.min(
      source.width,
      Math.ceil((region.x + region.width) * source.width),
    );
    const bottom = Math.min(
      source.height,
      Math.ceil((region.y + region.height) * source.height),
    );
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const pixel = (y * source.width + x) * 4;
        output[pixel] = 255;
        output[pixel + 1] = 255;
        output[pixel + 2] = 255;
        output[pixel + 3] = 255;
      }
    }
  }
  return { ...source, data: output };
}

export function restoreRasterRegions(
  base: RasterData,
  detail: RasterData,
  regions: NormalizedRect[],
): RasterData {
  if (regions.length === 0) return base;
  if (base.width !== detail.width || base.height !== detail.height)
    throw new Error('细线预览与成品坐标不一致，请重新生成。');
  const output = new Uint8ClampedArray(base.data);
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x * base.width));
    const top = Math.max(0, Math.floor(region.y * base.height));
    const right = Math.min(
      base.width,
      Math.ceil((region.x + region.width) * base.width),
    );
    const bottom = Math.min(
      base.height,
      Math.ceil((region.y + region.height) * base.height),
    );
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const pixel = (y * base.width + x) * 4;
        output[pixel] = detail.data[pixel];
        output[pixel + 1] = detail.data[pixel + 1];
        output[pixel + 2] = detail.data[pixel + 2];
        output[pixel + 3] = 255;
      }
    }
  }
  return { ...base, data: output };
}

export function preprocessForTrace(
  source: RasterData,
  options: TracePreprocessOptions,
): RasterData {
  const { width, height } = source;
  const gray = new Float32Array(width * height);

  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const dataIndex = pixel * 4;
    const value =
      source.data[dataIndex] * 0.299 +
      source.data[dataIndex + 1] * 0.587 +
      source.data[dataIndex + 2] * 0.114;
    gray[pixel] = value;
  }

  const cleanup = clamp(Math.round(options.cleanup), 0, 10);
  // Small photographed letters can be only a few pixels tall. Blurring and
  // closing a 3x3 neighbourhood must be an explicit smoothing choice, not the
  // default: both operations can irreversibly join letters and fill counters.
  const preserveFineDetail = options.preserveFineDetail !== false;
  const fineBlurRadius = preserveFineDetail ? 0 : Math.floor(cleanup / 5) + 1;
  const smoothed = boxBlur(gray, width, height, fineBlurRadius);
  const minimumDimension = Math.min(width, height);
  const largestOddKernel = Math.max(
    1,
    Math.min(
      111,
      minimumDimension % 2 === 0 ? minimumDimension - 1 : minimumDimension,
    ),
  );
  let kernelSize = clamp(Math.round(minimumDimension * 0.35), 31, 111);
  if (kernelSize % 2 === 0) kernelSize += 1;
  kernelSize = Math.min(kernelSize, largestOddKernel);
  const morphologyRadius = Math.floor(kernelSize / 2);

  // A large closing estimates the leather surface above dark artwork; a large
  // opening estimates it below light artwork. Comparing both directions makes
  // the result independent of whether the photographed press mark is dark or
  // light, while retaining filled letterforms for stamping instead of turning
  // every stroke into a pair of hollow edge lines.
  const expanded = extremaFilter2D(
    smoothed,
    width,
    height,
    morphologyRadius,
    true,
  );
  const closing = extremaFilter2D(
    expanded,
    width,
    height,
    morphologyRadius,
    false,
  );
  const contracted = extremaFilter2D(
    smoothed,
    width,
    height,
    morphologyRadius,
    false,
  );
  const opening = extremaFilter2D(
    contracted,
    width,
    height,
    morphologyRadius,
    true,
  );
  const darkResponse = structuralResponse(closing, smoothed);
  const lightResponse = structuralResponse(smoothed, opening);
  const bounds = analysisBounds(width, height, options.edgeCleanupPercent);
  const darkCandidate = responseCandidate(
    darkResponse,
    width,
    height,
    bounds,
    options.detailSensitivity,
  );
  const lightCandidate = responseCandidate(
    lightResponse,
    width,
    height,
    bounds,
    options.detailSensitivity,
  );
  let mask =
    options.polarity === 'dark'
      ? darkCandidate.mask
      : options.polarity === 'light'
        ? lightCandidate.mask
        : chooseStructuralMask(darkCandidate, lightCandidate);

  removeEdgeConnectedBlackAreas(
    mask,
    width,
    height,
    options.edgeCleanupPercent,
  );
  if (!preserveFineDetail) mask = closeSinglePixelGaps(mask, width, height);
  const physicalFeaturePixels =
    (options.minimumFeatureMm ?? 0) * (options.pixelsPerMillimeter ?? 0);
  const physicalFeatureArea = Math.max(
    0,
    Math.round(Math.PI * (physicalFeaturePixels / 2) ** 2),
  );
  removeSmallBlackAreas(
    mask,
    width,
    height,
    physicalFeatureArea > 0 && !preserveFineDetail
      ? physicalFeatureArea
      : preserveFineDetail
      ? Math.max(1, Math.floor(cleanup / 5))
      : cleanup === 0
        ? 1
        : Math.max(2, Math.round((cleanup * cleanup) / 2)),
  );
  if (options.fillSmallHoles && physicalFeatureArea > 0) {
    fillSmallWhiteHoles(mask, width, height, physicalFeatureArea);
  }

  // A label-coordinate trace keeps the full corrected label canvas so every
  // letter and line retains its original physical position. The older artwork
  // workflow can still request a tightly trimmed raster.
  return options.preserveCanvas
    ? maskToRaster(mask, width, height)
    : maskToTrimmedRaster(mask, width, height);
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
