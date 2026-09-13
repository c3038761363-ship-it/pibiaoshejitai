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
  extractBlackVectorPaths,
  preprocessForTrace,
  type NormalizedPoint,
  type NormalizedQuad,
  type RasterData,
  type TracedVector,
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
  const [edgeCleanupPercent, setEdgeCleanupPercent] = useState(12);
  const [targetWidthInput, setTargetWidthInput] = useState(
    formatInputMillimeters(currentWidth),
  );
  const [targetHeightInput, setTargetHeightInput] = useState(
    formatInputMillimeters(currentHeight),
  );
  const [replaceCurrentDesign, setReplaceCurrentDesign] = useState(true);
  const [vector, setVector] = useState<TracedVector | null>(null);
  const [vectorSignature, setVectorSignature] = useState('');
  const [inkRatio, setInkRatio] = useState(0);
  const [sourcePixelsPerMillimeter, setSourcePixelsPerMillimeter] = useState<
    number | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [redrawArmed, setRedrawArmed] = useState(false);
  const [photoViewport, setPhotoViewport] =
    useState<PhotoViewport>(FULL_PHOTO_VIEWPORT);

  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const uploadSequenceRef = useRef(0);
  const calibrationSurfaceRef = useRef<HTMLDivElement | null>(null);
  const rectifiedCanvasRef = useRef<HTMLCanvasElement | null>(null);
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
    ...QUAD_CORNERS.flatMap((corner) => [quad[corner].x, quad[corner].y]),
  ].join('|');
  const latestTraceInputSignatureRef = useRef(traceInputSignature);
  latestTraceInputSignatureRef.current = traceInputSignature;
  const vectorIsCurrent =
    Boolean(vector) && vectorSignature === traceInputSignature;

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
      return;
    }

    const timer = window.setTimeout(() => {
      const image = sourceImageRef.current;
      const rectifiedCanvas = rectifiedCanvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (!image || !rectifiedCanvas || !previewCanvas || !sizeResult.value)
        return;

      try {
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
        setSourcePixelsPerMillimeter(
          getSourcePixelsPerMillimeter(
            source.width,
            source.height,
            quad,
            sizeResult.value.width,
            sizeResult.value.height,
          ),
        );
        const processed = preprocessForTrace(corrected, {
          detailSensitivity,
          cleanup,
          edgeCleanupPercent,
          preserveCanvas: true,
        });
        putRasterOnCanvas(previewCanvas, processed);
        let blackPixels = 0;
        for (let pixel = 0; pixel < processed.data.length; pixel += 4) {
          if (processed.data[pixel] === 0) blackPixels += 1;
        }
        setInkRatio(
          blackPixels / Math.max(1, processed.width * processed.height),
        );
        setError('');
      } catch (previewError) {
        setSourcePixelsPerMillimeter(null);
        setError(
          previewError instanceof Error
            ? previewError.message
            : '照片拉正失败，请重新调整四角。',
        );
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [
    cleanup,
    detailSensitivity,
    edgeCleanupPercent,
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
    setVectorSignature('');
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
      const processed = preprocessForTrace(corrected, {
        detailSensitivity,
        cleanup,
        edgeCleanupPercent,
        preserveCanvas: true,
      });
      let formalBlackPixels = 0;
      for (let pixel = 0; pixel < processed.data.length; pixel += 4) {
        if (processed.data[pixel] === 0) formalBlackPixels += 1;
      }
      const formalInkRatio =
        formalBlackPixels / Math.max(1, processed.width * processed.height);
      if (formalInkRatio < 0.001) {
        throw new Error(
          '当前没有留下可描绘的图文，请提高“图文完整度”，或降低“去边框范围”。',
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
        pathomit: cleanup === 0 ? 0 : Math.min(2, Math.floor(cleanup / 3) + 1),
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
      const pathCharacters = paths.reduce(
        (total, path) => total + path.length,
        0,
      );
      if (paths.length === 0) {
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
        coordinateSpace: 'label',
        calibratedWidth: sizeResult.value.width,
        calibratedHeight: sizeResult.value.height,
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
              <p className="font-medium">4. 检查保留下来的图文</p>
              <p className="text-sm leading-6 text-muted-foreground">
                黑白预览保留完整皮牌画布；黑色是当前识别候选区域，不代表压印颜色，须检查皮纹、缝线和边框有没有误入。
              </p>
            </div>
            <div className="rounded-xl border border-amber-600/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900">
              <span className="font-medium">本阶段先验收位置与尺寸</span>
              <span className="block">
                照片的小字和皮纹仍可能描错；生成的是校正位置的参考曲线，不是可直接发给模具厂的纯图文文件。清晰字形与图案需要后续复核重绘。
              </span>
            </div>
            <div className="grid min-h-44 place-items-center overflow-hidden rounded-xl border bg-white p-2">
              {source ? (
                <canvas
                  ref={previewCanvasRef}
                  aria-label="自动描绘黑白预览"
                  className="max-h-56 max-w-full object-contain"
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  上传后在这里检查效果
                </p>
              )}
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
              默认12%用于排除旧皮牌边缘；如果图案本身贴近框选边缘，请适当调低。
            </p>
            {source && (
              <p className="text-sm text-muted-foreground">
                当前识别到的图文约占 {(inkRatio * 100).toFixed(1)}%
              </p>
            )}

            <Button
              type="button"
              className="h-10 w-full"
              onClick={generateVector}
              disabled={
                !source || busy || Boolean(quadError) || !sizeResult.value
              }
            >
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <WandSparkles aria-hidden="true" />
              )}
              {busy ? '正在生成曲线…' : '把图文生成矢量曲线'}
            </Button>

            {vector && vectorIsCurrent && (
              <div className="space-y-2 rounded-xl border border-emerald-600/25 bg-emerald-500/[0.06] p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-800">
                  <Check className="size-4" aria-hidden="true" />
                  曲线已生成，可以加入画布
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
