'use client';

import {
  Check,
  Crop,
  LoaderCircle,
  RotateCcw,
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

import {
  DimensionInput,
  RangeField,
} from '@/components/leather-label-ui';
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
  CURVE_FONT_OPTIONS,
  type CurveFontId,
} from '@/lib/vector-font';
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
  fontId?: string;
  start?: NormalizedPoint;
  end?: NormalizedPoint;
};

const FULL_PHOTO_VIEWPORT: PhotoViewport = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

const DEFAULT_QUAD: NormalizedQuad = {
  nw: { x: 0.05, y: 0.05 },
  ne: { x: 0.95, y: 0.05 },
  se: { x: 0.95, y: 0.95 },
  sw: { x: 0.05, y: 0.95 },
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
  const outputScale = Math.min(
    1,
    maximumLongSide / Math.max(uncappedWidth, uncappedHeight),
  );
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
  if (length < pixelsPerMillimeter) throw new Error('直线长度不足1 mm，请重新拖动。');
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const halfStroke = pixelsPerMillimeter * 0.16;
  const headLength = arrow ? Math.min(length * 0.28, pixelsPerMillimeter * 2.4) : 0;
  const headHalfWidth = pixelsPerMillimeter * 0.85;
  const shaftEndX = x2 - ux * headLength;
  const shaftEndY = y2 - uy * headLength;
  const points: [number, number][] = [
    [x1 + nx * halfStroke, y1 + ny * halfStroke],
    [shaftEndX + nx * halfStroke, shaftEndY + ny * halfStroke],
    ...(arrow ? [
      [shaftEndX + nx * headHalfWidth, shaftEndY + ny * headHalfWidth],
      [x2, y2],
      [shaftEndX - nx * headHalfWidth, shaftEndY - ny * headHalfWidth],
    ] as [number, number][] : []),
    [shaftEndX - nx * halfStroke, shaftEndY - ny * halfStroke],
    [x1 - nx * halfStroke, y1 - ny * halfStroke],
  ];
  return {
    paths: [`M${points.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L')}Z`],
    x: 0, y: 0, scaleX: 1, scaleY: 1,
  };
}

function preprocessWithCorrections(
  corrected: RasterData,
  options: TracePreprocessOptions,
  corrections: CorrectionRegion[],
  rebuildFromConfirmedRegions: boolean,
) {
  // Production reconstruction starts on a blank canvas. Photo pixels enter
  // only where the user explicitly selected a graphic/line to keep; unread
  // photographed lettering cannot silently become a mold curve.
  let processed = rebuildFromConfirmedRegions
    ? {
        width: corrected.width,
        height: corrected.height,
        data: new Uint8ClampedArray(
          corrected.width * corrected.height * 4,
        ).fill(255),
      }
    : preprocessForTrace(corrected, options);
  const kept = corrections.filter((correction) => correction.kind === 'keep');
  if (kept.length > 0) {
    const output = new Uint8ClampedArray(processed.data);
    for (const correction of kept) {
      const left = Math.max(0, Math.floor(correction.rect.x * corrected.width));
      const top = Math.max(0, Math.floor(correction.rect.y * corrected.height));
      const right = Math.min(corrected.width, Math.ceil((correction.rect.x + correction.rect.width) * corrected.width));
      const bottom = Math.min(corrected.height, Math.ceil((correction.rect.y + correction.rect.height) * corrected.height));
      const width = right - left;
      const height = bottom - top;
      if (width < 2 || height < 2) continue;
      const cropData = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        const sourceOffset = ((top + y) * corrected.width + left) * 4;
        cropData.set(corrected.data.subarray(sourceOffset, sourceOffset + width * 4), y * width * 4);
      }
      // Re-estimate the leather/background contrast inside this selected
      // graphic, so a faint motif can be recovered even when the whole-photo
      // threshold missed it.
      const detail = preprocessForTrace({ width, height, data: cropData }, {
        ...options,
        edgeCleanupPercent: 0,
        preserveCanvas: true,
      });
      for (let y = 0; y < height; y += 1) {
        output.set(detail.data.subarray(y * width * 4, (y + 1) * width * 4), ((top + y) * corrected.width + left) * 4);
      }
    }
    processed = { ...processed, data: output };
  }
  return eraseRasterRegions(
    processed,
    corrections
      .filter((correction) => correction.kind !== 'keep')
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
  const [selection, setSelection] = useState<NormalizedRect | null>(null);
  const [selectionEndpoints, setSelectionEndpoints] = useState<{
    start: NormalizedPoint;
    end: NormalizedPoint;
  } | null>(null);
  const [correctionText, setCorrectionText] = useState('');
  const [correctionTextConfirm, setCorrectionTextConfirm] = useState('');
  const [correctionFontId, setCorrectionFontId] = useState<CurveFontId>('arvo');
  const [textChecked, setTextChecked] = useState(false);
  const [textPreviewCurve, setTextPreviewCurve] = useState<VectorOverlay | null>(null);
  const [textPreviewError, setTextPreviewError] = useState('');

  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const uploadSequenceRef = useRef(0);
  const calibrationSurfaceRef = useRef<HTMLDivElement | null>(null);
  const rectifiedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const refinementCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const refinementSurfaceRef = useRef<HTMLDivElement | null>(null);
  const refinementDragRef = useRef<NormalizedPoint | null>(null);
  const nextCorrectionIdRef = useRef(1);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragOperation | null>(null);
  const sizeResult = validateTargetSize(targetWidthInput, targetHeightInput);
  const quadError = validateQuad(quad);
  const traceInputSignature = [
    source?.url ?? '',
    targetWidthInput,
    targetHeightInput,
    detailSensitivity,
    cleanup,
    edgeCleanupPercent,
    preserveFineDetail,
    rebuildFromConfirmedRegions,
    polarity,
    ...corrections.flatMap((correction) => [
      correction.id,
      correction.kind,
      correction.rect.x,
      correction.rect.y,
      correction.rect.width,
      correction.rect.height,
      correction.text ?? '',
      correction.fontId ?? '',
      correction.start?.x ?? '', correction.start?.y ?? '',
      correction.end?.x ?? '', correction.end?.y ?? '',
    ]),
    ...QUAD_CORNERS.flatMap((corner) => [quad[corner].x, quad[corner].y]),
  ].join('|');
  const latestTraceInputSignatureRef = useRef(traceInputSignature);
  latestTraceInputSignatureRef.current = traceInputSignature;
  const vectorIsCurrent =
    Boolean(vector) && vectorSignature === traceInputSignature;

  useEffect(() => {
    let active = true;
    setTextPreviewCurve(null);
    setTextPreviewError('');
    const text = correctionText.trim();
    if (text) {
      confirmedTextCurve(text, correctionFontId, { x: 0, y: 0, width: 600, height: 100 })
        .then((curve) => { if (active) setTextPreviewCurve(curve); })
        .catch((error) => { if (active) setTextPreviewError(error instanceof Error ? error.message : '字体预览失败。'); });
    }
    return () => { active = false; };
  }, [correctionText, correctionFontId]);

  useEffect(() => {
    return () => {
      uploadSequenceRef.current += 1;
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (
      !open ||
      !source ||
      !sourceImageRef.current ||
      !sizeResult.value ||
      quadError
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
            pathomit: 0,
            ltres: 0.55,
            qtres: 0.55,
            rightangleenhance: true,
            linefilter: false,
            strokewidth: 0,
            roundcoords: 2,
            viewbox: true,
            desc: false,
          });
          if (!cancelled) setDraftVector({
            width: candidate.width,
            height: candidate.height,
            paths: extractBlackVectorPaths(draftSvg),
          });
        }
        if (!cancelled) setError('');
      } catch (previewError) {
        if (!cancelled) setError(
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
    source,
    targetHeightInput,
    targetWidthInput,
  ]);

  function handlePhotoUpload(event: ChangeEvent<HTMLInputElement>) {
    const uploadSequence = ++uploadSequenceRef.current;
    const file = event.target.files?.[0];
    setError('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('请上传JPG、PNG或WebP照片。');
      event.target.value = '';
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('照片不能超过15 MB。');
      event.target.value = '';
      return;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    setSource(null);
    sourceImageRef.current = null;
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
    setVector(null);
    setDraftVector(null);
    setVectorSignature('');
    setCorrections([]);
    setSelection(null);
    setTextChecked(false);
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
      sourceImageRef.current = image;
      setSource({
        name: file.name,
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      setQuad(cloneQuad(DEFAULT_QUAD));
      setRedrawArmed(true);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      if (uploadSequence === uploadSequenceRef.current)
        setError('照片读取失败，请重新选择。');
    };
    image.src = url;
    event.target.value = '';
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
    if (corrections.length >= 30) {
      setError('最多添加30处局部修正，请先删除不需要的区域。');
      return;
    }
    const geometric = kind === 'line' || kind === 'arrow';
    if (geometric && (!selectionEndpoints || Math.hypot(
      (selectionEndpoints.end.x - selectionEndpoints.start.x) * sizeResult.value.width,
      (selectionEndpoints.end.y - selectionEndpoints.start.y) * sizeResult.value.height,
    ) < 1)) {
      setError('请沿线条或箭头从起点拖到终点，长度至少1 mm。');
      return;
    }
    if (!geometric && (
      selection.width * sizeResult.value.width < 0.5 ||
      selection.height * sizeResult.value.height < 0.5
    )) {
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
    setCorrections((current) => [
      ...current,
      {
        id: nextCorrectionIdRef.current++,
        kind,
        rect: geometric
          ? {
              x: Math.max(0, selection.x - 0.6 / sizeResult.value.width),
              y: Math.max(0, selection.y - 0.6 / sizeResult.value.height),
              width: Math.min(1, selection.x + selection.width + 0.6 / sizeResult.value.width) - Math.max(0, selection.x - 0.6 / sizeResult.value.width),
              height: Math.min(1, selection.y + selection.height + 0.6 / sizeResult.value.height) - Math.max(0, selection.y - 0.6 / sizeResult.value.height),
            }
          : selection,
        ...(kind === 'text'
          ? { text: exactText, fontId: correctionFontId }
          : {}),
        ...(geometric && selectionEndpoints ? selectionEndpoints : {}),
      },
    ]);
    setSelection(null);
    setSelectionEndpoints(null);
    setTextChecked(false);
    if (kind === 'text') {
      setCorrectionText('');
      setCorrectionTextConfirm('');
    }
    setError('');
  }

  async function generateVector() {
    const image = sourceImageRef.current;
    if (!source || !image || !sizeResult.value || quadError) {
      setError(quadError || '请先上传照片、校正皮牌四角并填写成品尺寸。');
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
      const processed = preprocessWithCorrections(
        corrected,
        {
          detailSensitivity,
          cleanup,
          edgeCleanupPercent,
          preserveCanvas: true,
          preserveFineDetail,
          polarity,
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
        !corrections.some((correction) => ['text', 'line', 'arrow'].includes(correction.kind))
      ) {
        throw new Error(
          '当前没有确认的图文，请在第5步选择要保留的图案，或逐行重绘文字、线条。',
        );
      }
      if (formalInkRatio > 0.88) {
        throw new Error('当前识别内容过多，请降低“图文完整度”或重新校正四角。');
      }
      const { default: imageTracer } = await import('imagetracerjs');
      const tracedSvg = imageTracer.imagedataToSVG(processed, {
        pal: [
          { r: 0, g: 0, b: 0, a: 255 },
          { r: 255, g: 255, b: 255, a: 255 },
        ],
        colorsampling: 0,
        colorquantcycles: 1,
        pathomit: preserveFineDetail
          ? 0
          : cleanup === 0
            ? 0
            : Math.min(2, Math.floor(cleanup / 3) + 1),
        ltres: 0.55,
        qtres: 0.55,
        rightangleenhance: true,
        linefilter: false,
        strokewidth: 0,
        roundcoords: 2,
        viewbox: true,
        desc: false,
      });
      const paths = extractBlackVectorPaths(tracedSvg);
      const overlays: VectorOverlay[] = [];
      for (const correction of corrections) {
        if ((correction.kind === 'line' || correction.kind === 'arrow') && correction.start && correction.end) {
          overlays.push(geometricLineCurve(
            correction.start, correction.end,
            processed.width, processed.height,
            Math.min(processed.width / sizeResult.value.width, processed.height / sizeResult.value.height),
            correction.kind === 'arrow',
          ));
          continue;
        }
        if (correction.kind !== 'text' || !correction.text) continue;
        const targetWidth = correction.rect.width * processed.width;
        const targetHeight = correction.rect.height * processed.height;
        overlays.push(await confirmedTextCurve(
          correction.text,
          (correction.fontId ?? 'arvo') as CurveFontId,
          {
            x: correction.rect.x * processed.width,
            y: correction.rect.y * processed.height,
            width: targetWidth,
            height: targetHeight,
          },
        ));
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
      setVector({
        viewBoxWidth: processed.width,
        viewBoxHeight: processed.height,
        paths,
        overlays,
        coordinateSpace: 'label',
        calibratedWidth: sizeResult.value.width,
        calibratedHeight: sizeResult.value.height,
        sourcePixelsPerMillimeter: getSourcePixelsPerMillimeter(
          source.width,
          source.height,
          quad,
          sizeResult.value.width,
          sizeResult.value.height,
        ),
        manualTextCount: corrections.filter((correction) => correction.kind === 'text').length,
        excludedRegionCount: corrections.filter(
          (correction) => correction.kind !== 'keep',
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
                      variant={redrawArmed ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setPhotoViewport(FULL_PHOTO_VIEWPORT);
                        setRedrawArmed(true);
                        setCorrections([]);
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
                        setRedrawArmed(false);
                        setCorrections([]);
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
              {source && !quadError && sizeResult.value ? (
                <canvas
                  ref={rectifiedCanvasRef}
                  aria-label="四角拉正后的完整皮牌"
                  className="max-h-48 max-w-full object-contain"
                />
              ) : (
                <p className="text-sm text-white/70">
                  完成四角和尺寸后在这里检查
                </p>
              )}
            </div>
            <div className="rounded-xl border border-emerald-600/25 bg-emerald-500/[0.07] p-3 text-sm leading-6 text-emerald-900">
              <span className="font-medium">成品坐标已锁定</span>
              <span className="block">
                后续不会把图文裁紧、自动居中、拉伸或铺满成品尺寸。
              </span>
            </div>
            {sourcePixelsPerMillimeter !== null && (
              <p
                className={`rounded-xl border p-3 text-sm leading-6 ${sourcePixelsPerMillimeter < 4 ? 'border-amber-600/25 bg-amber-500/10 text-amber-900' : 'bg-muted/40 text-muted-foreground'}`}
              >
                当前所选照片约为 {sourcePixelsPerMillimeter.toFixed(1)}{' '}
                像素/mm。
                {sourcePixelsPerMillimeter < 4
                  ? ' 清晰度偏低，位置仍可校正，但细小字形需要后续重点核对。'
                  : ' 当前清晰度可用于本阶段的位置校正。'}
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
                <input type="radio" name="trace-reconstruction-mode" className="mt-1" checked={rebuildFromConfirmedRegions} onChange={() => setRebuildFromConfirmedRegions(true)} />
                <span>按确认内容重建（推荐）：自动候选仍可看，制模稿只保留逐处确认的图案与文字</span>
              </label>
              <label className="flex items-start gap-2 text-sm leading-6">
                <input type="radio" name="trace-reconstruction-mode" className="mt-1" checked={!rebuildFromConfirmedRegions} onChange={() => setRebuildFromConfirmedRegions(false)} />
                <span>整张照片自动描边（仅参考）：可能混入皮纹、旧缝线与错字</span>
              </label>
            </div>
            <div className="rounded-xl border border-amber-600/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900">
              <span className="font-medium">照片只是定位依据，不能代替逐字核对</span>
              <span className="block">
                请在第5步框选每处要保留的图案和线条，并输入每行准确文字；框内皮纹或旧字仍可能混入，选区应尽量贴合图案。
              </span>
            </div>
            <div className="grid min-h-44 place-items-center overflow-hidden rounded-xl border bg-white p-2">
              {source ? (
                <>
                  <canvas
                    ref={previewCanvasRef}
                    aria-label="照片自动描绘候选"
                    className={draftVector?.paths.length ? 'hidden' : 'max-h-56 max-w-full object-contain'}
                  />
                  {draftVector && draftVector.paths.length > 0 && (
                    <svg aria-label="照片自动描绘的矢量候选，仅供参考" viewBox={`0 0 ${draftVector.width} ${draftVector.height}`} className="max-h-56 max-w-full">
                      <rect width={draftVector.width} height={draftVector.height} fill="white" />
                      <g fill="#000" fillRule="evenodd" stroke="none">
                        {draftVector.paths.map((path, index) => <path key={index} d={path} />)}
                      </g>
                    </svg>
                  )}
                  {draftBusy && <p className="text-xs text-muted-foreground">正在生成自动矢量候选…</p>}
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
                自动候选黑色覆盖约 {(inkRatio * 100).toFixed(1)}%（不是识别准确率）。
                {inkRatio < 0.02 && ' 当前只识别出少量线条，请分别试“深色压痕”“浅色压痕”，并检查四角框选。'}
              </p>
            )}
            {rebuildFromConfirmedRegions && corrections.length === 0 && <div className="rounded-xl border border-amber-600/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900">
              自动候选已可查看。制模稿尚未加入任何确认内容，请继续到第5步框选图案、重绘文字。
              <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => refinementSurfaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>去第5步确认图文</Button>
            </div>}
            {!rebuildFromConfirmedRegions && <Button type="button" variant="outline" className="h-10 w-full" onClick={generateVector} disabled={!source || busy || Boolean(quadError) || !sizeResult.value}>
              <WandSparkles aria-hidden="true" />
              生成整图参考曲线（不能作制模主文件）
            </Button>}

            {vector && vectorIsCurrent && (
              <div className="space-y-2 rounded-xl border border-emerald-600/25 bg-emerald-500/[0.06] p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-800">
                  <Check className="size-4" aria-hidden="true" />
                  曲线候选已生成，请核对后加入画布
                </div>
                <div className="grid min-h-28 place-items-center overflow-hidden rounded-lg bg-white p-2">
                  <svg
                    aria-label="自动描绘矢量结果"
                    className="max-h-36 max-w-full"
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
                        <path key={`${path.slice(0, 24)}-${index}`} d={path} />
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

        {source && !quadError && sizeResult.value && (
          <section className="space-y-3 border-t px-5 py-4">
            <div>
              <p className="font-medium">5. 局部去杂纹与逐字重绘</p>
              <p className="text-sm leading-6 text-muted-foreground">
                在拉正照片上拖出一块区域：保留需要的图案和线条，或对照客户资料输入准确文字。每次选一行文字。推荐模式只输出这些明确选取的内容。
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-2"
                  disabled={!selection}
                  onClick={() => addCorrection('keep')}
                >
                  保留这处图案/细线
                </Button>
                <div className="flex flex-wrap gap-2 rounded-lg border bg-white p-2">
                  <p className="w-full text-xs leading-5 text-muted-foreground">线条或箭头请从起点拖到终点，再点下面按钮；会重建为笔直的约0.32 mm曲线，不使用照片毛边。</p>
                  <Button type="button" variant="outline" size="sm" disabled={!selectionEndpoints} onClick={() => addCorrection('line')}>重画直线</Button>
                  <Button type="button" variant="outline" size="sm" disabled={!selectionEndpoints} onClick={() => addCorrection('arrow')}>重画箭头</Button>
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
                </div>
                <div className="space-y-2">
                  <label htmlFor="trace-corrected-font" className="block text-sm font-medium">重绘字体（实际曲线文件）</label>
                  <select id="trace-corrected-font" className="h-10 w-full rounded-md border bg-white px-3 text-sm" value={correctionFontId} onChange={(event) => { setCorrectionFontId(event.target.value as CurveFontId); setTextChecked(false); }}>
                    {CURVE_FONT_OPTIONS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label htmlFor="trace-corrected-text-confirm" className="block text-sm font-medium">再次输入准确文字</label>
                  <Input id="trace-corrected-text-confirm" value={correctionTextConfirm} maxLength={80} placeholder="请对照客户资料再输入一次" onChange={(event) => { setCorrectionTextConfirm(event.target.value); setTextChecked(false); }} />
                  {correctionTextConfirm && correctionText.trim() !== correctionTextConfirm.trim() && <p className="text-xs text-destructive">两次输入不同，请逐字核对。</p>}
                </div>
                {correctionText.trim() && (
                  <div className="space-y-2 rounded-lg border bg-white p-3">
                    <p className="text-xs text-muted-foreground">
                      本次实际文字放大预览（请核对每个字母、数字及笔画）
                    </p>
                    {textPreviewCurve && <svg viewBox="0 0 600 100" className="h-20 w-full bg-white" role="img" aria-label={`曲线字形预览：${correctionText.trim()}`}>
                      <g fill="#000" fillRule="nonzero" transform={`translate(${textPreviewCurve.x} ${textPreviewCurve.y}) scale(${textPreviewCurve.scaleX} ${textPreviewCurve.scaleY})`}>
                        {textPreviewCurve.paths.map((path, index) => <path key={index} d={path} />)}
                      </g>
                    </svg>}
                    {textPreviewError && <p className="text-xs text-destructive">{textPreviewError}</p>}
                    <p className="text-xs leading-5 text-amber-900">
                      预览与曲线由同一份授权字体文件生成；缺少字形会阻止生成，不会偷偷换字。特殊品牌字体仍需在 CDR 中人工核对或描字。
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
                  <span>我已对照客户资料逐字核对内容，并检查所选字体外形</span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !selection || !correctionText.trim() || correctionText.trim() !== correctionTextConfirm.trim() || !textPreviewCurve || !textChecked
                  }
                  onClick={() => addCorrection('text')}
                >
                  将此处重绘为清晰文字
                </Button>
              </div>
            </div>
            {corrections.length > 0 && (
              <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
                <p className="text-sm font-medium">
                  已添加的修正（可逐项撤销）
                </p>
                {corrections.map((correction, index) => (
                  <div
                    key={correction.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="truncate">
                      {index + 1}.{' '}
                      {correction.kind === 'text'
                        ? `清晰文字：${correction.text}`
                        : correction.kind === 'keep'
                          ? '保留图案/细线'
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
                      onClick={() =>
                        setCorrections((current) =>
                          current.filter((item) => item.id !== correction.id),
                        )
                      }
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
              disabled={busy || Boolean(quadError) || !sizeResult.value}
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
              Boolean(quadError)
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
