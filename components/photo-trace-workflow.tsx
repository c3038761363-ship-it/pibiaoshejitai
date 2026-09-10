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
  type NormalizedCrop,
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
  mode: 'draw' | 'move' | 'resize';
  corner?: 'nw' | 'ne' | 'sw' | 'se';
  startX: number;
  startY: number;
  startCrop: NormalizedCrop;
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

function pointInCrop(x: number, y: number, crop: NormalizedCrop) {
  return (
    x >= crop.x &&
    x <= crop.x + crop.width &&
    y >= crop.y &&
    y <= crop.y + crop.height
  );
}

function nearestCorner(x: number, y: number, crop: NormalizedCrop) {
  const corners = [
    { key: 'nw' as const, x: crop.x, y: crop.y },
    { key: 'ne' as const, x: crop.x + crop.width, y: crop.y },
    { key: 'sw' as const, x: crop.x, y: crop.y + crop.height },
    {
      key: 'se' as const,
      x: crop.x + crop.width,
      y: crop.y + crop.height,
    },
  ];
  return corners.find(
    (corner) => Math.abs(corner.x - x) < 0.055 && Math.abs(corner.y - y) < 0.07,
  )?.key;
}

function resizeCrop(
  operation: DragOperation,
  pointerX: number,
  pointerY: number,
) {
  const minimum = 0.04;
  const left = operation.startCrop.x;
  const top = operation.startCrop.y;
  const right = left + operation.startCrop.width;
  const bottom = top + operation.startCrop.height;
  let nextLeft = left;
  let nextTop = top;
  let nextRight = right;
  let nextBottom = bottom;

  if (operation.corner?.includes('w')) {
    nextLeft = clamp(pointerX, 0, right - minimum);
  }
  if (operation.corner?.includes('e')) {
    nextRight = clamp(pointerX, left + minimum, 1);
  }
  if (operation.corner?.includes('n')) {
    nextTop = clamp(pointerY, 0, bottom - minimum);
  }
  if (operation.corner?.includes('s')) {
    nextBottom = clamp(pointerY, top + minimum, 1);
  }

  return {
    x: nextLeft,
    y: nextTop,
    width: nextRight - nextLeft,
    height: nextBottom - nextTop,
  };
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
  const [crop, setCrop] = useState<NormalizedCrop>({
    x: 0.05,
    y: 0.05,
    width: 0.9,
    height: 0.9,
  });
  const [threshold, setThreshold] = useState(116);
  const [cleanup, setCleanup] = useState(4);
  const [edgeCleanupPercent, setEdgeCleanupPercent] = useState(12);
  const [invert, setInvert] = useState(false);
  const [targetWidthInput, setTargetWidthInput] = useState(
    formatInputMillimeters(currentWidth),
  );
  const [targetHeightInput, setTargetHeightInput] = useState(
    formatInputMillimeters(currentHeight),
  );
  const [replaceCurrentDesign, setReplaceCurrentDesign] = useState(true);
  const [vector, setVector] = useState<TracedVector | null>(null);
  const [inkRatio, setInkRatio] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const cropSurfaceRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const processedRef = useRef<RasterData | null>(null);
  const dragRef = useRef<DragOperation | null>(null);
  const sizeResult = validateTargetSize(targetWidthInput, targetHeightInput);

  useEffect(() => {
    return () => {
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open || !source || !sourceImageRef.current) {
      processedRef.current = null;
      return;
    }

    const timer = window.setTimeout(() => {
      const image = sourceImageRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (!image || !previewCanvas) return;

      const sourceX = Math.round(crop.x * source.width);
      const sourceY = Math.round(crop.y * source.height);
      const sourceWidth = Math.max(1, Math.round(crop.width * source.width));
      const sourceHeight = Math.max(1, Math.round(crop.height * source.height));
      const outputScale = Math.min(
        1,
        900 / Math.max(sourceWidth, sourceHeight),
      );
      const outputWidth = Math.max(2, Math.round(sourceWidth * outputScale));
      const outputHeight = Math.max(2, Math.round(sourceHeight * outputScale));
      const workingCanvas = document.createElement('canvas');
      workingCanvas.width = outputWidth;
      workingCanvas.height = outputHeight;
      const context = workingCanvas.getContext('2d', {
        willReadFrequently: true,
      });
      if (!context) {
        setError('浏览器无法读取图片画布，请换用Chrome或Edge重试。');
        return;
      }
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        outputWidth,
        outputHeight,
      );
      const raw = context.getImageData(0, 0, outputWidth, outputHeight);
      const processed = preprocessForTrace(raw, {
        threshold,
        cleanup,
        edgeCleanupPercent,
        invert,
      });
      processedRef.current = processed;
      previewCanvas.width = processed.width;
      previewCanvas.height = processed.height;
      const previewContext = previewCanvas.getContext('2d');
      if (previewContext) {
        const previewImage = previewContext.createImageData(
          processed.width,
          processed.height,
        );
        previewImage.data.set(processed.data);
        previewContext.putImageData(previewImage, 0, 0);
      }
      let blackPixels = 0;
      for (let pixel = 0; pixel < processed.data.length; pixel += 4) {
        if (processed.data[pixel] === 0) blackPixels += 1;
      }
      setInkRatio(
        blackPixels / Math.max(1, processed.width * processed.height),
      );
      setVector(null);
      setError('');
    }, 120);

    return () => window.clearTimeout(timer);
  }, [cleanup, crop, edgeCleanupPercent, invert, open, source, threshold]);

  function handlePhotoUpload(event: ChangeEvent<HTMLInputElement>) {
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
    image.onload = () => {
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
      setCrop({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 });
      setVector(null);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError('照片读取失败，请重新选择。');
    };
    image.src = url;
    event.target.value = '';
  }

  function eventPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = cropSurfaceRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
  }

  function handleCropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const point = eventPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const corner = nearestCorner(point.x, point.y, crop);
    dragRef.current = {
      mode: corner
        ? 'resize'
        : pointInCrop(point.x, point.y, crop)
          ? 'move'
          : 'draw',
      corner,
      startX: point.x,
      startY: point.y,
      startCrop: crop,
    };
    if (!corner && !pointInCrop(point.x, point.y, crop)) {
      setCrop({
        x: clamp(point.x, 0, 0.96),
        y: clamp(point.y, 0, 0.96),
        width: 0.04,
        height: 0.04,
      });
    }
  }

  function handleCropPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const operation = dragRef.current;
    const point = eventPoint(event);
    if (!operation || !point) return;

    if (operation.mode === 'resize') {
      setCrop(resizeCrop(operation, point.x, point.y));
      return;
    }

    if (operation.mode === 'move') {
      const deltaX = point.x - operation.startX;
      const deltaY = point.y - operation.startY;
      setCrop({
        ...operation.startCrop,
        x: clamp(
          operation.startCrop.x + deltaX,
          0,
          1 - operation.startCrop.width,
        ),
        y: clamp(
          operation.startCrop.y + deltaY,
          0,
          1 - operation.startCrop.height,
        ),
      });
      return;
    }

    const nextLeft = Math.min(operation.startX, point.x);
    const nextTop = Math.min(operation.startY, point.y);
    const nextWidth = Math.max(0.04, Math.abs(point.x - operation.startX));
    const nextHeight = Math.max(0.04, Math.abs(point.y - operation.startY));
    setCrop({
      x: Math.min(nextLeft, 1 - nextWidth),
      y: Math.min(nextTop, 1 - nextHeight),
      width: nextWidth,
      height: nextHeight,
    });
  }

  function finishCropPointer(event: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function generateVector() {
    const processed = processedRef.current;
    if (!processed) {
      setError('请先上传照片并框选要复刻的范围。');
      return;
    }
    if (inkRatio < 0.001) {
      setError(
        '当前没有留下可描绘的图文，请提高识别深浅，或降低“去边框范围”。',
      );
      return;
    }
    if (inkRatio > 0.88) {
      setError('当前黑色区域过多，请降低识别深浅或重新框选。');
      return;
    }

    setBusy(true);
    setError('');
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );

    try {
      const { default: imageTracer } = await import('imagetracerjs');
      const tracedSvg = imageTracer.imagedataToSVG(processed, {
        pal: [
          { r: 0, g: 0, b: 0, a: 255 },
          { r: 255, g: 255, b: 255, a: 255 },
        ],
        colorsampling: 0,
        colorquantcycles: 1,
        pathomit: Math.max(0, cleanup),
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
        throw new Error('没有生成可用曲线，请调整识别深浅后重试。');
      }
      if (pathCharacters > 2_500_000) {
        throw new Error('曲线过于复杂，请提高去杂点后重新描绘。');
      }
      setVector({
        viewBoxWidth: processed.width,
        viewBoxHeight: processed.height,
        paths,
      });
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
    if (!source || !vector || !sizeResult.value) return;
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
            高质量剪贴画模式：自动去掉皮牌、旧边框、原缝线和皮纹，只把字母、文字与图案生成矢量曲线。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 px-5 pb-2 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,.85fr)]">
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">1. 上传并框选</p>
                <p className="text-sm text-muted-foreground">
                  框外会变暗；拖框可移动，拖四角可调整，空白处可重画。
                </p>
              </div>
              <label
                htmlFor="trace-photo-upload"
                className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium transition-colors hover:bg-muted"
              >
                <span className="sr-only">选择客户照片</span>
                <Upload className="size-4" aria-hidden="true" />
                {source ? '更换照片' : '选择照片'}
              </label>
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
                  ref={cropSurfaceRef}
                  className="relative mx-auto touch-none overflow-hidden rounded-xl select-none"
                  style={{
                    aspectRatio: `${source.width} / ${source.height}`,
                    width:
                      source.width >= source.height
                        ? '100%'
                        : `${Math.min(100, (source.width / source.height) * 74)}%`,
                  }}
                  onPointerDown={handleCropPointerDown}
                  onPointerMove={handleCropPointerMove}
                  onPointerUp={finishCropPointer}
                  onPointerCancel={finishCropPointer}
                >
                  {/* Blob URLs need a pixel-exact element for crop coordinates. */}
                  {/* oxlint-disable-next-line next/no-img-element */}
                  <img
                    src={source.url}
                    alt="客户照片裁剪区域"
                    className="pointer-events-none absolute inset-0 size-full"
                    draggable={false}
                  />
                  <div
                    className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,.58)]"
                    style={{
                      left: `${crop.x * 100}%`,
                      top: `${crop.y * 100}%`,
                      width: `${crop.width * 100}%`,
                      height: `${crop.height * 100}%`,
                    }}
                  >
                    {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                      <span
                        key={corner}
                        className={`absolute size-4 rounded-full border-2 border-[#171716] bg-white shadow ${corner.includes('n') ? '-top-2' : '-bottom-2'} ${corner.includes('w') ? '-left-2' : '-right-2'}`}
                      />
                    ))}
                  </div>
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
              每次框选一块皮牌即可，不必只框得很紧。旧皮牌边框和原照片缝线会被自动排除；设计台会重新生成规定的上下3
              mm黑色虚线。
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <p className="font-medium">2. 检查保留下来的图文</p>
              <p className="text-sm text-muted-foreground">
                预览已自动裁掉空白；只有黑色字母、文字、线条和图形会制成曲线。
              </p>
            </div>
            <div className="rounded-xl border border-emerald-600/25 bg-emerald-500/[0.07] p-3 text-sm leading-6 text-emerald-900">
              <span className="font-medium">
                高质量剪贴画（只保留图文）已开启
              </span>
              <span className="block">
                主要位于外侧清理区的旧边框、缝线和杂点会整块删除，不会按“长线”误删中间的箭头或交叉线。
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
              id="trace-threshold"
              label="识别深浅"
              value={threshold}
              unit=""
              min={78}
              max={168}
              step={1}
              onChange={setThreshold}
            />
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
              默认12%适合整块皮牌；如果要保留的图案本身贴近框选边缘，请适当调低。
            </p>
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border bg-background px-3 py-2.5 text-sm">
              <span>
                <span className="block font-medium">反相识别</span>
                <span className="text-muted-foreground">
                  浅色烫印变黑时使用
                </span>
              </span>
              <input
                type="checkbox"
                aria-label="反相识别"
                className="size-4 accent-[var(--primary)]"
                checked={invert}
                onChange={(event) => setInvert(event.target.checked)}
              />
            </label>
            {source && (
              <p className="text-sm text-muted-foreground">
                当前黑色约占 {(inkRatio * 100).toFixed(1)}%
              </p>
            )}

            <Button
              type="button"
              className="h-10 w-full"
              onClick={generateVector}
              disabled={!source || busy}
            >
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <WandSparkles aria-hidden="true" />
              )}
              {busy ? '正在生成曲线…' : '高质量描绘为矢量曲线'}
            </Button>

            {vector && (
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
                    <g fill="#111111" fillRule="evenodd" stroke="none">
                      {vector.paths.map((path, index) => (
                        <path key={`${path.slice(0, 24)}-${index}`} d={path} />
                      ))}
                    </g>
                  </svg>
                </div>
              </div>
            )}

            <div className="border-t pt-4">
              <p className="font-medium">3. 输入复刻后的皮牌成品尺寸</p>
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
              {sizeResult.error && (
                <p className="mt-2 text-sm text-destructive">
                  {sizeResult.error}
                </p>
              )}
            </div>

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
              照片和皮牌纹理只在当前浏览器中用于识别，不会进入导出的SVG/CDR。照片中的文字会成为曲线轮廓，不能再按字体编辑。
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
            disabled={!vector || !sizeResult.value || busy}
          >
            <Check aria-hidden="true" />
            按输入尺寸加入画布
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
