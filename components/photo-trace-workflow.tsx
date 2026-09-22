'use client';

import {
  Check,
  Crop,
  History,
  LoaderCircle,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  WandSparkles,
} from 'lucide-react';
import {
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { DimensionInput, RangeField } from '@/components/leather-label-ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  confirmedTextCurve,
  validateCustomCurveFont,
  type CurveFontChoiceId,
} from '@/lib/vector-font';
import {
  clearPhotoTraceDraft,
  loadPhotoTraceDraft,
  savePhotoTraceDraft,
} from '@/lib/photo-trace-draft';
import {
  eraseRasterRegions,
  extractBlackVectorPaths,
  preprocessForTrace,
  type NormalizedPoint,
  type NormalizedQuad,
  type NormalizedRect,
  type RasterData,
  type TracePreprocessOptions,
  type TracedVector,
  type VectorOverlay,
} from '@/lib/photo-trace';

type PhotoSource = {
  name: string;
  url: string;
  width: number;
  height: number;
  fingerprint: string;
};

type DragOperation = {
  mode: 'draw' | 'move' | 'corner';
  corner?: keyof NormalizedQuad;
  startX: number;
  startY: number;
  startQuad: NormalizedQuad;
};

type PhotoViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CorrectionRegion = {
  id: number;
  kind: 'erase' | 'text' | 'keep' | 'line' | 'arrow';
  rect: NormalizedRect;
  text?: string;
  textShapeSource?: 'photo-outline' | 'font-outline';
  fontId?: string;
  fontName?: string;
  fontData?: ArrayBuffer;
  polarity?: 'dark' | 'light';
  detailMode?: 'clean' | 'distressed';
  confirmedNoText?: boolean;
  start?: NormalizedPoint;
  end?: NormalizedPoint;
};

type RemovedCorrection = {
  correction: CorrectionRegion;
  index: number;
};

type PhotoTraceDraftSettings = {
  version: string;
  savedAt: number;
  quad: NormalizedQuad;
  detailSensitivity: number;
  cleanup: number;
  edgeCleanupPercent: number;
  preserveFineDetail: boolean;
  rebuildFromConfirmedRegions: boolean;
  polarity: 'auto' | 'dark' | 'light';
  targetWidthInput: string;
  targetHeightInput: string;
  replaceCurrentDesign: boolean;
  corrections: CorrectionRegion[];
  expectedTextRegionCountInput: string;
};

const PHOTO_TRACE_DRAFT_VERSION = 'photo-trace-v6';
const PHOTO_DETAIL_LOW_PPM = 8;
const PHOTO_DETAIL_CLEAR_PPM = 16;
const TRACE_WORKING_PPM = 16;
const DEFAULT_MINIMUM_FEATURE_MM = 0.2;

const FULL_PHOTO_VIEWPORT: PhotoViewport = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

const DEFAULT_QUAD: NormalizedQuad = {
  nw: { x: 0, y: 0 },
  ne: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  sw: { x: 0, y: 1 },
};

const QUAD_CORNERS = ['nw', 'ne', 'se', 'sw'] as const;
const CORNER_LABELS: Record<keyof NormalizedQuad, string> = {
  nw: '左上',
  ne: '右上',
  se: '右下',
  sw: '左下',
};

export type PhotoTraceApplyResult = {
  name: string;
  vector: TracedVector;
  targetWidth: number;
  targetHeight: number;
  replaceCurrentDesign: boolean;
};

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatInputMillimeters(value: number) {
  return Number(value.toFixed(1)).toString();
}

function validateTargetSize(widthInput: string, heightInput: string) {
  const pattern = /^\d+(?:\.\d)?$/;
  if (!pattern.test(widthInput) || !pattern.test(heightInput)) {
    return { error: '宽高必须填写数字，最多保留1位小数。', value: null };
  }
  const width = Number(widthInput);
  const height = Number(heightInput);
  if (width < 10 || width > 200 || height < 10 || height > 150) {
    return {
      error: '成品宽度须为10–200 mm，高度须为10–150 mm。',
      value: null,
    };
  }
  return { error: '', value: { width, height } };
}

function cloneQuad(quad: NormalizedQuad): NormalizedQuad {
  return {
    nw: { ...quad.nw },
    ne: { ...quad.ne },
    se: { ...quad.se },
    sw: { ...quad.sw },
  };
}

function shortSignature(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function rectanglesOverlap(left: NormalizedRect, right: NormalizedRect) {
  const overlapWidth =
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x);
  const overlapHeight =
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y);
  return overlapWidth > 0.0005 && overlapHeight > 0.0005;
}

type CorrectionOverlapDescriptor = Pick<
  CorrectionRegion,
  'kind' | 'textShapeSource'
>;

function isPhotographedRasterRegion(region: CorrectionOverlapDescriptor) {
  return (
    region.kind === 'keep' ||
    (region.kind === 'text' && region.textShapeSource === 'photo-outline')
  );
}

function isAllowedCorrectionOverlap(
  left: CorrectionOverlapDescriptor,
  right: CorrectionOverlapDescriptor,
) {
  return (
    (left.kind === 'erase' && isPhotographedRasterRegion(right)) ||
    (right.kind === 'erase' && isPhotographedRasterRegion(left))
  );
}

function confirmedContentBoundsMm(
  corrections: CorrectionRegion[],
  widthMm: number,
  heightMm: number,
) {
  const included = corrections.filter(
    (correction) => correction.kind !== 'erase',
  );
  if (included.length === 0) return undefined;
  const left = Math.min(...included.map((correction) => correction.rect.x));
  const top = Math.min(...included.map((correction) => correction.rect.y));
  const right = Math.max(
    ...included.map((correction) => correction.rect.x + correction.rect.width),
  );
  const bottom = Math.max(
    ...included.map((correction) => correction.rect.y + correction.rect.height),
  );
  return {
    x: left * widthMm,
    y: top * heightMm,
    width: (right - left) * widthMm,
    height: (bottom - top) * heightMm,
  };
}

function rasterRegionTouchesInkEdge(
  raster: RasterData,
  rect: NormalizedRect,
  bandPixels: number,
) {
  const left = Math.max(0, Math.floor(rect.x * raster.width));
  const top = Math.max(0, Math.floor(rect.y * raster.height));
  const right = Math.min(
    raster.width,
    Math.ceil((rect.x + rect.width) * raster.width),
  );
  const bottom = Math.min(
    raster.height,
    Math.ceil((rect.y + rect.height) * raster.height),
  );
  const band = Math.max(
    1,
    Math.min(
      bandPixels,
      Math.floor((right - left) / 2),
      Math.floor((bottom - top) / 2),
    ),
  );
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const nearEdge =
        x < left + band ||
        x >= right - band ||
        y < top + band ||
        y >= bottom - band;
      if (nearEdge && raster.data[(y * raster.width + x) * 4] === 0) {
        return true;
      }
    }
  }
  return false;
}

function formatSavedTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

async function fingerprintBlob(blob: Blob) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function nearestCorner(
  x: number,
  y: number,
  quad: NormalizedQuad,
  viewport: PhotoViewport,
) {
  return QUAD_CORNERS.find((corner) => {
    const point = quad[corner];
    return (
      Math.hypot(
        (point.x - x) / viewport.width,
        (point.y - y) / viewport.height,
      ) < 0.055
    );
  });
}

function viewportAroundQuad(quad: NormalizedQuad): PhotoViewport {
  const points = QUAD_CORNERS.map((corner) => quad[corner]);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.min(1, Math.max(0.12, (maxX - minX) * 1.25));
  const height = Math.min(1, Math.max(0.12, (maxY - minY) * 1.25));
  return {
    x: clamp((minX + maxX - width) / 2, 0, 1 - width),
    y: clamp((minY + maxY - height) / 2, 0, 1 - height),
    width,
    height,
  };
}

function pointInQuad(x: number, y: number, quad: NormalizedQuad) {
  const points = QUAD_CORNERS.map((corner) => quad[corner]);
  let inside = false;
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current, current += 1
  ) {
    const a = points[current];
    const b = points[previous];
    const crosses =
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function validateQuad(quad: NormalizedQuad) {
  const points = QUAD_CORNERS.map((corner) => quad[corner]);
  const crossProducts = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    return (
      (next.x - point.x) * (after.y - next.y) -
      (next.y - point.y) * (after.x - next.x)
    );
  });
  const direction = Math.sign(
    crossProducts.find((value) => Math.abs(value) > 1e-5) ?? 0,
  );
  const isConvex =
    direction !== 0 &&
    crossProducts.every(
      (value) => Math.abs(value) > 1e-5 && Math.sign(value) === direction,
    );
  const area = Math.abs(
    points.reduce((total, point, index) => {
      const next = points[(index + 1) % points.length];
      return total + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );

  const cornersKeepTheirMeaning =
    quad.nw.x < quad.ne.x &&
    quad.sw.x < quad.se.x &&
    quad.nw.y < quad.sw.y &&
    quad.ne.y < quad.se.y;

  if (!isConvex || direction < 0 || !cornersKeepTheirMeaning)
    return '四角线发生交叉，请把白点依次放在左上、右上、右下、左下。';
  if (area < 0.0025) return '选择范围太小，请重新框选整块皮牌。';
  return '';
}

function interpolatePoint(
  first: NormalizedPoint,
  second: NormalizedPoint,
  amount: number,
) {
  return {
    x: first.x + (second.x - first.x) * amount,
    y: first.y + (second.y - first.y) * amount,
  };
}

function distanceInSourcePixels(
  first: NormalizedPoint,
  second: NormalizedPoint,
  sourceWidth: number,
  sourceHeight: number,
) {
  return Math.hypot(
    (second.x - first.x) * Math.max(1, sourceWidth - 1),
    (second.y - first.y) * Math.max(1, sourceHeight - 1),
  );
}

function rectangleToQuad(
  startX: number,
  startY: number,
  pointerX: number,
  pointerY: number,
): NormalizedQuad {
  const left = Math.min(startX, pointerX);
  const top = Math.min(startY, pointerY);
  const right = Math.max(startX, pointerX);
  const bottom = Math.max(startY, pointerY);
  return {
    nw: { x: left, y: top },
    ne: { x: right, y: top },
    se: { x: right, y: bottom },
    sw: { x: left, y: bottom },
  };
}

function getSourcePixelsPerMillimeter(
  sourceWidth: number,
  sourceHeight: number,
  quad: NormalizedQuad,
  targetWidth: number,
  targetHeight: number,
) {
  const horizontalPixels = Math.min(
    distanceInSourcePixels(quad.nw, quad.ne, sourceWidth, sourceHeight),
    distanceInSourcePixels(quad.sw, quad.se, sourceWidth, sourceHeight),
  );
  const verticalPixels = Math.min(
    distanceInSourcePixels(quad.nw, quad.sw, sourceWidth, sourceHeight),
    distanceInSourcePixels(quad.ne, quad.se, sourceWidth, sourceHeight),
  );
  return Math.max(
    0.1,
    Math.min(horizontalPixels / targetWidth, verticalPixels / targetHeight),
  );
}

function createRectifiedRaster(
  image: HTMLImageElement,
  sourceWidth: number,
  sourceHeight: number,
  quad: NormalizedQuad,
  targetWidth: number,
  targetHeight: number,
  maximumLongSide: number,
): RasterData {
  const sourcePoints = QUAD_CORNERS.map((corner) => ({
    x: quad[corner].x * Math.max(1, sourceWidth - 1),
    y: quad[corner].y * Math.max(1, sourceHeight - 1),
  }));
  const availablePixelsPerMillimeter = getSourcePixelsPerMillimeter(
    sourceWidth,
    sourceHeight,
    quad,
    targetWidth,
    targetHeight,
  );
  const uncappedWidth = Math.max(
    2,
    Math.round(targetWidth * availablePixelsPerMillimeter),
  );
  const uncappedHeight = Math.max(
    2,
    Math.round(targetHeight * availablePixelsPerMillimeter),
  );
  // Geometry comes from the four label corners and the measured millimetres.
  // Low-resolution photos are sampled onto a denser working grid only to avoid
  // pixel stair-steps; sourcePixelsPerMillimeter still records the real detail.
  const requestedWorkingLongSide = Math.min(
    maximumLongSide,
    Math.round(Math.max(targetWidth, targetHeight) * TRACE_WORKING_PPM),
  );
  const outputScale =
    Math.max(
      Math.min(maximumLongSide, Math.max(2, requestedWorkingLongSide)),
      Math.min(maximumLongSide, Math.max(uncappedWidth, uncappedHeight)),
    ) / Math.max(uncappedWidth, uncappedHeight);
  const outputWidth = Math.max(2, Math.round(uncappedWidth * outputScale));
  const outputHeight = Math.max(2, Math.round(uncappedHeight * outputScale));

  const minimumX = Math.max(
    0,
    Math.floor(Math.min(...sourcePoints.map((point) => point.x))) - 1,
  );
  const minimumY = Math.max(
    0,
    Math.floor(Math.min(...sourcePoints.map((point) => point.y))) - 1,
  );
  const maximumX = Math.min(
    sourceWidth,
    Math.ceil(Math.max(...sourcePoints.map((point) => point.x))) + 1,
  );
  const maximumY = Math.min(
    sourceHeight,
    Math.ceil(Math.max(...sourcePoints.map((point) => point.y))) + 1,
  );
  const sourceCropWidth = Math.max(2, maximumX - minimumX);
  const sourceCropHeight = Math.max(2, maximumY - minimumY);
  const samplingScale = Math.min(
    1,
    (maximumLongSide * 1.5) / Math.max(sourceCropWidth, sourceCropHeight),
  );
  const cropWidth = Math.max(2, Math.round(sourceCropWidth * samplingScale));
  const cropHeight = Math.max(2, Math.round(sourceCropHeight * samplingScale));
  const scaleX = cropWidth / sourceCropWidth;
  const scaleY = cropHeight / sourceCropHeight;
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = cropWidth;
  sourceCanvas.height = cropHeight;
  const sourceContext = sourceCanvas.getContext('2d', {
    willReadFrequently: true,
  });
  if (!sourceContext)
    throw new Error('浏览器无法读取图片，请换用Chrome或Edge重试。');
  sourceContext.drawImage(
    image,
    minimumX,
    minimumY,
    sourceCropWidth,
    sourceCropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );
  const sourceData = sourceContext.getImageData(0, 0, cropWidth, cropHeight);
  const localPoints = sourcePoints.map((point) => ({
    x: (point.x - minimumX) * scaleX,
    y: (point.y - minimumY) * scaleY,
  }));
  const [nw, ne, se, sw] = localPoints;
  const dx1 = ne.x - se.x;
  const dx2 = sw.x - se.x;
  const dx3 = nw.x - ne.x - sw.x + se.x;
  const dy1 = ne.y - se.y;
  const dy2 = sw.y - se.y;
  const dy3 = nw.y - ne.y - sw.y + se.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > 1e-6 || Math.abs(dy3) > 1e-6) {
    if (Math.abs(denominator) < 1e-8) {
      throw new Error('四角位置无法拉正，请重新调整。');
    }
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
  }
  const a = ne.x - nw.x + g * ne.x;
  const b = sw.x - nw.x + h * sw.x;
  const c = nw.x;
  const d = ne.y - nw.y + g * ne.y;
  const e = sw.y - nw.y + h * sw.y;
  const f = nw.y;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);

  for (let y = 0; y < outputHeight; y += 1) {
    const v = (y + 0.5) / outputHeight;
    for (let x = 0; x < outputWidth; x += 1) {
      const u = (x + 0.5) / outputWidth;
      const projectiveDenominator = g * u + h * v + 1;
      const sourceX = clamp(
        (a * u + b * v + c) / projectiveDenominator,
        0,
        cropWidth - 1,
      );
      const sourceY = clamp(
        (d * u + e * v + f) / projectiveDenominator,
        0,
        cropHeight - 1,
      );
      const left = Math.floor(sourceX);
      const top = Math.floor(sourceY);
      const right = Math.min(cropWidth - 1, left + 1);
      const bottom = Math.min(cropHeight - 1, top + 1);
      const horizontalAmount = sourceX - left;
      const verticalAmount = sourceY - top;
      const outputIndex = (y * outputWidth + x) * 4;

      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = sourceData.data[(top * cropWidth + left) * 4 + channel];
        const topRight =
          sourceData.data[(top * cropWidth + right) * 4 + channel];
        const bottomLeft =
          sourceData.data[(bottom * cropWidth + left) * 4 + channel];
        const bottomRight =
          sourceData.data[(bottom * cropWidth + right) * 4 + channel];
        const upper = topLeft + (topRight - topLeft) * horizontalAmount;
        const lower =
          bottomLeft + (bottomRight - bottomLeft) * horizontalAmount;
        output[outputIndex + channel] = Math.round(
          upper + (lower - upper) * verticalAmount,
        );
      }
    }
  }

  return { width: outputWidth, height: outputHeight, data: output };
}

function putRasterOnCanvas(canvas: HTMLCanvasElement, raster: RasterData) {
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const image = context.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  context.putImageData(image, 0, 0);
}

function normalizedSelection(
  first: NormalizedPoint,
  second: NormalizedPoint,
): NormalizedRect {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return {
    x,
    y,
    width: Math.abs(first.x - second.x),
    height: Math.abs(first.y - second.y),
  };
}

function geometricLineCurve(
  start: NormalizedPoint,
  end: NormalizedPoint,
  width: number,
  height: number,
  pixelsPerMillimeter: number,
  arrow: boolean,
): VectorOverlay {
  const x1 = start.x * width;
  const y1 = start.y * height;
  const x2 = end.x * width;
  const y2 = end.y * height;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length < pixelsPerMillimeter)
    throw new Error('直线长度不足1 mm，请重新拖动。');
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const halfStroke = pixelsPerMillimeter * 0.16;
  const headLength = arrow
    ? Math.min(length * 0.28, pixelsPerMillimeter * 2.4)
    : 0;
  const headHalfWidth = pixelsPerMillimeter * 0.85;
  const shaftEndX = x2 - ux * headLength;
  const shaftEndY = y2 - uy * headLength;
  const points: [number, number][] = [
    [x1 + nx * halfStroke, y1 + ny * halfStroke],
    [shaftEndX + nx * halfStroke, shaftEndY + ny * halfStroke],
    ...(arrow
      ? ([
          [shaftEndX + nx * headHalfWidth, shaftEndY + ny * headHalfWidth],
          [x2, y2],
          [shaftEndX - nx * headHalfWidth, shaftEndY - ny * headHalfWidth],
        ] as [number, number][])
      : []),
    [shaftEndX - nx * halfStroke, shaftEndY - ny * halfStroke],
    [x1 - nx * halfStroke, y1 - ny * halfStroke],
  ];
  return {
    paths: [
      `M${points.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L')}Z`,
    ],
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
  };
}

function preprocessWithCorrections(
  corrected: RasterData,
  options: TracePreprocessOptions,
  corrections: CorrectionRegion[],
  rebuildFromConfirmedRegions: boolean,
) {
  // Production reconstruction starts on a blank canvas. Photo pixels enter
  // only where the user explicitly selected a non-text graphic or chose to
  // preserve a confirmed text region's original photographed outline.
  let processed = rebuildFromConfirmedRegions
    ? {
        width: corrected.width,
        height: corrected.height,
        data: new Uint8ClampedArray(
          corrected.width * corrected.height * 4,
        ).fill(255),
      }
    : preprocessForTrace(corrected, options);
  const kept = corrections.filter(
    (correction) =>
      correction.kind === 'keep' ||
      (correction.kind === 'text' &&
        correction.textShapeSource === 'photo-outline'),
  );
  if (kept.length > 0) {
    const output = new Uint8ClampedArray(processed.data);
    for (const correction of kept) {
      const left = Math.max(0, Math.floor(correction.rect.x * corrected.width));
      const top = Math.max(0, Math.floor(correction.rect.y * corrected.height));
      const right = Math.min(
        corrected.width,
        Math.ceil(
          (correction.rect.x + correction.rect.width) * corrected.width,
        ),
      );
      const bottom = Math.min(
        corrected.height,
        Math.ceil(
          (correction.rect.y + correction.rect.height) * corrected.height,
        ),
      );
      const width = right - left;
      const height = bottom - top;
      if (width < 2 || height < 2) continue;
      const cropData = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        const sourceOffset = ((top + y) * corrected.width + left) * 4;
        cropData.set(
          corrected.data.subarray(sourceOffset, sourceOffset + width * 4),
          y * width * 4,
        );
      }
      const isPhotoText =
        correction.kind === 'text' &&
        correction.textShapeSource === 'photo-outline';
      // Every kept region uses its own explicit polarity. Never run `auto`
      // again here: a smaller crop can otherwise flip to the opposite mask.
      const detail = preprocessForTrace(
        { width, height, data: cropData },
        {
          ...options,
          cleanup:
            correction.detailMode === 'clean'
              ? Math.max(6, options.cleanup)
              : options.cleanup,
          // Original lettering must keep serifs, punctuation, counters and
          // proportions. It must not blur, reconnect or fill photographed glyphs.
          preserveFineDetail:
            isPhotoText || correction.detailMode === 'distressed',
          polarity: correction.polarity ?? 'dark',
          // Photo letters keep their counters and punctuation. Their edge cleanup
          // happens in the curve fitter, not through raster hole filling or a
          // majority filter that could silently change A/O/8/e-like shapes.
          fillSmallHoles: !isPhotoText && correction.detailMode === 'clean',
          smoothEdges: !isPhotoText && correction.detailMode === 'clean',
          edgeCleanupPercent: 0,
          preserveCanvas: true,
        },
      );
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const detailIndex = (y * width + x) * 4;
          if (detail.data[detailIndex] !== 0) continue;
          const outputIndex = ((top + y) * corrected.width + left + x) * 4;
          output[outputIndex] = 0;
          output[outputIndex + 1] = 0;
          output[outputIndex + 2] = 0;
          output[outputIndex + 3] = 255;
        }
      }
    }
    processed = { ...processed, data: output };
  }
  return eraseRasterRegions(
    processed,
    corrections
      .filter(
        (correction) =>
          correction.kind !== 'keep' &&
          !(
            correction.kind === 'text' &&
            correction.textShapeSource === 'photo-outline'
          ),
      )
      .map((correction) => correction.rect),
  );
}

export function PhotoTraceWorkflow({
  currentWidth,
  currentHeight,
  onApply,
}: {
  currentWidth: number;
  currentHeight: number;
  onApply: (result: PhotoTraceApplyResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<PhotoSource | null>(null);
  const [quad, setQuad] = useState<NormalizedQuad>(() =>
    cloneQuad(DEFAULT_QUAD),
  );
  const [detailSensitivity, setDetailSensitivity] = useState(55);
  const [cleanup, setCleanup] = useState(4);
  const [edgeCleanupPercent, setEdgeCleanupPercent] = useState(0);
  const [preserveFineDetail, setPreserveFineDetail] = useState(true);
  const [rebuildFromConfirmedRegions, setRebuildFromConfirmedRegions] =
    useState(true);
  const [polarity, setPolarity] = useState<'auto' | 'dark' | 'light'>('auto');
  const [targetWidthInput, setTargetWidthInput] = useState(
    formatInputMillimeters(currentWidth),
  );
  const [targetHeightInput, setTargetHeightInput] = useState(
    formatInputMillimeters(currentHeight),
  );
  const [replaceCurrentDesign, setReplaceCurrentDesign] = useState(true);
  const [expectedTextRegionCountInput, setExpectedTextRegionCountInput] =
    useState('');
  const [vector, setVector] = useState<TracedVector | null>(null);
  const [vectorSignature, setVectorSignature] = useState('');
  const [draftVector, setDraftVector] = useState<{
    width: number;
    height: number;
    paths: string[];
  } | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [inkRatio, setInkRatio] = useState(0);
  const [sourcePixelsPerMillimeter, setSourcePixelsPerMillimeter] = useState<
    number | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [redrawArmed, setRedrawArmed] = useState(false);
  const [photoViewport, setPhotoViewport] =
    useState<PhotoViewport>(FULL_PHOTO_VIEWPORT);
  const [corrections, setCorrections] = useState<CorrectionRegion[]>([]);
  const [redoCorrections, setRedoCorrections] = useState<RemovedCorrection[]>(
    [],
  );
  const [selection, setSelection] = useState<NormalizedRect | null>(null);
  const [selectionEndpoints, setSelectionEndpoints] = useState<{
    start: NormalizedPoint;
    end: NormalizedPoint;
  } | null>(null);
  const [correctionText, setCorrectionText] = useState('');
  const [correctionTextConfirm, setCorrectionTextConfirm] = useState('');
  const [correctionTextShapeSource, setCorrectionTextShapeSource] = useState<
    'photo-outline' | 'font-outline'
  >('photo-outline');
  const [correctionFontId, setCorrectionFontId] =
    useState<CurveFontChoiceId>('custom');
  const [customFont, setCustomFont] = useState<{
    name: string;
    data: ArrayBuffer;
  } | null>(null);
  const [correctionPolarity, setCorrectionPolarity] = useState<
    'dark' | 'light'
  >('dark');
  const [correctionDetailMode, setCorrectionDetailMode] = useState<
    'clean' | 'distressed'
  >('clean');
  const [graphicChecked, setGraphicChecked] = useState(false);
  const [textChecked, setTextChecked] = useState(false);
  const [textPreviewCurve, setTextPreviewCurve] =
    useState<VectorOverlay | null>(null);
  const [textPreviewError, setTextPreviewError] = useState('');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [confirmedGeometrySignature, setConfirmedGeometrySignature] =
    useState('');

  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const sourceBlobRef = useRef<Blob | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const uploadSequenceRef = useRef(0);
  const calibrationSurfaceRef = useRef<HTMLDivElement | null>(null);
  const rectifiedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const refinementCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const refinementSurfaceRef = useRef<HTMLDivElement | null>(null);
  const refinementDragRef = useRef<NormalizedPoint | null>(null);
  const nextCorrectionIdRef = useRef(1);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectionPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const textSelectionPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const comparisonCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragOperation | null>(null);
  const draftLoadAttemptedRef = useRef(false);
  const sizeResult = validateTargetSize(targetWidthInput, targetHeightInput);
  const quadError = validateQuad(quad);
  const geometrySignature =
    source && sizeResult.value && !quadError && !redrawArmed
      ? shortSignature(
          [
            source.fingerprint,
            sizeResult.value.width,
            sizeResult.value.height,
            ...QUAD_CORNERS.flatMap((corner) => [
              quad[corner].x.toFixed(6),
              quad[corner].y.toFixed(6),
            ]),
          ].join('|'),
        )
      : '';
  const geometryIsConfirmed =
    Boolean(geometrySignature) &&
    confirmedGeometrySignature === geometrySignature;
  const projectedPhotoTextPpm =
    sourcePixelsPerMillimeter !== null && sizeResult.value
      ? Math.min(
          sourcePixelsPerMillimeter,
          1800 / Math.max(sizeResult.value.width, sizeResult.value.height),
        )
      : null;
  const traceInputSignature = [
    source?.fingerprint ?? '',
    targetWidthInput,
    targetHeightInput,
    detailSensitivity,
    cleanup,
    edgeCleanupPercent,
    preserveFineDetail,
    rebuildFromConfirmedRegions,
    expectedTextRegionCountInput,
    polarity,
    ...corrections.flatMap((correction) => [
      correction.id,
      correction.kind,
      correction.rect.x,
      correction.rect.y,
      correction.rect.width,
      correction.rect.height,
      correction.text ?? '',
      correction.textShapeSource ?? '',
      correction.fontId ?? '',
      correction.fontName ?? '',
      correction.fontData?.byteLength ?? '',
      correction.polarity ?? '',
      correction.detailMode ?? '',
      correction.confirmedNoText ? 'confirmed-graphic' : '',
      correction.start?.x ?? '',
      correction.start?.y ?? '',
      correction.end?.x ?? '',
      correction.end?.y ?? '',
    ]),
    ...QUAD_CORNERS.flatMap((corner) => [quad[corner].x, quad[corner].y]),
  ].join('|');
  const latestTraceInputSignatureRef = useRef(traceInputSignature);
  latestTraceInputSignatureRef.current = traceInputSignature;
  const vectorIsCurrent =
    Boolean(vector) && vectorSignature === traceInputSignature;
  const confirmedTextCount = corrections.filter(
    (correction) => correction.kind === 'text',
  ).length;
  const photoTextCount = corrections.filter(
    (correction) =>
      correction.kind === 'text' &&
      correction.textShapeSource === 'photo-outline',
  ).length;
  const fontTextCount = corrections.filter(
    (correction) =>
      correction.kind === 'text' &&
      correction.textShapeSource !== 'photo-outline',
  ).length;
  const confirmedGraphicCount = corrections.filter(
    (correction) => correction.kind === 'keep',
  ).length;
  const expectedTextRegionCount = /^\d{1,2}$/u.test(
    expectedTextRegionCountInput,
  )
    ? Number(expectedTextRegionCountInput)
    : null;
  const textCountMatches =
    expectedTextRegionCount !== null &&
    expectedTextRegionCount <= 30 &&
    expectedTextRegionCount === confirmedTextCount;

  useEffect(() => {
    let active = true;
    setTextPreviewCurve(null);
    setTextPreviewError('');
    const text = correctionText.trim();
    if (text && correctionTextShapeSource === 'font-outline' && customFont) {
      confirmedTextCurve(
        text,
        correctionFontId,
        { x: 0, y: 0, width: 600, height: 100 },
        correctionFontId === 'custom' ? customFont?.data : undefined,
      )
        .then((curve) => {
          if (active) setTextPreviewCurve(curve);
        })
        .catch((error) => {
          if (active)
            setTextPreviewError(
              error instanceof Error ? error.message : '字体预览失败。',
            );
        });
    }
    return () => {
      active = false;
    };
  }, [correctionText, correctionFontId, correctionTextShapeSource, customFont]);

  useEffect(() => {
    return () => {
      uploadSequenceRef.current += 1;
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open || source || draftLoadAttemptedRef.current) return;
    draftLoadAttemptedRef.current = true;
    let cancelled = false;

    loadPhotoTraceDraft<PhotoTraceDraftSettings>()
      .then((saved) => {
        if (cancelled || !saved || !(saved.source?.blob instanceof Blob))
          return;
        const image = new Image();
        const url = URL.createObjectURL(saved.source.blob);
        image.onload = () => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
          sourceUrlRef.current = url;
          sourceBlobRef.current = saved.source.blob;
          sourceImageRef.current = image;
          setSource({
            name: saved.source.name,
            url,
            width: image.naturalWidth,
            height: image.naturalHeight,
            fingerprint:
              saved.source.fingerprint ||
              `${saved.source.name}-${saved.source.blob.size}`,
          });

          const settings = saved.settings;
          const settingsAreCurrent =
            settings?.version === PHOTO_TRACE_DRAFT_VERSION &&
            settings.quad &&
            !validateQuad(settings.quad) &&
            Array.isArray(settings.corrections);
          if (settingsAreCurrent) {
            setQuad(cloneQuad(settings.quad));
            setDetailSensitivity(settings.detailSensitivity);
            setCleanup(settings.cleanup);
            setEdgeCleanupPercent(settings.edgeCleanupPercent);
            setPreserveFineDetail(settings.preserveFineDetail);
            setRebuildFromConfirmedRegions(
              settings.rebuildFromConfirmedRegions,
            );
            setPolarity(settings.polarity);
            setTargetWidthInput(settings.targetWidthInput);
            setTargetHeightInput(settings.targetHeightInput);
            setReplaceCurrentDesign(settings.replaceCurrentDesign);
            setCorrections(settings.corrections);
            setRedrawArmed(false);
            setConfirmedGeometrySignature('');
            setExpectedTextRegionCountInput(
              settings.expectedTextRegionCountInput ?? '',
            );
            nextCorrectionIdRef.current =
              Math.max(0, ...settings.corrections.map((item) => item.id)) + 1;
            setDraftMessage(
              '已恢复上次中断的照片、尺寸、四角和已确认区域；请再次勾选“确认并锁定皮牌外边与实测尺寸”，再重新生成和复核曲线。',
            );
          } else {
            setQuad(cloneQuad(DEFAULT_QUAD));
            setRedrawArmed(true);
            setConfirmedGeometrySignature('');
            setCorrections([]);
            setExpectedTextRegionCountInput('');
            setDraftMessage(
              '已恢复原照片；网站处理版本已更新，旧选区没有沿用，请重新确认图文。',
            );
          }
          setVector(null);
          setVectorSignature('');
          setTextChecked(false);
          setGraphicChecked(false);
          setRedoCorrections([]);
          setLastSavedAt(settings?.savedAt ?? null);
        };
        image.onerror = () => {
          URL.revokeObjectURL(url);
          if (!cancelled)
            setDraftMessage('本机草稿中的照片无法读取，请重新上传原照片。');
        };
        image.src = url;
      })
      .catch(() => {
        if (!cancelled)
          setDraftMessage('未能读取本机草稿，当前仍可重新上传照片继续。');
      });

    return () => {
      cancelled = true;
    };
  }, [open, source]);

  useEffect(() => {
    const blob = sourceBlobRef.current;
    if (!open || !source || !blob) return;
    const timer = window.setTimeout(() => {
      const savedAt = Date.now();
      const settings: PhotoTraceDraftSettings = {
        version: PHOTO_TRACE_DRAFT_VERSION,
        savedAt,
        quad: cloneQuad(quad),
        detailSensitivity,
        cleanup,
        edgeCleanupPercent,
        preserveFineDetail,
        rebuildFromConfirmedRegions,
        polarity,
        targetWidthInput,
        targetHeightInput,
        replaceCurrentDesign,
        corrections,
        expectedTextRegionCountInput,
      };
      savePhotoTraceDraft(
        {
          name: source.name,
          type: blob.type,
          blob,
          fingerprint: source.fingerprint,
        },
        settings,
      )
        .then(() => {
          setLastSavedAt(savedAt);
          setDraftMessage('');
        })
        .catch(() => {
          setDraftMessage('本机自动保存暂时失败；当前页面中的操作仍然保留。');
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    cleanup,
    corrections,
    detailSensitivity,
    edgeCleanupPercent,
    expectedTextRegionCountInput,
    open,
    polarity,
    preserveFineDetail,
    quad,
    rebuildFromConfirmedRegions,
    replaceCurrentDesign,
    source,
    targetHeightInput,
    targetWidthInput,
  ]);

  useEffect(() => {
    if (
      !open ||
      !source ||
      !sourceImageRef.current ||
      !sizeResult.value ||
      quadError ||
      redrawArmed
    ) {
      setSourcePixelsPerMillimeter(null);
      setDraftVector(null);
      setDraftBusy(false);
      setInkRatio(0);
      const previewCanvas = previewCanvasRef.current;
      if (previewCanvas) {
        previewCanvas.width = 1;
        previewCanvas.height = 1;
      }
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const image = sourceImageRef.current;
      const rectifiedCanvas = rectifiedCanvasRef.current;
      const refinementCanvas = refinementCanvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (!image || !rectifiedCanvas || !previewCanvas || !sizeResult.value)
        return;

      try {
        setDraftBusy(true);
        setDraftVector(null);
        const corrected = createRectifiedRaster(
          image,
          source.width,
          source.height,
          quad,
          sizeResult.value.width,
          sizeResult.value.height,
          900,
        );
        putRasterOnCanvas(rectifiedCanvas, corrected);
        if (refinementCanvas) putRasterOnCanvas(refinementCanvas, corrected);
        setSourcePixelsPerMillimeter(
          getSourcePixelsPerMillimeter(
            source.width,
            source.height,
            quad,
            sizeResult.value.width,
            sizeResult.value.height,
          ),
        );
        const candidate = preprocessForTrace(corrected, {
          detailSensitivity,
          cleanup,
          edgeCleanupPercent,
          preserveCanvas: true,
          preserveFineDetail,
          smoothEdges: true,
          polarity,
        });
        putRasterOnCanvas(previewCanvas, candidate);
        let blackPixels = 0;
        for (let pixel = 0; pixel < candidate.data.length; pixel += 4) {
          if (candidate.data[pixel] === 0) blackPixels += 1;
        }
        setInkRatio(
          blackPixels / Math.max(1, candidate.width * candidate.height),
        );
        if (blackPixels > 0) {
          const { default: imageTracer } = await import('imagetracerjs');
          const draftSvg = imageTracer.imagedataToSVG(candidate, {
            pal: [
              { r: 0, g: 0, b: 0, a: 255 },
              { r: 255, g: 255, b: 255, a: 255 },
            ],
            colorsampling: 0,
            colorquantcycles: 1,
            pathomit: 5,
            ltres: 1,
            qtres: 1,
            rightangleenhance: true,
            linefilter: false,
            strokewidth: 0,
            roundcoords: 2,
            viewbox: true,
            desc: false,
          });
          if (!cancelled)
            setDraftVector({
              width: candidate.width,
              height: candidate.height,
              paths: extractBlackVectorPaths(draftSvg),
            });
        }
        if (!cancelled) setError('');
      } catch (previewError) {
        if (!cancelled)
          setError(
            previewError instanceof Error
              ? previewError.message
              : '照片拉正失败，请重新调整四角。',
          );
      } finally {
        if (!cancelled) setDraftBusy(false);
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    cleanup,
    detailSensitivity,
    edgeCleanupPercent,
    preserveFineDetail,
    polarity,
    open,
    quad,
    quadError,
    redrawArmed,
    source,
    targetHeightInput,
    targetWidthInput,
  ]);

  useEffect(() => {
    const graphicCanvas = selectionPreviewCanvasRef.current;
    const textCanvas = textSelectionPreviewCanvasRef.current;
    const sourceCanvas = rectifiedCanvasRef.current;
    if (!graphicCanvas && !textCanvas) return;
    if (!selection || !sourceCanvas || !sizeResult.value) {
      for (const canvas of [graphicCanvas, textCanvas]) {
        if (!canvas) continue;
        canvas.width = 1;
        canvas.height = 1;
      }
      return;
    }
    const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!context || sourceCanvas.width < 2 || sourceCanvas.height < 2) return;
    const left = Math.max(0, Math.floor(selection.x * sourceCanvas.width));
    const top = Math.max(0, Math.floor(selection.y * sourceCanvas.height));
    const right = Math.min(
      sourceCanvas.width,
      Math.ceil((selection.x + selection.width) * sourceCanvas.width),
    );
    const bottom = Math.min(
      sourceCanvas.height,
      Math.ceil((selection.y + selection.height) * sourceCanvas.height),
    );
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2) return;
    const crop = context.getImageData(left, top, width, height);
    const pixelsPerMillimeter = Math.min(
      sourceCanvas.width / sizeResult.value.width,
      sourceCanvas.height / sizeResult.value.height,
    );
    const baseOptions = {
      detailSensitivity,
      cleanup:
        correctionDetailMode === 'clean' ? Math.max(6, cleanup) : cleanup,
      edgeCleanupPercent: 0,
      preserveCanvas: true,
      polarity: correctionPolarity,
      pixelsPerMillimeter,
      minimumFeatureMm: DEFAULT_MINIMUM_FEATURE_MM,
    } as const;
    if (graphicCanvas) {
      putRasterOnCanvas(
        graphicCanvas,
        preprocessForTrace(
          { width, height, data: new Uint8ClampedArray(crop.data) },
          {
            ...baseOptions,
            preserveFineDetail: correctionDetailMode === 'distressed',
            fillSmallHoles: correctionDetailMode === 'clean',
            smoothEdges: correctionDetailMode === 'clean',
          },
        ),
      );
    }
    if (textCanvas) {
      putRasterOnCanvas(
        textCanvas,
        preprocessForTrace(
          { width, height, data: new Uint8ClampedArray(crop.data) },
          {
            ...baseOptions,
            preserveFineDetail: true,
            fillSmallHoles: false,
            smoothEdges: false,
          },
        ),
      );
    }
  }, [
    cleanup,
    correctionDetailMode,
    correctionPolarity,
    correctionTextShapeSource,
    detailSensitivity,
    draftBusy,
    selection,
    sizeResult.value,
  ]);

  useEffect(() => {
    const canvas = comparisonCanvasRef.current;
    const image = sourceImageRef.current;
    if (
      !canvas ||
      !image ||
      !source ||
      !sizeResult.value ||
      quadError ||
      !vectorIsCurrent
    ) {
      return;
    }
    const corrected = createRectifiedRaster(
      image,
      source.width,
      source.height,
      quad,
      sizeResult.value.width,
      sizeResult.value.height,
      900,
    );
    putRasterOnCanvas(canvas, corrected);
  }, [quad, quadError, sizeResult.value, source, vectorIsCurrent]);

  async function handlePhotoUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const uploadSequence = ++uploadSequenceRef.current;
    const file = input.files?.[0];
    setError('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('请上传JPG、PNG或WebP照片。');
      input.value = '';
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('照片不能超过15 MB。');
      input.value = '';
      return;
    }

    let fingerprint = `${file.name}-${file.size}-${file.lastModified}`;
    try {
      fingerprint = await fingerprintBlob(file);
    } catch {
      // The metadata fallback still remains stable across a local draft restore.
    }
    if (uploadSequence !== uploadSequenceRef.current) return;

    const url = URL.createObjectURL(file);
    const image = new Image();
    setSource(null);
    sourceImageRef.current = null;
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
    sourceBlobRef.current = null;
    setVector(null);
    setDraftVector(null);
    setVectorSignature('');
    setConfirmedGeometrySignature('');
    setCorrections([]);
    setRedoCorrections([]);
    setExpectedTextRegionCountInput('');
    setSelection(null);
    setTextChecked(false);
    setGraphicChecked(false);
    setPhotoViewport(FULL_PHOTO_VIEWPORT);
    image.onload = () => {
      if (uploadSequence !== uploadSequenceRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (
        image.naturalWidth * image.naturalHeight > 24_000_000 ||
        image.naturalWidth > 10_000 ||
        image.naturalHeight > 10_000
      ) {
        URL.revokeObjectURL(url);
        setError('照片像素过大，请先缩小到2400万像素以内再上传。');
        return;
      }
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = url;
      sourceBlobRef.current = file;
      sourceImageRef.current = image;
      setSource({
        name: file.name,
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
        fingerprint,
      });
      setQuad(cloneQuad(DEFAULT_QUAD));
      setRedrawArmed(true);
      setDraftMessage('新照片已载入，将自动保存到本机。');
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      if (uploadSequence === uploadSequenceRef.current)
        setError('照片读取失败，请重新选择。');
    };
    image.src = url;
    input.value = '';
  }

  async function handleCustomFontUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!/\.(?:ttf|otf)$/iu.test(file.name) || file.size > 5 * 1024 * 1024) {
      setError('自定义字体只支持5 MB以内的TTF或OTF文件。');
      return;
    }
    try {
      const data = await file.arrayBuffer();
      validateCustomCurveFont(data);
      setCustomFont({ name: file.name, data });
      setCorrectionFontId('custom');
      setTextChecked(false);
      setError('');
    } catch (fontError) {
      setError(
        fontError instanceof Error
          ? `字体无法使用：${fontError.message}`
          : '字体无法读取，请换一个TTF或OTF文件。',
      );
    }
  }

  async function handleClearSavedDraft() {
    try {
      await clearPhotoTraceDraft();
      setLastSavedAt(null);
      setDraftMessage('本机恢复副本已清除；当前页面中的内容没有删除。');
    } catch {
      setDraftMessage('本机草稿暂时无法清除。');
    }
  }

  function eventPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = calibrationSurfaceRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: clamp(
        photoViewport.x +
          ((event.clientX - bounds.left) / bounds.width) * photoViewport.width,
      ),
      y: clamp(
        photoViewport.y +
          ((event.clientY - bounds.top) / bounds.height) * photoViewport.height,
      ),
    };
  }

  function handleCalibrationPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const point = eventPoint(event);
    if (!point) return;
    if (corrections.length > 0) {
      setCorrections([]);
      setRedoCorrections([]);
      setSelection(null);
      setTextChecked(false);
      setError('选取范围或四角改变后，旧的局部修正已清空，请重新核对图文。');
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const corner = nearestCorner(point.x, point.y, quad, photoViewport);
    const forceDraw = redrawArmed;
    dragRef.current = {
      mode: forceDraw
        ? 'draw'
        : corner
          ? 'corner'
          : pointInQuad(point.x, point.y, quad)
            ? 'move'
            : 'draw',
      corner,
      startX: point.x,
      startY: point.y,
      startQuad: cloneQuad(quad),
    };
    if (forceDraw || (!corner && !pointInQuad(point.x, point.y, quad))) {
      setRedrawArmed(false);
      setCorrections([]);
      setRedoCorrections([]);
      setSelection(null);
      setTextChecked(false);
      setQuad(rectangleToQuad(point.x, point.y, point.x, point.y));
    }
  }

  function handleCalibrationPointerMove(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const operation = dragRef.current;
    const point = eventPoint(event);
    if (!operation || !point) return;

    if (operation.mode === 'corner' && operation.corner) {
      setQuad({
        ...cloneQuad(operation.startQuad),
        [operation.corner]: { x: point.x, y: point.y },
      });
      return;
    }

    if (operation.mode === 'move') {
      const deltaX = point.x - operation.startX;
      const deltaY = point.y - operation.startY;
      const points = QUAD_CORNERS.map((corner) => operation.startQuad[corner]);
      const minimumX = Math.min(...points.map((item) => item.x));
      const maximumX = Math.max(...points.map((item) => item.x));
      const minimumY = Math.min(...points.map((item) => item.y));
      const maximumY = Math.max(...points.map((item) => item.y));
      const safeDeltaX = clamp(deltaX, -minimumX, 1 - maximumX);
      const safeDeltaY = clamp(deltaY, -minimumY, 1 - maximumY);
      setQuad(
        Object.fromEntries(
          QUAD_CORNERS.map((corner) => [
            corner,
            {
              x: operation.startQuad[corner].x + safeDeltaX,
              y: operation.startQuad[corner].y + safeDeltaY,
            },
          ]),
        ) as NormalizedQuad,
      );
      return;
    }

    setQuad(
      rectangleToQuad(operation.startX, operation.startY, point.x, point.y),
    );
  }

  function finishCalibrationPointer(event: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function refinementPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = refinementSurfaceRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
  }

  function beginRefinementSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const point = refinementPoint(event);
    if (!point) return;
    refinementDragRef.current = point;
    setSelectionEndpoints({ start: point, end: point });
    setTextChecked(false);
    setGraphicChecked(false);
    setSelection(normalizedSelection(point, point));
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveRefinementSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const start = refinementDragRef.current;
    const point = refinementPoint(event);
    if (start && point) {
      setSelection(normalizedSelection(start, point));
      setSelectionEndpoints({ start, end: point });
    }
  }

  function endRefinementSelection(event: ReactPointerEvent<HTMLDivElement>) {
    moveRefinementSelection(event);
    refinementDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function addCorrection(kind: CorrectionRegion['kind']) {
    if (!selection || !sizeResult.value) return;
    if (!geometryIsConfirmed) {
      setError('请先确认皮牌成品外边和实测毫米尺寸，再选择图文。');
      return;
    }
    if (corrections.length >= 30) {
      setError('最多添加30处局部修正，请先删除不需要的区域。');
      return;
    }
    const geometric = kind === 'line' || kind === 'arrow';
    if (
      geometric &&
      (!selectionEndpoints ||
        Math.hypot(
          (selectionEndpoints.end.x - selectionEndpoints.start.x) *
            sizeResult.value.width,
          (selectionEndpoints.end.y - selectionEndpoints.start.y) *
            sizeResult.value.height,
        ) < 1)
    ) {
      setError('请沿线条或箭头从起点拖到终点，长度至少1 mm。');
      return;
    }
    if (
      !geometric &&
      (selection.width * sizeResult.value.width < 0.5 ||
        selection.height * sizeResult.value.height < 0.5)
    ) {
      setError('选取区域太小，请重新拖出完整的文字或杂纹范围。');
      return;
    }
    const exactText = correctionText.trim();
    if (kind === 'text' && exactText !== correctionTextConfirm.trim()) {
      setError('两次输入的文字不一致，请对照客户资料逐字检查。');
      return;
    }
    if (kind === 'text' && (!exactText || !textChecked)) {
      setError('请填写客户确认的准确文字，并勾选“已逐字核对”。');
      return;
    }
    if (
      kind === 'text' &&
      correctionTextShapeSource === 'font-outline' &&
      (correctionFontId !== 'custom' || !customFont)
    ) {
      setError(
        '请导入客户提供的确切TTF/OTF字体文件；相似字体不能用于照片复刻制模。',
      );
      return;
    }
    if (kind === 'keep' && !graphicChecked) {
      setError('请先确认该选区不含需要识别的文字，再作为图案保留。');
      return;
    }
    const rect = geometric
      ? {
          x: Math.max(0, selection.x - 0.6 / sizeResult.value.width),
          y: Math.max(0, selection.y - 0.6 / sizeResult.value.height),
          width:
            Math.min(
              1,
              selection.x + selection.width + 0.6 / sizeResult.value.width,
            ) - Math.max(0, selection.x - 0.6 / sizeResult.value.width),
          height:
            Math.min(
              1,
              selection.y + selection.height + 0.6 / sizeResult.value.height,
            ) - Math.max(0, selection.y - 0.6 / sizeResult.value.height),
        }
      : selection;
    const pendingCorrection: CorrectionOverlapDescriptor = {
      kind,
      textShapeSource: kind === 'text' ? correctionTextShapeSource : undefined,
    };
    const overlappingIndex = corrections.findIndex((correction) => {
      if (!rectanglesOverlap(rect, correction.rect)) return false;
      // An erase region is subtractive and runs after photographed text/graphics
      // are reconstructed. Allow it to overlap those photo regions so a user can
      // remove an internal leather grain, old stitch hole or shadow without
      // deleting the whole confirmed letter/graphic. Font and geometric overlays
      // are generated later and therefore remain non-overlapping.
      return !isAllowedCorrectionOverlap(correction, pendingCorrection);
    });
    if (overlappingIndex >= 0) {
      setError(
        `当前选区与第${overlappingIndex + 1}处已确认区域重叠。只有“排除皮纹”可以叠在照片字形或照片图案内部；其他区域请先撤销或重新框选。`,
      );
      return;
    }
    setCorrections((current) => [
      ...current,
      {
        id: nextCorrectionIdRef.current++,
        kind,
        rect,
        ...(kind === 'text'
          ? {
              text: exactText,
              textShapeSource: correctionTextShapeSource,
              polarity: correctionPolarity,
              detailMode: correctionDetailMode,
              fontId:
                correctionTextShapeSource === 'font-outline'
                  ? correctionFontId
                  : undefined,
              fontName:
                correctionTextShapeSource === 'font-outline' &&
                correctionFontId === 'custom'
                  ? customFont?.name
                  : undefined,
              fontData:
                correctionTextShapeSource === 'font-outline' &&
                correctionFontId === 'custom'
                  ? customFont?.data.slice(0)
                  : undefined,
            }
          : {}),
        ...(kind === 'keep'
          ? {
              polarity: correctionPolarity,
              detailMode: correctionDetailMode,
              confirmedNoText: true,
            }
          : {}),
        ...(geometric && selectionEndpoints ? selectionEndpoints : {}),
      },
    ]);
    setRedoCorrections([]);
    setSelection(null);
    setSelectionEndpoints(null);
    setTextChecked(false);
    setGraphicChecked(false);
    if (kind === 'text') {
      setCorrectionText('');
      setCorrectionTextConfirm('');
    }
    setError('');
  }

  function undoLatestCorrection() {
    setCorrections((current) => {
      if (current.length === 0) return current;
      const index = current.length - 1;
      const correction = current[index];
      setRedoCorrections((redo) => [...redo, { correction, index }]);
      return current.slice(0, index);
    });
  }

  function redoLatestCorrection() {
    setRedoCorrections((redo) => {
      const item = redo.at(-1);
      if (!item) return redo;
      setCorrections((current) => {
        const next = [...current];
        next.splice(Math.min(item.index, next.length), 0, item.correction);
        return next;
      });
      return redo.slice(0, -1);
    });
  }

  function removeCorrection(id: number) {
    setCorrections((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) return current;
      const correction = current[index];
      setRedoCorrections((redo) => [...redo, { correction, index }]);
      return current.filter((item) => item.id !== id);
    });
  }

  async function generateVector() {
    const image = sourceImageRef.current;
    if (!source || !image || !sizeResult.value || quadError) {
      setError(quadError || '请先上传照片、校正皮牌四角并填写成品尺寸。');
      return;
    }
    if (!geometryIsConfirmed) {
      setError('请先在第3步确认皮牌成品外边、拉正比例和实测毫米尺寸。');
      return;
    }
    if (rebuildFromConfirmedRegions && expectedTextRegionCount === null) {
      setError('请先填写原图中需要保留的文字区域总数；确定没有文字时填写0。');
      return;
    }
    if (rebuildFromConfirmedRegions && !textCountMatches) {
      setError(
        `原图登记了${expectedTextRegionCount ?? 0}处文字，目前只确认了${confirmedTextCount}处。请补齐或修改文字总数。`,
      );
      return;
    }
    if (
      rebuildFromConfirmedRegions &&
      corrections.some(
        (correction) =>
          (correction.kind === 'keep' &&
            (!correction.polarity || !correction.confirmedNoText)) ||
          (correction.kind === 'text' &&
            correction.textShapeSource === 'photo-outline' &&
            !correction.polarity),
      )
    ) {
      setError(
        '存在未锁定明暗方向的原字形区域，或未确认“无文字”的图案区域，请重新添加。',
      );
      return;
    }
    const hasOverlap = corrections.some((correction, index) =>
      corrections
        .slice(index + 1)
        .some(
          (next) =>
            rectanglesOverlap(correction.rect, next.rect) &&
            !isAllowedCorrectionOverlap(correction, next),
        ),
    );
    if (hasOverlap) {
      setError('已确认区域存在重叠，请先撤销冲突区域再生成。');
      return;
    }
    const generationSignature = traceInputSignature;

    setBusy(true);
    setError('');
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );

    try {
      // Formal tracing is rebuilt from the selected source pixels. It does not
      // reuse the smaller on-screen preview, so the preview cannot silently
      // reduce the production result's detail.
      const corrected = createRectifiedRaster(
        image,
        source.width,
        source.height,
        quad,
        sizeResult.value.width,
        sizeResult.value.height,
        1800,
      );
      const formalPixelsPerMillimeter = Math.min(
        corrected.width / sizeResult.value.width,
        corrected.height / sizeResult.value.height,
      );
      const processed = preprocessWithCorrections(
        corrected,
        {
          detailSensitivity,
          cleanup,
          edgeCleanupPercent,
          preserveCanvas: true,
          preserveFineDetail,
          polarity,
          pixelsPerMillimeter: formalPixelsPerMillimeter,
          minimumFeatureMm: DEFAULT_MINIMUM_FEATURE_MM,
        },
        corrections,
        rebuildFromConfirmedRegions,
      );
      let formalBlackPixels = 0;
      for (let pixel = 0; pixel < processed.data.length; pixel += 4) {
        if (processed.data[pixel] === 0) formalBlackPixels += 1;
      }
      const formalInkRatio =
        formalBlackPixels / Math.max(1, processed.width * processed.height);
      if (
        formalInkRatio < 0.001 &&
        !corrections.some((correction) =>
          ['text', 'line', 'arrow'].includes(correction.kind),
        )
      ) {
        throw new Error(
          '当前没有确认的图文，请在第5步选择要保留的图案，或逐行确认文字和线条。',
        );
      }
      if (formalInkRatio > 0.88) {
        throw new Error('当前识别内容过多，请降低“图文完整度”或重新校正四角。');
      }
      const { default: imageTracer } = await import('imagetracerjs');
      const preservesDistressedEdges = corrections.some(
        (correction) =>
          correction.kind !== 'erase' && correction.detailMode === 'distressed',
      );
      const curveTolerancePixels = Math.min(
        1.5,
        Math.max(0.8, formalPixelsPerMillimeter * 0.06),
      );
      const minimumCleanPathNodes = Math.min(
        8,
        Math.max(4, Math.ceil(Math.PI * 0.1 * formalPixelsPerMillimeter)),
      );
      const tracedSvg = imageTracer.imagedataToSVG(processed, {
        pal: [
          { r: 0, g: 0, b: 0, a: 255 },
          { r: 255, g: 255, b: 255, a: 255 },
        ],
        colorsampling: 0,
        colorquantcycles: 1,
        pathomit: preservesDistressedEdges
          ? 0
          : photoTextCount > 0
            ? minimumCleanPathNodes
            : cleanup === 0
              ? 0
              : Math.min(3, Math.floor(cleanup / 3) + 1),
        ltres: preservesDistressedEdges ? 0.55 : curveTolerancePixels ** 2,
        qtres: preservesDistressedEdges
          ? 0.55
          : (curveTolerancePixels * 1.1) ** 2,
        rightangleenhance: confirmedGraphicCount > 0,
        linefilter: false,
        strokewidth: 0,
        roundcoords: 2,
        viewbox: true,
        desc: false,
      });
      const paths = extractBlackVectorPaths(tracedSvg);
      const overlays: VectorOverlay[] = [];
      for (const correction of corrections) {
        if (
          (correction.kind === 'line' || correction.kind === 'arrow') &&
          correction.start &&
          correction.end
        ) {
          overlays.push(
            geometricLineCurve(
              correction.start,
              correction.end,
              processed.width,
              processed.height,
              Math.min(
                processed.width / sizeResult.value.width,
                processed.height / sizeResult.value.height,
              ),
              correction.kind === 'arrow',
            ),
          );
          continue;
        }
        if (
          correction.kind !== 'text' ||
          !correction.text ||
          correction.textShapeSource === 'photo-outline'
        )
          continue;
        const targetWidth = correction.rect.width * processed.width;
        const targetHeight = correction.rect.height * processed.height;
        overlays.push(
          await confirmedTextCurve(
            correction.text,
            (correction.fontId ?? 'custom') as CurveFontChoiceId,
            {
              x: correction.rect.x * processed.width,
              y: correction.rect.y * processed.height,
              width: targetWidth,
              height: targetHeight,
            },
            correction.fontId === 'custom' ? correction.fontData : undefined,
          ),
        );
      }
      const pathCharacters = [
        ...paths,
        ...overlays.flatMap((overlay) => overlay.paths),
      ].reduce((total, path) => total + path.length, 0);
      if (paths.length === 0 && overlays.length === 0) {
        throw new Error('没有生成可用曲线，请调整图文完整度后重试。');
      }
      if (pathCharacters > 2_500_000) {
        throw new Error('曲线过于复杂，请提高去杂点后重新描绘。');
      }
      if (latestTraceInputSignatureRef.current !== generationSignature) {
        throw new Error('四角、尺寸或识别设置已经改变，请重新生成曲线。');
      }
      const sourcePpm = getSourcePixelsPerMillimeter(
        source.width,
        source.height,
        quad,
        sizeResult.value.width,
        sizeResult.value.height,
      );
      const tracePpm = Math.min(sourcePpm, formalPixelsPerMillimeter);
      const productionBlockedReasons: string[] = [];
      if (!rebuildFromConfirmedRegions) {
        productionBlockedReasons.push('当前是整图照片描边参考模式。');
      }
      if (confirmedGraphicCount > 0 && tracePpm < PHOTO_DETAIL_LOW_PPM) {
        productionBlockedReasons.push(
          `照片图案只有${tracePpm.toFixed(1)}像素/mm，低于制模候选的${PHOTO_DETAIL_LOW_PPM}像素/mm最低清晰度；可下载CDR描修工作稿逐笔修整。`,
        );
      }
      const reviewWarnings: string[] = [];
      if (tracePpm < PHOTO_DETAIL_LOW_PPM) {
        reviewWarnings.push(
          `原照片只有${tracePpm.toFixed(1)}像素/mm，属于低清复刻。已保持整牌毫米比例并做保守清边，但不可见细节无法自动恢复；此文件应作为CDR描修基础逐笔修整。`,
        );
      } else if (tracePpm < PHOTO_DETAIL_CLEAR_PPM) {
        reviewWarnings.push(
          `原照片约${tracePpm.toFixed(1)}像素/mm，可继续描绘但细笔画可信度有限；请使用红线叠图和CDR逐字复核。`,
        );
      }
      const clippedPhotoText = corrections.find(
        (correction) =>
          correction.kind === 'text' &&
          correction.textShapeSource === 'photo-outline' &&
          rasterRegionTouchesInkEdge(
            processed,
            correction.rect,
            Math.max(2, Math.round(formalPixelsPerMillimeter * 0.08)),
          ),
      );
      if (clippedPhotoText) {
        productionBlockedReasons.push(
          `原字形“${clippedPhotoText.text ?? ''}”碰到选区边缘，可能已裁掉衬线、句点或笔画。请重新框选并在文字四周保留少量空白。`,
        );
      }
      const allPaths = [
        ...paths,
        ...overlays.flatMap((overlay) => overlay.paths),
      ];
      const qualityWarnings = allPaths.some((path) => !/[zZ]\s*$/u.test(path))
        ? ['发现可能未闭合的路径，必须在CDR中修正后再制模。']
        : [];
      setVector({
        viewBoxWidth: processed.width,
        viewBoxHeight: processed.height,
        paths,
        overlays,
        coordinateSpace: 'label',
        calibratedWidth: sizeResult.value.width,
        calibratedHeight: sizeResult.value.height,
        sourcePixelsPerMillimeter: sourcePpm,
        tracePixelsPerMillimeter: tracePpm,
        manualTextCount: confirmedTextCount,
        expectedTextRegionCount: expectedTextRegionCount ?? undefined,
        photoTextRegionCount: photoTextCount,
        fontTextRegionCount: fontTextCount,
        tracedGraphicRegionCount: confirmedGraphicCount,
        geometricRegionCount: corrections.filter(
          (correction) =>
            correction.kind === 'line' || correction.kind === 'arrow',
        ).length,
        traceVersionId: shortSignature(generationSignature),
        geometryConfirmed: geometryIsConfirmed,
        contentBoundsMm: confirmedContentBoundsMm(
          corrections,
          sizeResult.value.width,
          sizeResult.value.height,
        ),
        productionBlockedReasons,
        qualityWarnings,
        reviewWarnings,
        excludedRegionCount: corrections.filter(
          (correction) =>
            correction.kind !== 'keep' &&
            !(
              correction.kind === 'text' &&
              correction.textShapeSource === 'photo-outline'
            ),
        ).length,
        manualEraseRegionCount: corrections.filter(
          (correction) => correction.kind === 'erase',
        ).length,
        reconstructedFromConfirmedRegions: rebuildFromConfirmedRegions,
      });
      setVectorSignature(generationSignature);
    } catch (traceError) {
      setVector(null);
      setError(
        traceError instanceof Error
          ? traceError.message
          : '自动描绘失败，请调整参数后重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  function applyVector() {
    if (!source || !vector || !sizeResult.value || !vectorIsCurrent) return;
    const nameWithoutExtension = source.name.replace(/\.[^.]+$/u, '');
    onApply({
      name: `${nameWithoutExtension}-自动描绘`,
      vector,
      targetWidth: sizeResult.value.width,
      targetHeight: sizeResult.value.height,
      replaceCurrentDesign,
    });
    setOpen(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen && !source) {
      setTargetWidthInput(formatInputMillimeters(currentWidth));
      setTargetHeightInput(formatInputMillimeters(currentHeight));
    }
    setOpen(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button type="button" size="lg" className="h-11 w-full" />}
      >
        <Crop aria-hidden="true" />
        打开照片自动描绘
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto p-0 sm:max-w-[min(1120px,calc(100%-2rem))]">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle className="text-lg">照片复刻 / 自动描绘</DialogTitle>
          <DialogDescription className="leading-6">
            先把照片中的一块皮牌拉正并对应到真实毫米尺寸，再保持图文原来的位置生成曲线。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 px-5 pb-2 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,.85fr)]">
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">1. 选中一块皮牌并校正四角</p>
                <p className="text-sm text-muted-foreground">
                  先在整图粗框一块皮牌，再点“放大精调”，将四个白点放在成品外轮廓的四个角。
                </p>
              </div>
              <div className="flex items-center gap-2">
                {source && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuad(cloneQuad(DEFAULT_QUAD));
                        setPhotoViewport(FULL_PHOTO_VIEWPORT);
                        setRedrawArmed(false);
                        setConfirmedGeometrySignature('');
                        setCorrections([]);
                        setRedoCorrections([]);
                        setSelection(null);
                        setTextChecked(false);
                      }}
                    >
                      照片四边就是成品边
                    </Button>
                    <Button
                      type="button"
                      variant={redrawArmed ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setPhotoViewport(FULL_PHOTO_VIEWPORT);
                        setRedrawArmed(true);
                        setConfirmedGeometrySignature('');
                        setCorrections([]);
                        setRedoCorrections([]);
                        setSelection(null);
                        setTextChecked(false);
                      }}
                    >
                      <Crop aria-hidden="true" />
                      {redrawArmed ? '请在照片上拖出范围' : '重新框选'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={Boolean(quadError)}
                      onClick={() =>
                        setPhotoViewport((current) =>
                          current === FULL_PHOTO_VIEWPORT
                            ? viewportAroundQuad(quad)
                            : FULL_PHOTO_VIEWPORT,
                        )
                      }
                    >
                      {photoViewport === FULL_PHOTO_VIEWPORT
                        ? '放大精调'
                        : '查看整图'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuad(cloneQuad(DEFAULT_QUAD));
                        setPhotoViewport(FULL_PHOTO_VIEWPORT);
                        setRedrawArmed(true);
                        setConfirmedGeometrySignature('');
                        setCorrections([]);
                        setRedoCorrections([]);
                        setSelection(null);
                        setTextChecked(false);
                      }}
                    >
                      <RotateCcw aria-hidden="true" />
                      重置
                    </Button>
                  </>
                )}
                <label
                  htmlFor="trace-photo-upload"
                  className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <span className="sr-only">选择客户照片</span>
                  <Upload className="size-4" aria-hidden="true" />
                  {source ? '更换照片' : '选择照片'}
                </label>
              </div>
              <Input
                id="trace-photo-upload"
                type="file"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={handlePhotoUpload}
              />
            </div>

            {(lastSavedAt || draftMessage) && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/35 px-3 py-2 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Save className="size-4" aria-hidden="true" />
                  {draftMessage ||
                    `本机草稿已于 ${formatSavedTime(lastSavedAt!)} 自动保存`}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleClearSavedDraft}
                >
                  <Trash2 aria-hidden="true" />
                  清除恢复副本
                </Button>
              </div>
            )}

            {source ? (
              <div className="rounded-2xl border bg-[#171716] p-2 sm:p-3">
                <div
                  ref={calibrationSurfaceRef}
                  className="relative mx-auto cursor-crosshair touch-none overflow-hidden rounded-xl select-none"
                  style={{
                    aspectRatio: `${source.width * photoViewport.width} / ${source.height * photoViewport.height}`,
                    width:
                      source.width * photoViewport.width >=
                      source.height * photoViewport.height
                        ? '100%'
                        : `${Math.min(100, ((source.width * photoViewport.width) / (source.height * photoViewport.height)) * 74)}%`,
                  }}
                  onPointerDown={handleCalibrationPointerDown}
                  onPointerMove={handleCalibrationPointerMove}
                  onPointerUp={finishCalibrationPointer}
                  onPointerCancel={finishCalibrationPointer}
                >
                  {/* Blob URLs need a pixel-exact element for calibration coordinates. */}
                  {/* oxlint-disable-next-line next/no-img-element */}
                  <img
                    src={source.url}
                    alt="客户照片四角校正区域"
                    className="pointer-events-none absolute max-w-none"
                    style={{
                      width: `${100 / photoViewport.width}%`,
                      height: `${100 / photoViewport.height}%`,
                      left: `${(-photoViewport.x / photoViewport.width) * 100}%`,
                      top: `${(-photoViewport.y / photoViewport.height) * 100}%`,
                    }}
                    draggable={false}
                  />
                  <svg
                    className="pointer-events-none absolute inset-0 size-full"
                    viewBox={`${photoViewport.x * 100} ${photoViewport.y * 100} ${photoViewport.width * 100} ${photoViewport.height * 100}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <defs>
                      <mask id="label-quad-selection-mask">
                        <rect width="100" height="100" fill="white" />
                        <polygon
                          points={QUAD_CORNERS.map(
                            (corner) =>
                              `${quad[corner].x * 100},${quad[corner].y * 100}`,
                          ).join(' ')}
                          fill="black"
                        />
                      </mask>
                    </defs>
                    <rect
                      width="100"
                      height="100"
                      fill="rgba(0,0,0,.58)"
                      mask="url(#label-quad-selection-mask)"
                    />
                    <polygon
                      points={QUAD_CORNERS.map(
                        (corner) =>
                          `${quad[corner].x * 100},${quad[corner].y * 100}`,
                      ).join(' ')}
                      fill="none"
                      stroke="white"
                      strokeWidth="0.65"
                      vectorEffect="non-scaling-stroke"
                    />
                    {[1 / 3, 2 / 3].map((amount) => {
                      const top = interpolatePoint(quad.nw, quad.ne, amount);
                      const bottom = interpolatePoint(quad.sw, quad.se, amount);
                      return (
                        <line
                          key={`vertical-${amount}`}
                          x1={top.x * 100}
                          y1={top.y * 100}
                          x2={bottom.x * 100}
                          y2={bottom.y * 100}
                          stroke="rgba(255,255,255,.55)"
                          strokeWidth="0.35"
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                    {[1 / 3, 2 / 3].map((amount) => {
                      const left = interpolatePoint(quad.nw, quad.sw, amount);
                      const right = interpolatePoint(quad.ne, quad.se, amount);
                      return (
                        <line
                          key={`horizontal-${amount}`}
                          x1={left.x * 100}
                          y1={left.y * 100}
                          x2={right.x * 100}
                          y2={right.y * 100}
                          stroke="rgba(255,255,255,.55)"
                          strokeWidth="0.35"
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                  </svg>
                  {QUAD_CORNERS.map((corner) => (
                    <span
                      key={corner}
                      className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#171716] bg-white shadow-[0_1px_8px_rgba(0,0,0,.55)]"
                      style={{
                        left: `${((quad[corner].x - photoViewport.x) / photoViewport.width) * 100}%`,
                        top: `${((quad[corner].y - photoViewport.y) / photoViewport.height) * 100}%`,
                      }}
                    >
                      <span
                        className={`absolute whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white ${corner.includes('n') ? 'top-6' : 'bottom-6'} ${corner.includes('w') ? 'left-0' : 'right-0'}`}
                      >
                        {CORNER_LABELS[corner]}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <label
                htmlFor="trace-photo-upload"
                className="flex min-h-72 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-primary/40 bg-primary/[0.04] p-8 text-center hover:bg-primary/[0.08]"
              >
                <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
                  <Upload aria-hidden="true" />
                </span>
                <span className="font-medium">上传客户提供的整张照片</span>
                <span className="text-sm text-muted-foreground">
                  JPG、PNG或WebP，最大15 MB
                </span>
              </label>
            )}

            <div className="rounded-xl border border-amber-600/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900">
              白点要对准皮牌成品外角，不是缝线内角。照片中有多块皮牌时，每次只选择其中一块；粗框后放大精调，不会改变原图坐标。
            </div>
            {quadError && (
              <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm leading-6 text-destructive">
                {quadError}
              </p>
            )}
          </section>

          <section className="space-y-4">
            <div className="rounded-xl border bg-muted/40 p-3">
              <p className="font-medium">2. 输入皮牌成品实际尺寸</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <DimensionInput
                  id="trace-target-width"
                  label="成品宽"
                  value={targetWidthInput}
                  onChange={setTargetWidthInput}
                />
                <DimensionInput
                  id="trace-target-height"
                  label="成品高"
                  value={targetHeightInput}
                  onChange={setTargetHeightInput}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setTargetWidthInput(formatInputMillimeters(currentWidth));
                  setTargetHeightInput(formatInputMillimeters(currentHeight));
                }}
              >
                <RotateCcw aria-hidden="true" />
                使用当前皮牌尺寸
              </Button>
              {sizeResult.error ? (
                <p className="mt-2 text-sm text-destructive">
                  {sizeResult.error}
                </p>
              ) : (
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  校正后左上角固定为（0，0），右下角固定为（
                  {formatInputMillimeters(sizeResult.value!.width)}，
                  {formatInputMillimeters(sizeResult.value!.height)}）mm。
                </p>
              )}
            </div>

            <div>
              <p className="font-medium">3. 检查拉正后的完整皮牌</p>
              <p className="text-sm leading-6 text-muted-foreground">
                这里必须与皮牌正面比例一致。原有文字和图案离四边的位置会按此保留。
              </p>
            </div>
            <div className="grid min-h-36 place-items-center overflow-hidden rounded-xl border bg-[#24211f] p-2">
              {source && !quadError && sizeResult.value && !redrawArmed ? (
                <canvas
                  ref={rectifiedCanvasRef}
                  aria-label="四角拉正后的完整皮牌"
                  className="max-h-48 max-w-full object-contain"
                />
              ) : (
                <p className="text-sm text-white/70">
                  先选择“照片四边就是成品边”，或在照片上拖出皮牌外边
                </p>
              )}
            </div>
            <label
              className={`flex items-start gap-2 rounded-xl border p-3 text-sm leading-6 ${geometryIsConfirmed ? 'border-emerald-600/25 bg-emerald-500/[0.07] text-emerald-900' : 'border-amber-600/25 bg-amber-500/10 text-amber-900'}`}
            >
              <input
                type="checkbox"
                className="mt-1 size-4"
                disabled={!geometrySignature}
                checked={geometryIsConfirmed}
                onChange={(event) =>
                  setConfirmedGeometrySignature(
                    event.target.checked ? geometrySignature : '',
                  )
                }
              />
              <span>
                <strong>确认并锁定皮牌外边与实测尺寸</strong>
                <span className="block">
                  四个点位于成品外轮廓，拉正后的整牌比例正确。锁定后，图文只在原位置清边，不会裁紧、居中、铺满或再次放大。
                </span>
              </span>
            </label>
            {sourcePixelsPerMillimeter !== null && (
              <p
                className={`rounded-xl border p-3 text-sm leading-6 ${(projectedPhotoTextPpm ?? 0) < PHOTO_DETAIL_CLEAR_PPM ? 'border-amber-600/25 bg-amber-500/10 text-amber-900' : 'bg-muted/40 text-muted-foreground'}`}
              >
                当前所选照片约为 {sourcePixelsPerMillimeter.toFixed(1)}{' '}
                像素/mm。
                {(projectedPhotoTextPpm ?? 0) < PHOTO_DETAIL_LOW_PPM
                  ? ' 属于低清照片：系统会保持整牌比例并尽量清除像素毛边，仍可导出CDR描修工作稿，但看不见的细节不会凭空补猜，必须逐笔修整。'
                  : (projectedPhotoTextPpm ?? 0) < PHOTO_DETAIL_CLEAR_PPM
                    ? ' 属于可描绘、需重点复核：可以继续，不要求客户提供字体；请用最终红线叠图和CDR检查细笔画。'
                    : ' 照片细节较充足，仍须在最终叠加图逐字核对。'}
              </p>
            )}

            <div className="border-t pt-4">
              <p className="font-medium">4. 先看照片自动描绘候选</p>
              <p className="text-sm leading-6 text-muted-foreground">
                上传后先显示矢量候选，方便核对原来有哪些字和图案。它可能含皮纹、旧缝线或错字，不能直接作为制模稿。
              </p>
            </div>
            <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
              <p className="text-sm font-medium">制模稿处理方式</p>
              <label className="flex items-start gap-2 text-sm leading-6">
                <input
                  type="radio"
                  name="trace-reconstruction-mode"
                  className="mt-1"
                  checked={rebuildFromConfirmedRegions}
                  onChange={() => setRebuildFromConfirmedRegions(true)}
                />
                <span>
                  按确认内容重建（推荐）：自动候选仍可看，制模稿只保留逐处确认的图案与文字
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm leading-6">
                <input
                  type="radio"
                  name="trace-reconstruction-mode"
                  className="mt-1"
                  checked={!rebuildFromConfirmedRegions}
                  onChange={() => setRebuildFromConfirmedRegions(false)}
                />
                <span>
                  整张照片自动描边（仅参考）：可能混入皮纹、旧缝线与错字
                </span>
              </label>
            </div>
            <div className="rounded-xl border border-amber-600/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900">
              <span className="font-medium">照片原字形与文字内容分开核对</span>
              <span className="block">
                第5步默认提取照片中可见的文字轮廓并保留原位置，不会重新套用、缩放或排版相似字体；你输入的文字只用于检查错字、数字、标点与空格。
              </span>
            </div>
            <div className="grid min-h-44 place-items-center overflow-hidden rounded-xl border bg-white p-2">
              {source ? (
                <>
                  <canvas
                    ref={previewCanvasRef}
                    aria-label="照片自动描绘候选"
                    className={
                      draftVector?.paths.length
                        ? 'hidden'
                        : 'max-h-56 max-w-full object-contain'
                    }
                  />
                  {draftVector && draftVector.paths.length > 0 && (
                    <svg
                      aria-label="照片自动描绘的矢量候选，仅供参考"
                      viewBox={`0 0 ${draftVector.width} ${draftVector.height}`}
                      className="max-h-56 max-w-full"
                    >
                      <rect
                        width={draftVector.width}
                        height={draftVector.height}
                        fill="white"
                      />
                      <g fill="#000" fillRule="evenodd" stroke="none">
                        {draftVector.paths.map((path, index) => (
                          <path key={index} d={path} />
                        ))}
                      </g>
                    </svg>
                  )}
                  {draftBusy && (
                    <p className="text-xs text-muted-foreground">
                      正在生成自动矢量候选…
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  上传后在这里检查效果
                </p>
              )}
            </div>
            <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
              <p className="text-sm font-medium">识别方向</p>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="压印明暗选择"
              >
                {(
                  [
                    ['auto', '自动比较'],
                    ['dark', '深色压痕'],
                    ['light', '浅色压痕'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={polarity === value ? 'default' : 'outline'}
                    aria-pressed={polarity === value}
                    onClick={() => setPolarity(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-sm leading-6">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--primary)]"
                  checked={preserveFineDetail}
                  onChange={(event) =>
                    setPreserveFineDetail(event.target.checked)
                  }
                />
                <span>优先保留细字和笔画（默认，不自动模糊或连笔）</span>
              </label>
              <p className="text-xs leading-5 text-muted-foreground">
                若皮纹太多可取消勾选比较，但平滑模式可能使小字粘连，须对照原照片检查。
              </p>
            </div>
            <RangeField
              id="trace-detail-sensitivity"
              label="图文完整度"
              value={detailSensitivity}
              unit="%"
              min={0}
              max={100}
              step={1}
              onChange={setDetailSensitivity}
            />
            <p className="-mt-2 text-xs leading-5 text-muted-foreground">
              数值越高，越容易保留浅压的小字和细线；皮纹变多时请适当调低。
            </p>
            <RangeField
              id="trace-cleanup"
              label="图文净化 / 去皮纹"
              value={cleanup}
              unit="级"
              min={0}
              max={10}
              step={1}
              onChange={setCleanup}
            />
            <RangeField
              id="trace-edge-cleanup"
              label="去边框范围"
              value={edgeCleanupPercent}
              unit="%"
              min={0}
              max={20}
              step={1}
              onChange={setEdgeCleanupPercent}
            />
            <p className="-mt-2 text-xs leading-5 text-muted-foreground">
              默认不删边缘，以免误删贴近成品边的小字。仅当旧缝线进入图文时再逐步增加；优先使用下方的局部排除。
            </p>
            {source && (
              <p className="text-sm text-muted-foreground">
                自动候选黑色覆盖约 {(inkRatio * 100).toFixed(1)}
                %（不是识别准确率）。
                {inkRatio < 0.02 &&
                  ' 当前只识别出少量线条，请分别试“深色压痕”“浅色压痕”，并检查四角框选。'}
              </p>
            )}
            {rebuildFromConfirmedRegions && corrections.length === 0 && (
              <div className="rounded-xl border border-amber-600/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900">
                自动候选已可查看。制模稿尚未加入任何确认内容，请继续到第5步框选图案和每行文字。
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() =>
                    refinementSurfaceRef.current?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'center',
                    })
                  }
                >
                  去第5步确认图文
                </Button>
              </div>
            )}
            {!rebuildFromConfirmedRegions && (
              <Button
                type="button"
                variant="outline"
                className="h-10 w-full"
                onClick={generateVector}
                disabled={
                  !source ||
                  busy ||
                  Boolean(quadError) ||
                  !sizeResult.value ||
                  !geometryIsConfirmed
                }
              >
                <WandSparkles aria-hidden="true" />
                生成整图参考曲线（不能作制模主文件）
              </Button>
            )}

            {vector && vectorIsCurrent && (
              <div className="space-y-2 rounded-xl border border-emerald-600/25 bg-emerald-500/[0.06] p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-800">
                  <Check className="size-4" aria-hidden="true" />
                  最终黑白曲线已生成；这里显示的就是随后导出的同一份曲线
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  结果编号 {vector.traceVersionId ?? '—'}｜确认文字{' '}
                  {vector.manualTextCount ?? 0}/
                  {vector.expectedTextRegionCount ?? 0} 处（照片可见轮廓{' '}
                  {vector.photoTextRegionCount ?? 0}，确切字体{' '}
                  {vector.fontTextRegionCount ?? 0}）｜照片图案{' '}
                  {vector.tracedGraphicRegionCount ?? 0} 处｜重画线条{' '}
                  {vector.geometricRegionCount ?? 0} 处
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs font-medium">原图叠加校对</p>
                    <div
                      className="relative overflow-hidden rounded-lg border bg-white"
                      style={{
                        aspectRatio: `${vector.viewBoxWidth} / ${vector.viewBoxHeight}`,
                      }}
                    >
                      <canvas
                        ref={comparisonCanvasRef}
                        className="absolute inset-0 h-full w-full object-fill"
                        aria-label="拉正后的原照片"
                      />
                      <svg
                        aria-label="红色曲线与原照片叠加校对"
                        className="absolute inset-0 h-full w-full opacity-60 mix-blend-multiply"
                        viewBox={`0 0 ${vector.viewBoxWidth} ${vector.viewBoxHeight}`}
                      >
                        <g fill="#ef233c" fillRule="evenodd" stroke="none">
                          {vector.paths.map((path, index) => (
                            <path key={`compare-${index}`} d={path} />
                          ))}
                          {vector.overlays?.map((overlay, overlayIndex) => (
                            <g
                              key={`compare-overlay-${overlayIndex}`}
                              fillRule="nonzero"
                              transform={`translate(${overlay.x} ${overlay.y}) scale(${overlay.scaleX} ${overlay.scaleY})`}
                            >
                              {overlay.paths.map((path, pathIndex) => (
                                <path key={pathIndex} d={path} />
                              ))}
                            </g>
                          ))}
                        </g>
                      </svg>
                    </div>
                    <p className="text-[12px] leading-5 text-muted-foreground">
                      逐字检查红色轮廓是否覆盖原字边缘；任何缺笔、多笔、粘连或位置偏差都要回到第5步重做。
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-medium">最终纯黑曲线</p>
                    <div
                      className="grid overflow-hidden rounded-lg border bg-white"
                      style={{
                        aspectRatio: `${vector.viewBoxWidth} / ${vector.viewBoxHeight}`,
                      }}
                    >
                      <svg
                        aria-label="自动描绘矢量结果"
                        className="h-full w-full"
                        viewBox={`0 0 ${vector.viewBoxWidth} ${vector.viewBoxHeight}`}
                      >
                        <rect
                          x="0"
                          y="0"
                          width={vector.viewBoxWidth}
                          height={vector.viewBoxHeight}
                          fill="white"
                        />
                        <g fill="#111111" fillRule="evenodd" stroke="none">
                          {vector.paths.map((path, index) => (
                            <path
                              key={`${path.slice(0, 24)}-${index}`}
                              d={path}
                            />
                          ))}
                          {vector.overlays?.map((overlay, overlayIndex) => (
                            <g
                              key={`confirmed-text-${overlayIndex}`}
                              fillRule="nonzero"
                              transform={`translate(${overlay.x} ${overlay.y}) scale(${overlay.scaleX} ${overlay.scaleY})`}
                            >
                              {overlay.paths.map((path, pathIndex) => (
                                <path key={pathIndex} d={path} />
                              ))}
                            </g>
                          ))}
                        </g>
                      </svg>
                    </div>
                  </div>
                </div>
                {vector.productionBlockedReasons?.map((reason) => (
                  <p
                    key={reason}
                    className="text-xs leading-5 text-destructive"
                  >
                    制模下载已锁定：{reason}
                  </p>
                ))}
                {vector.qualityWarnings?.map((warning) => (
                  <p key={warning} className="text-xs leading-5 text-amber-900">
                    需要CDR复核：{warning}
                  </p>
                ))}
                {vector.reviewWarnings?.map((warning) => (
                  <p key={warning} className="text-xs leading-5 text-amber-900">
                    照片清晰度提示：{warning}
                  </p>
                ))}
                {vector.contentBoundsMm && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    已确认图文选区占位约{' '}
                    {formatInputMillimeters(vector.contentBoundsMm.width)} ×{' '}
                    {formatInputMillimeters(vector.contentBoundsMm.height)}{' '}
                    mm；左边距{' '}
                    {formatInputMillimeters(vector.contentBoundsMm.x)}{' '}
                    mm，上边距{' '}
                    {formatInputMillimeters(vector.contentBoundsMm.y)}{' '}
                    mm。该位置来自整牌毫米坐标，不会按图文外框重新铺满。
                  </p>
                )}
              </div>
            )}

            <label className="flex cursor-pointer items-start gap-2 text-sm leading-5">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={replaceCurrentDesign}
                onChange={(event) =>
                  setReplaceCurrentDesign(event.target.checked)
                }
              />
              <span>加入后隐藏当前示例文字和徽标，避免与复刻图案重叠</span>
            </label>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <p className="rounded-xl bg-muted p-3 text-sm leading-6 text-muted-foreground">
              原照片只在当前浏览器中用于定位和识别，不会进入导出的SVG/CDR。正式描绘会重新读取所选区域，不会直接使用屏幕上的缩小预览。
            </p>
          </section>
        </div>

        {source && !quadError && sizeResult.value && geometryIsConfirmed && (
          <section className="space-y-3 border-t px-5 py-4">
            <div>
              <p className="font-medium">5. 局部去杂纹与逐行原字形复刻</p>
              <p className="text-sm leading-6 text-muted-foreground">
                在拉正照片上拖出一块区域：每次完整框住一行文字并在四周留少量空白，再输入准确内容。推荐模式只输出这些明确确认的图文。
                如果字形或图案内部仍有皮纹、旧针孔或阴影，可在该处再框选“排除这处皮纹”，扣除框允许叠在照片轮廓内部。
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,.8fr)]">
              <div className="rounded-xl border bg-[#24211f] p-2 sm:p-3">
                <div
                  ref={refinementSurfaceRef}
                  role="img"
                  aria-label="拉正照片的局部修正选区"
                  className="relative mx-auto w-full cursor-crosshair touch-none overflow-hidden rounded-lg select-none"
                  style={{
                    aspectRatio: `${sizeResult.value.width} / ${sizeResult.value.height}`,
                  }}
                  onPointerDown={beginRefinementSelection}
                  onPointerMove={moveRefinementSelection}
                  onPointerUp={endRefinementSelection}
                  onPointerCancel={endRefinementSelection}
                >
                  <canvas
                    ref={refinementCanvasRef}
                    className="pointer-events-none absolute inset-0 size-full"
                  />
                  {corrections.map((correction) => (
                    <div
                      key={correction.id}
                      className={`pointer-events-none absolute border-2 ${correction.kind === 'text' ? 'border-sky-300 bg-sky-300/20' : correction.kind === 'keep' ? 'border-emerald-300 bg-emerald-300/20' : 'border-amber-300 bg-amber-300/20'}`}
                      style={{
                        left: `${correction.rect.x * 100}%`,
                        top: `${correction.rect.y * 100}%`,
                        width: `${correction.rect.width * 100}%`,
                        height: `${correction.rect.height * 100}%`,
                      }}
                    />
                  ))}
                  {selection && (
                    <div
                      className="pointer-events-none absolute border-2 border-white bg-white/15"
                      style={{
                        left: `${selection.x * 100}%`,
                        top: `${selection.y * 100}%`,
                        width: `${selection.width * 100}%`,
                        height: `${selection.height * 100}%`,
                      }}
                    />
                  )}
                </div>
              </div>
              <div className="space-y-3">
                <div className="space-y-2 rounded-lg border bg-white p-3">
                  <label
                    htmlFor="trace-expected-text-count"
                    className="block text-sm font-medium"
                  >
                    原图共有几处需要保留的文字？
                  </label>
                  <Input
                    id="trace-expected-text-count"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="30"
                    value={expectedTextRegionCountInput}
                    placeholder="没有文字请填0"
                    onChange={(event) => {
                      setExpectedTextRegionCountInput(event.target.value);
                      setTextChecked(false);
                    }}
                  />
                  <p
                    className={`text-xs leading-5 ${textCountMatches ? 'text-emerald-700' : 'text-amber-900'}`}
                  >
                    已确认 {confirmedTextCount} 处文字。
                    {expectedTextRegionCount === null
                      ? ' 请先填写总数。'
                      : textCountMatches
                        ? ' 数量一致。'
                        : ` 还需确认 ${Math.max(0, expectedTextRegionCount - confirmedTextCount)} 处。`}
                  </p>
                </div>
                <p className="text-sm">
                  {selection
                    ? `已选 ${formatInputMillimeters(selection.width * sizeResult.value.width)} × ${formatInputMillimeters(selection.height * sizeResult.value.height)} mm`
                    : '请先在左边拖出要处理的范围'}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!selection}
                  onClick={() => addCorrection('erase')}
                >
                  排除这处皮纹/旧边框
                </Button>
                <div className="space-y-3 rounded-lg border bg-white p-3">
                  <p className="text-sm font-medium">保留非文字图案</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={
                        correctionPolarity === 'dark' ? 'default' : 'outline'
                      }
                      onClick={() => setCorrectionPolarity('dark')}
                    >
                      深色图案
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={
                        correctionPolarity === 'light' ? 'default' : 'outline'
                      }
                      onClick={() => setCorrectionPolarity('light')}
                    >
                      浅色/反白图案
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={
                        correctionDetailMode === 'clean' ? 'default' : 'outline'
                      }
                      onClick={() => setCorrectionDetailMode('clean')}
                    >
                      清洁完整轮廓
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={
                        correctionDetailMode === 'distressed'
                          ? 'default'
                          : 'outline'
                      }
                      onClick={() => setCorrectionDetailMode('distressed')}
                    >
                      保留有意做旧
                    </Button>
                  </div>
                  <div className="grid min-h-20 place-items-center overflow-hidden rounded border bg-white p-1">
                    {selection ? (
                      <canvas
                        ref={selectionPreviewCanvasRef}
                        aria-label="当前选区固定明暗方向的黑白结果"
                        className="max-h-28 max-w-full object-contain"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        框选后显示该区域真正会使用的黑白结果
                      </span>
                    )}
                  </div>
                  <label className="flex items-start gap-2 text-xs leading-5">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={graphicChecked}
                      onChange={(event) =>
                        setGraphicChecked(event.target.checked)
                      }
                    />
                    <span>
                      我确认这里是非文字图案；字母、数字和单词必须使用下方“清晰文字”重绘。
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!selection || !graphicChecked}
                    onClick={() => addCorrection('keep')}
                  >
                    按当前黑白结果保留图案
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 rounded-lg border bg-white p-2">
                  <p className="w-full text-xs leading-5 text-muted-foreground">
                    线条或箭头请从起点拖到终点，再点下面按钮；会重建为笔直的约0.32
                    mm曲线，不使用照片毛边。
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!selectionEndpoints}
                    onClick={() => addCorrection('line')}
                  >
                    重画直线
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!selectionEndpoints}
                    onClick={() => addCorrection('arrow')}
                  >
                    重画箭头
                  </Button>
                </div>
                <div className="border-t pt-3">
                  <label
                    htmlFor="trace-corrected-text"
                    className="mb-2 block text-sm font-medium"
                  >
                    这处文字的准确内容
                  </label>
                  <Input
                    id="trace-corrected-text"
                    value={correctionText}
                    maxLength={80}
                    placeholder="例如 DENIM WEAR"
                    onChange={(event) => {
                      setCorrectionText(event.target.value);
                      setTextChecked(false);
                    }}
                  />
                  {correctionText && (
                    <p className="mt-2 rounded border bg-muted/40 px-2 py-1 font-mono text-xs leading-5">
                      逐字符核对（□代表空格）：
                      {correctionText.replaceAll(' ', '□')}｜共{' '}
                      {Array.from(correctionText).length} 个字符
                    </p>
                  )}
                </div>
                <div className="space-y-3 rounded-lg border bg-white p-3">
                  <p className="text-sm font-medium">文字曲线来源</p>
                  <label className="flex items-start gap-2 text-sm leading-6">
                    <input
                      type="radio"
                      name="trace-text-shape-source"
                      aria-label="按照片原字形描绘"
                      className="mt-1"
                      checked={correctionTextShapeSource === 'photo-outline'}
                      onChange={() => {
                        setCorrectionTextShapeSource('photo-outline');
                        setTextChecked(false);
                      }}
                    />
                    <span>
                      <strong>按照片原字形清边（默认，不需要知道字体）</strong>
                      <span className="block text-xs text-muted-foreground">
                        直接提取照片中可见轮廓并放回原位置，只清理皮纹毛刺和像素台阶；不重新套字体、缩放或调整字距。输入文字只用于防错字。
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm leading-6">
                    <input
                      type="radio"
                      name="trace-text-shape-source"
                      aria-label="使用客户提供的确切字体文件重建"
                      className="mt-1"
                      checked={correctionTextShapeSource === 'font-outline'}
                      onChange={() => {
                        setCorrectionTextShapeSource('font-outline');
                        setTextChecked(false);
                      }}
                    />
                    <span>
                      客户恰好提供字体文件时使用（可选）
                      <span className="block text-xs text-muted-foreground">
                        普通随手拍不需要字体文件。只有客户确实提供了原字体时才使用；相似字体不能代替。
                      </span>
                    </span>
                  </label>

                  {correctionTextShapeSource === 'photo-outline' ? (
                    <div className="space-y-2 border-t pt-3">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            correctionPolarity === 'dark'
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() => {
                            setCorrectionPolarity('dark');
                            setTextChecked(false);
                          }}
                        >
                          深色文字
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            correctionPolarity === 'light'
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() => {
                            setCorrectionPolarity('light');
                            setTextChecked(false);
                          }}
                        >
                          浅色/反白文字
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            correctionDetailMode === 'clean'
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() => {
                            setCorrectionDetailMode('clean');
                            setTextChecked(false);
                          }}
                        >
                          清洁完整字形
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            correctionDetailMode === 'distressed'
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() => {
                            setCorrectionDetailMode('distressed');
                            setTextChecked(false);
                          }}
                        >
                          保留有意做旧
                        </Button>
                      </div>
                      <div className="grid min-h-20 place-items-center overflow-hidden rounded border bg-white p-1">
                        {selection ? (
                          <canvas
                            ref={textSelectionPreviewCanvasRef}
                            aria-label="当前文字选区的原字形黑白结果"
                            className="max-h-28 max-w-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            框紧整行文字后，在这里核对原字形轮廓
                          </span>
                        )}
                      </div>
                      <p
                        className={`text-xs leading-5 ${(projectedPhotoTextPpm ?? 0) < PHOTO_DETAIL_CLEAR_PPM ? 'text-amber-900' : 'text-emerald-700'}`}
                      >
                        原照片细节约 {(projectedPhotoTextPpm ?? 0).toFixed(1)}{' '}
                        像素/mm。
                        {(projectedPhotoTextPpm ?? 0) < PHOTO_DETAIL_LOW_PPM
                          ? ' 低清时仍可生成保持原尺寸的CDR描修稿；系统不会用相似字体猜字形。'
                          : (projectedPhotoTextPpm ?? 0) <
                              PHOTO_DETAIL_CLEAR_PPM
                            ? ' 可以继续描绘，但细笔画必须用红线叠图和CDR重点复核。'
                            : ' 细节较充足，仍需在最终叠加图逐笔核对。'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2 border-t pt-3">
                      <label
                        htmlFor="trace-corrected-font"
                        className="block text-sm font-medium"
                      >
                        确切字体文件
                      </label>
                      <p
                        id="trace-corrected-font"
                        className={`rounded-md border px-3 py-2 text-sm ${customFont ? 'border-emerald-600/30 bg-emerald-50 text-emerald-900' : 'border-destructive/30 bg-destructive/5 text-destructive'}`}
                      >
                        {customFont
                          ? `已载入客户字体：${customFont.name}`
                          : '尚未载入客户的确切字体文件'}
                      </p>
                      <label
                        htmlFor="trace-custom-font"
                        className="inline-flex cursor-pointer items-center rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted"
                      >
                        导入客户提供的TTF/OTF字体
                      </label>
                      <Input
                        id="trace-custom-font"
                        type="file"
                        accept=".ttf,.otf,font/ttf,font/otf"
                        className="sr-only"
                        onChange={handleCustomFontUpload}
                      />
                      <p className="text-xs leading-5 text-muted-foreground">
                        不再提供“相似字体”替代。字体文件属于少数备用情况，仍要用原图叠加检查字高、字宽、字距和位置，并确认字体来源及使用许可。
                      </p>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="trace-corrected-text-confirm"
                    className="block text-sm font-medium"
                  >
                    再次输入准确文字
                  </label>
                  <Input
                    id="trace-corrected-text-confirm"
                    value={correctionTextConfirm}
                    maxLength={80}
                    placeholder="请对照客户资料再输入一次"
                    onChange={(event) => {
                      setCorrectionTextConfirm(event.target.value);
                      setTextChecked(false);
                    }}
                  />
                  {correctionTextConfirm &&
                    correctionText.trim() !== correctionTextConfirm.trim() && (
                      <p className="text-xs text-destructive">
                        两次输入不同，请逐字核对。
                      </p>
                    )}
                </div>
                {correctionText.trim() &&
                  correctionTextShapeSource === 'font-outline' && (
                    <div className="space-y-2 rounded-lg border bg-white p-3">
                      <p className="text-xs text-muted-foreground">
                        本次实际文字放大预览（请核对每个字母、数字及笔画）
                      </p>
                      {textPreviewCurve && (
                        <svg
                          viewBox="0 0 600 100"
                          className="h-20 w-full bg-white"
                          role="img"
                          aria-label={`曲线字形预览：${correctionText.trim()}`}
                        >
                          <g
                            fill="#000"
                            fillRule="nonzero"
                            transform={`translate(${textPreviewCurve.x} ${textPreviewCurve.y}) scale(${textPreviewCurve.scaleX} ${textPreviewCurve.scaleY})`}
                          >
                            {textPreviewCurve.paths.map((path, index) => (
                              <path key={index} d={path} />
                            ))}
                          </g>
                        </svg>
                      )}
                      {textPreviewError && (
                        <p className="text-xs text-destructive">
                          {textPreviewError}
                        </p>
                      )}
                      <p className="text-xs leading-5 text-amber-900">
                        预览与曲线由同一份字体文件生成；缺少字形会阻止生成，不会偷偷换字。没有确切字体文件时请改用“按照片原字形描绘”。
                      </p>
                    </div>
                  )}
                <label className="flex items-start gap-2 text-sm leading-6">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-[var(--primary)]"
                    checked={textChecked}
                    onChange={(event) => setTextChecked(event.target.checked)}
                  />
                  <span>
                    我已逐字核对内容，并确认
                    {correctionTextShapeSource === 'photo-outline'
                      ? '黑白预览只取照片中可见轮廓、没有换成相似字体，并已检查选区没有裁字'
                      : '所选字体文件与客户原稿完全一致'}
                  </span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !selection ||
                    !correctionText.trim() ||
                    correctionText.trim() !== correctionTextConfirm.trim() ||
                    (correctionTextShapeSource === 'font-outline' &&
                      !textPreviewCurve) ||
                    !textChecked
                  }
                  onClick={() => addCorrection('text')}
                >
                  {correctionTextShapeSource === 'photo-outline'
                    ? '按照片原字形保留此行'
                    : '按确切字体文件重建此行'}
                </Button>
              </div>
            </div>
            {(corrections.length > 0 || redoCorrections.length > 0) && (
              <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">已确认区域</p>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={undoLatestCorrection}
                      disabled={corrections.length === 0}
                    >
                      <History aria-hidden="true" />
                      撤销上一步
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={redoLatestCorrection}
                      disabled={redoCorrections.length === 0}
                    >
                      重做
                    </Button>
                  </div>
                </div>
                {corrections.map((correction, index) => (
                  <div
                    key={correction.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="truncate">
                      {index + 1}.{' '}
                      {correction.kind === 'text'
                        ? `${correction.textShapeSource === 'photo-outline' ? '照片原字形' : '确切字体'}：${correction.text}${correction.fontName ? `（${correction.fontName}）` : ''}`
                        : correction.kind === 'keep'
                          ? `${correction.polarity === 'light' ? '浅色/反白' : '深色'}非文字图案｜${correction.detailMode === 'distressed' ? '保留做旧' : '清洁轮廓'}`
                          : correction.kind === 'line'
                            ? '几何直线'
                            : correction.kind === 'arrow'
                              ? '几何箭头'
                              : '排除杂纹/旧边框'}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeCorrection(correction.id)}
                    >
                      撤销
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              这一步不会猜测照片里看不清的字。字体转成曲线后不依赖模具厂电脑的字体，但特殊品牌字形仍应以客户原稿或人工描字为准。
            </p>
            <Button
              type="button"
              className="w-full sm:w-auto"
              onClick={generateVector}
              disabled={
                busy ||
                Boolean(quadError) ||
                !sizeResult.value ||
                !geometryIsConfirmed
              }
            >
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <WandSparkles aria-hidden="true" />
              )}
              {busy ? '正在重绘曲线…' : '按局部修正重新生成曲线'}
            </Button>
            <p className="text-xs text-muted-foreground">
              生成后请回到上方第4步放大检查曲线，再加入画布。
            </p>
          </section>
        )}

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            取消
          </DialogClose>
          <Button
            type="button"
            className="h-10"
            onClick={applyVector}
            disabled={
              !vectorIsCurrent ||
              !sizeResult.value ||
              busy ||
              Boolean(quadError) ||
              !geometryIsConfirmed
            }
          >
            <Check aria-hidden="true" />
            保持原位置加入画布
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
