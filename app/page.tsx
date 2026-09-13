'use client';

import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  FileImage,
  Info,
  Ruler,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PhotoTraceWorkflow,
  type PhotoTraceApplyResult,
} from '@/components/photo-trace-workflow';
import {
  CheckRow,
  ColorPicker,
  DimensionInput,
  Divider,
  FontField,
  InfoCard,
  PanelHeading,
  RangeField,
  SelectField,
  SelectObjectField,
  StepNumber,
  TextField,
  VectorMarkPreview,
} from '@/components/leather-label-ui';
import {
  CATEGORIES,
  DESIGN_TEMPLATES,
  FONT_OPTIONS,
  LABEL_TYPES,
  LAYOUT_OPTIONS,
  LEATHER_COLORS,
  SHAPE_OPTIONS,
  SIZE_OPTIONS,
  STAMP_COLORS,
  getFont,
  type DesignTemplate,
} from '@/lib/label-options';
import {
  buildLeatherLabelSvg,
  buildPhotoArtworkSvg,
  formatMm,
  getLabelLayout,
  type MarkLayout,
  type MarkShape,
} from '@/lib/leather-label-svg';
import type { TracedVector } from '@/lib/photo-trace';

type UploadedAsset = {
  kind: 'bitmap' | 'svg' | 'traced-vector';
  dataUrl?: string;
  vector?: TracedVector;
  name: string;
  mime: string;
  aspectRatio: number;
};

type LabelConfiguration = {
  category?: string;
  labelType?: string;
  size?: string;
  customWidth?: number;
  customHeight?: number;
  mainText?: string;
  subText?: string;
  mainFont?: string;
  subFont?: string;
  markShape?: MarkShape;
  markLayout?: MarkLayout;
  markText?: string;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: {
          name: string;
          title?: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations?: {
            readOnlyHint?: boolean;
            untrustedContentHint?: boolean;
          };
          execute: (input: unknown) => unknown;
        },
        options?: { signal?: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}

function safeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, '-') || '未命名皮牌';
}

function validateCustomSize(widthInput: string, heightInput: string) {
  const pattern = /^\d+(?:\.\d)?$/;
  if (!widthInput.trim() || !heightInput.trim()) {
    return { error: '请输入完整的宽和高。', value: null };
  }
  if (!pattern.test(widthInput) || !pattern.test(heightInput)) {
    return { error: '宽高只允许数字，最多保留1位小数。', value: null };
  }
  const width = Number(widthInput);
  const height = Number(heightInput);
  if (width < 10 || width > 200) {
    return { error: '自定义宽度须在10–200 mm之间。', value: null };
  }
  if (height < 10 || height > 150) {
    return { error: '自定义高度须在10–150 mm之间。', value: null };
  }
  return { error: '', value: { width, height } };
}

function estimateTextWidth(text: string, fontSize: number, spacing: number) {
  const characters = Array.from(text);
  const characterWidth = characters.reduce(
    (total, character) =>
      total +
      ((character.codePointAt(0) ?? 0) > 0xff ? fontSize : fontSize * 0.62),
    0,
  );
  return characterWidth + Math.max(0, characters.length - 1) * spacing;
}

export default function Home() {
  const [sizeIndex, setSizeIndex] = useState(0);
  const [sizeMode, setSizeMode] = useState<'preset' | 'custom'>('preset');
  const [customWidthInput, setCustomWidthInput] = useState('73.5');
  const [customHeightInput, setCustomHeightInput] = useState('42.8');
  const [lastValidCustomSize, setLastValidCustomSize] = useState({
    width: 73.5,
    height: 42.8,
  });
  const [category, setCategory] = useState('男装');
  const [labelType, setLabelType] = useState('大款皮牌');
  const [fileName, setFileName] = useState('客户-原野01');
  const [mainText, setMainText] = useState('原野');
  const [subText, setSubText] = useState('YUANYE · 1998');
  const [mainFont, setMainFont] = useState('microsoft-yahei');
  const [subFont, setSubFont] = useState('georgia');
  const [fontSize, setFontSize] = useState(9);
  const [textYPercent, setTextYPercent] = useState(58);
  const [groupXPercent, setGroupXPercent] = useState(50);
  const [letterSpacing, setLetterSpacing] = useState(0.7);
  const [leatherColor, setLeatherColor] = useState('#563522');
  const [stampColor, setStampColor] = useState('#d8b66f');
  const [dashLength, setDashLength] = useState(2);
  const [dashGap, setDashGap] = useState(1.4);
  const [stitchInset, setStitchInset] = useState(0);
  const [markShape, setMarkShape] = useState<MarkShape>('diamond');
  const [markText, setMarkText] = useState('Y');
  const [markLayout, setMarkLayout] = useState<MarkLayout>('top');
  const [markSize, setMarkSize] = useState(13);
  const [markYPercent, setMarkYPercent] = useState(30);
  const [markUsesStampColor, setMarkUsesStampColor] = useState(true);
  const [markOwnColor, setMarkOwnColor] = useState('#d8b66f');
  const [asset, setAsset] = useState<UploadedAsset | null>(null);
  const [assetWidth, setAssetWidth] = useState(20);
  const [assetXPercent, setAssetXPercent] = useState(50);
  const [assetYPercent, setAssetYPercent] = useState(27);
  const [uploadError, setUploadError] = useState('');
  const [exported, setExported] = useState(false);
  const [photoArtworkReviewed, setPhotoArtworkReviewed] = useState(false);

  const customSizeResult = useMemo(
    () => validateCustomSize(customWidthInput, customHeightInput),
    [customHeightInput, customWidthInput],
  );
  const customSizeError = sizeMode === 'custom' ? customSizeResult.error : '';
  const size =
    sizeMode === 'custom'
      ? (customSizeResult.value ?? lastValidCustomSize)
      : SIZE_OPTIONS[sizeIndex];
  const scaleLabel = `${formatMm(size.width)} mm × ${formatMm(size.height)} mm`;
  const mainFontOption = getFont(mainFont);
  const subFontOption = getFont(subFont);
  const markColor = markUsesStampColor ? stampColor : markOwnColor;
  const isLabelCoordinateAsset =
    asset?.kind === 'traced-vector' &&
    asset.vector?.coordinateSpace === 'label';
  const calibratedAssetWidth = isLabelCoordinateAsset
    ? (asset.vector?.calibratedWidth ?? size.width)
    : 0;
  const calibratedAssetHeight = isLabelCoordinateAsset
    ? (asset.vector?.calibratedHeight ?? size.height)
    : 0;
  const labelCoordinateSizeMismatch =
    isLabelCoordinateAsset &&
    (Math.abs(calibratedAssetWidth - size.width) > 0.001 ||
      Math.abs(calibratedAssetHeight - size.height) > 0.001);
  const hasAdditionalDesignObjects = Boolean(
    mainText.trim() || subText.trim() || markShape !== 'none',
  );
  const purePhotoArtworkReady = Boolean(
    isLabelCoordinateAsset &&
    asset?.vector &&
    !labelCoordinateSizeMismatch &&
    !customSizeError &&
    !hasAdditionalDesignObjects &&
    photoArtworkReviewed,
  );
  const maxAssetWidth = Math.max(6, size.width - 8);
  const effectiveAssetWidth = isLabelCoordinateAsset
    ? calibratedAssetWidth
    : Math.min(assetWidth, maxAssetWidth);
  const maxMarkSize = Math.max(
    7,
    Math.min(28, size.height - 8, size.width / 3),
  );
  const effectiveMarkSize = Math.min(markSize, maxMarkSize);
  const effectiveStitchInset = Math.min(stitchInset, size.width / 4);
  const assetHeight = asset
    ? isLabelCoordinateAsset
      ? calibratedAssetHeight
      : Math.max(3, effectiveAssetWidth / Math.max(0.2, asset.aspectRatio))
    : 0;
  const effectiveAssetXPercent = assetXPercent;
  const effectiveAssetYPercent = assetYPercent;
  const effectiveAssetX = isLabelCoordinateAsset
    ? 0
    : (size.width * effectiveAssetXPercent) / 100 - effectiveAssetWidth / 2;
  const effectiveAssetY = isLabelCoordinateAsset
    ? 0
    : (size.height * effectiveAssetYPercent) / 100 - assetHeight / 2;
  const assetKind = isLabelCoordinateAsset
    ? '按成品坐标锁定的描绘曲线'
    : asset?.kind === 'traced-vector'
      ? '自动描绘矢量曲线'
      : asset?.kind === 'svg'
        ? 'SVG图案'
        : '位图';
  const layout = getLabelLayout({
    width: size.width,
    height: size.height,
    markLayout,
    groupXPercent,
    markYPercent,
    textYPercent,
    markSize: effectiveMarkSize,
  });

  const applyMarkLayout = useCallback((nextLayout: MarkLayout) => {
    setMarkLayout(nextLayout);
    if (nextLayout === 'left') {
      setMarkYPercent(48);
      setTextYPercent(45);
    } else if (nextLayout === 'top') {
      setMarkYPercent(29);
      setTextYPercent(56);
    } else {
      setMarkYPercent(31);
      setTextYPercent(58);
    }
    setGroupXPercent(50);
  }, []);

  const applyTemplate = useCallback(
    (template: DesignTemplate) => {
      setCategory(template.category);
      setMainText(template.mainText);
      setSubText(template.subText);
      setMainFont(template.mainFont);
      setSubFont(template.subFont);
      setMarkShape(template.markShape);
      setMarkText(template.markText);
      setFontSize(template.fontSize);
      applyMarkLayout(template.markLayout);
    },
    [applyMarkLayout],
  );

  const applyConfiguration = useCallback(
    (config: LabelConfiguration) => {
      if (config.category && CATEGORIES.includes(config.category))
        setCategory(config.category);
      if (config.labelType && LABEL_TYPES.includes(config.labelType))
        setLabelType(config.labelType);
      if (config.size) {
        const nextIndex = SIZE_OPTIONS.findIndex(
          (item) => `${item.width}x${item.height}` === config.size,
        );
        if (nextIndex >= 0) {
          setSizeIndex(nextIndex);
          setSizeMode('preset');
        }
      }
      if (
        typeof config.customWidth === 'number' &&
        typeof config.customHeight === 'number'
      ) {
        setCustomWidthInput(config.customWidth.toFixed(1));
        setCustomHeightInput(config.customHeight.toFixed(1));
        setLastValidCustomSize({
          width: config.customWidth,
          height: config.customHeight,
        });
        setSizeMode('custom');
      }
      if (typeof config.mainText === 'string')
        setMainText(config.mainText.slice(0, 40));
      if (typeof config.subText === 'string')
        setSubText(config.subText.slice(0, 40));
      if (
        config.mainFont &&
        FONT_OPTIONS.some((font) => font.id === config.mainFont)
      )
        setMainFont(config.mainFont);
      if (
        config.subFont &&
        FONT_OPTIONS.some((font) => font.id === config.subFont)
      )
        setSubFont(config.subFont);
      if (
        config.markShape &&
        SHAPE_OPTIONS.some((shape) => shape.value === config.markShape)
      )
        setMarkShape(config.markShape);
      if (typeof config.markText === 'string')
        setMarkText(config.markText.slice(0, 4));
      if (
        config.markLayout &&
        LAYOUT_OPTIONS.some((item) => item.value === config.markLayout)
      )
        applyMarkLayout(config.markLayout);
    },
    [applyMarkLayout],
  );

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const sizes = SIZE_OPTIONS.map((item) => `${item.width}x${item.height}`);
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'configure_leather_label',
            title: '设置皮牌设计',
            description:
              '设置皮牌分类、固定或自定义毫米尺寸、中英文字体及图形字母组合。',
            inputSchema: {
              type: 'object',
              properties: {
                category: { type: 'string', enum: CATEGORIES },
                labelType: { type: 'string', enum: LABEL_TYPES },
                size: { type: 'string', enum: sizes },
                customWidth: {
                  type: 'number',
                  minimum: 10,
                  maximum: 200,
                  multipleOf: 0.1,
                },
                customHeight: {
                  type: 'number',
                  minimum: 10,
                  maximum: 150,
                  multipleOf: 0.1,
                },
                mainText: { type: 'string', maxLength: 40 },
                subText: { type: 'string', maxLength: 40 },
                mainFont: {
                  type: 'string',
                  enum: FONT_OPTIONS.map((font) => font.id),
                },
                subFont: {
                  type: 'string',
                  enum: FONT_OPTIONS.map((font) => font.id),
                },
                markShape: {
                  type: 'string',
                  enum: SHAPE_OPTIONS.map((shape) => shape.value),
                },
                markLayout: {
                  type: 'string',
                  enum: LAYOUT_OPTIONS.map((item) => item.value),
                },
                markText: { type: 'string', maxLength: 4 },
              },
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: false },
            execute(input) {
              if (!input || typeof input !== 'object' || Array.isArray(input))
                throw new Error('皮牌设置必须是一个对象。');
              const config = input as LabelConfiguration;
              const hasWidth = typeof config.customWidth === 'number';
              const hasHeight = typeof config.customHeight === 'number';
              if (hasWidth !== hasHeight)
                throw new Error('自定义尺寸必须同时提供宽和高。');
              if (
                (hasWidth &&
                  (config.customWidth! < 10 || config.customWidth! > 200)) ||
                (hasHeight &&
                  (config.customHeight! < 10 || config.customHeight! > 150))
              ) {
                throw new Error('自定义尺寸超出允许范围。');
              }
              if (
                (hasWidth &&
                  Math.abs(
                    config.customWidth! * 10 -
                      Math.round(config.customWidth! * 10),
                  ) > 1e-8) ||
                (hasHeight &&
                  Math.abs(
                    config.customHeight! * 10 -
                      Math.round(config.customHeight! * 10),
                  ) > 1e-8)
              ) {
                throw new Error('自定义尺寸最多保留1位小数。');
              }
              applyConfiguration(config);
              return { status: 'updated', ...config };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => undefined);
    } catch {
      // WebMCP is optional; the design tool works without it.
    }
    return () => lifecycle.abort();
  }, [applyConfiguration]);

  const contentWarning = useMemo(() => {
    const tops: number[] = [];
    const bottoms: number[] = [];
    const lefts: number[] = [];
    const rights: number[] = [];
    const subFontSize = Math.max(2.5, fontSize * 0.34);
    if (mainText) {
      const mainWidth = estimateTextWidth(mainText, fontSize, letterSpacing);
      tops.push(layout.textY - fontSize * 0.62);
      bottoms.push(layout.textY + fontSize * 0.45);
      lefts.push(layout.textX - mainWidth / 2);
      rights.push(layout.textX + mainWidth / 2);
    }
    if (subText) {
      const subY = layout.textY + fontSize * 0.72;
      const subWidth = estimateTextWidth(subText, subFontSize, 0.45);
      tops.push(subY - subFontSize * 0.62);
      bottoms.push(subY + subFontSize * 0.45);
      lefts.push(layout.textX - subWidth / 2);
      rights.push(layout.textX + subWidth / 2);
    }
    if (markShape !== 'none') {
      tops.push(layout.markY - effectiveMarkSize / 2);
      bottoms.push(layout.markY + effectiveMarkSize / 2);
      lefts.push(layout.markX - effectiveMarkSize / 2);
      rights.push(layout.markX + effectiveMarkSize / 2);
    }
    if (asset && !isLabelCoordinateAsset) {
      const y = (size.height * effectiveAssetYPercent) / 100;
      const x = (size.width * effectiveAssetXPercent) / 100;
      tops.push(y - assetHeight / 2);
      bottoms.push(y + assetHeight / 2);
      lefts.push(x - effectiveAssetWidth / 2);
      rights.push(x + effectiveAssetWidth / 2);
    }
    if (tops.length === 0) return false;
    return (
      Math.min(...tops) < 4 ||
      Math.max(...bottoms) > size.height - 4 ||
      Math.min(...lefts) < 1 ||
      Math.max(...rights) > size.width - 1
    );
  }, [
    asset,
    assetHeight,
    effectiveAssetXPercent,
    effectiveAssetYPercent,
    effectiveAssetWidth,
    effectiveMarkSize,
    fontSize,
    layout.markX,
    layout.markY,
    layout.textX,
    layout.textY,
    letterSpacing,
    mainText,
    markShape,
    isLabelCoordinateAsset,
    size.height,
    size.width,
    subText,
  ]);

  const exportSvg = useMemo(
    () =>
      buildLeatherLabelSvg({
        width: size.width,
        height: size.height,
        fileName,
        category,
        labelType,
        leatherColor,
        stampColor,
        markColor,
        dashLength,
        dashGap,
        stitchInset: effectiveStitchInset,
        mainText,
        subText,
        mainFontFamily: mainFontOption.stack,
        subFontFamily: subFontOption.stack,
        fontSize,
        letterSpacing,
        markShape,
        markText,
        markLayout,
        groupXPercent,
        markYPercent,
        textYPercent,
        markSize: effectiveMarkSize,
        asset: asset
          ? {
              dataUrl: asset.dataUrl,
              vector: asset.vector,
              width: effectiveAssetWidth,
              height: assetHeight,
              xPercent: effectiveAssetXPercent,
              yPercent: effectiveAssetYPercent,
            }
          : null,
      }),
    [
      asset,
      assetHeight,
      effectiveAssetWidth,
      effectiveAssetXPercent,
      effectiveAssetYPercent,
      category,
      dashGap,
      dashLength,
      fileName,
      fontSize,
      groupXPercent,
      labelType,
      leatherColor,
      letterSpacing,
      mainFontOption.stack,
      mainText,
      markColor,
      markLayout,
      markShape,
      effectiveMarkSize,
      markText,
      markYPercent,
      size.height,
      size.width,
      stampColor,
      effectiveStitchInset,
      subFontOption.stack,
      subText,
      textYPercent,
    ],
  );

  function selectPreset(index: number) {
    setSizeIndex(index);
    setSizeMode('preset');
  }

  function updateCustomWidth(nextValue: string) {
    setCustomWidthInput(nextValue);
    const result = validateCustomSize(nextValue, customHeightInput);
    if (result.value) setLastValidCustomSize(result.value);
  }

  function updateCustomHeight(nextValue: string) {
    setCustomHeightInput(nextValue);
    const result = validateCustomSize(customWidthInput, nextValue);
    if (result.value) setLastValidCustomSize(result.value);
  }

  function handlePhotoTraceApply(result: PhotoTraceApplyResult) {
    setPhotoArtworkReviewed(false);
    const targetWidth = Number(result.targetWidth.toFixed(1));
    const targetHeight = Number(result.targetHeight.toFixed(1));
    const vectorRatio =
      result.vector.viewBoxWidth / Math.max(1, result.vector.viewBoxHeight);

    setCustomWidthInput(targetWidth.toFixed(1));
    setCustomHeightInput(targetHeight.toFixed(1));
    setLastValidCustomSize({ width: targetWidth, height: targetHeight });
    setSizeMode('custom');
    setAsset({
      kind: 'traced-vector',
      name: result.name,
      mime: 'image/svg+xml',
      aspectRatio: vectorRatio,
      vector: result.vector,
    });
    setAssetWidth(targetWidth);
    setAssetXPercent(50);
    setAssetYPercent(50);
    setFileName(result.name);
    setUploadError('');
    if (result.replaceCurrentDesign) {
      setMainText('');
      setSubText('');
      setMarkShape('none');
    }
  }

  function handleAssetUpload(event: ChangeEvent<HTMLInputElement>) {
    setPhotoArtworkReviewed(false);
    const file = event.target.files?.[0];
    setUploadError('');
    if (!file) return;
    if (!['image/svg+xml', 'image/png', 'image/jpeg'].includes(file.type)) {
      setUploadError('只支持SVG、PNG或JPG图片。');
      event.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('图片不能超过5 MB。');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const dataUrl = reader.result;
      const image = new Image();
      image.onload = () =>
        setAsset({
          kind: file.type === 'image/svg+xml' ? 'svg' : 'bitmap',
          dataUrl,
          name: file.name,
          mime: file.type,
          aspectRatio:
            image.naturalWidth > 0 && image.naturalHeight > 0
              ? image.naturalWidth / image.naturalHeight
              : 2,
        });
      image.onerror = () =>
        setAsset({
          kind: file.type === 'image/svg+xml' ? 'svg' : 'bitmap',
          dataUrl,
          name: file.name,
          mime: file.type,
          aspectRatio: 2,
        });
      image.src = dataUrl;
    };
    reader.onerror = () => setUploadError('图片读取失败，请重新选择。');
    reader.readAsDataURL(file);
  }

  function downloadSvg() {
    if (customSizeError || labelCoordinateSizeMismatch) return;
    const blob = new Blob([exportSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(fileName)}_${formatMm(size.width)}x${formatMm(size.height)}mm.svg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setExported(true);
    window.setTimeout(() => setExported(false), 3000);
  }

  function downloadPurePhotoArtwork() {
    if (!purePhotoArtworkReady || !asset?.vector) return;
    const svg = buildPhotoArtworkSvg(
      asset.vector,
      size.width,
      size.height,
      fileName,
    );
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(fileName)}_${formatMm(size.width)}x${formatMm(size.height)}mm_纯图文待复核.svg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <Header scaleLabel={scaleLabel} />
      <div className="mx-auto grid max-w-[1680px] gap-5 p-4 xl:grid-cols-[350px_minmax(0,1fr)_320px] xl:p-6">
        <aside className="control-panel rounded-2xl border bg-card p-5 shadow-sm">
          <PanelHeading number="01" title="基本设置" />
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="file-name">文件名</Label>
              <Input
                id="file-name"
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
                maxLength={60}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                id="category"
                label="服装分类"
                value={category}
                options={CATEGORIES}
                onChange={setCategory}
              />
              <SelectField
                id="label-type"
                label="皮牌类型"
                value={labelType}
                options={LABEL_TYPES}
                onChange={setLabelType}
              />
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">成品尺寸</legend>
              <div className="grid grid-cols-2 gap-2">
                {SIZE_OPTIONS.map((option, index) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => selectPreset(index)}
                    className={`size-choice ${sizeMode === 'preset' && sizeIndex === index ? 'size-choice-active' : ''}`}
                    aria-pressed={sizeMode === 'preset' && sizeIndex === index}
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSizeMode('custom')}
                  className={`size-choice col-span-2 ${sizeMode === 'custom' ? 'size-choice-active' : ''}`}
                  aria-pressed={sizeMode === 'custom'}
                >
                  自定义尺寸
                </button>
              </div>
            </fieldset>
            {sizeMode === 'custom' && (
              <div className="rounded-xl border bg-background p-3">
                <div className="grid grid-cols-2 gap-3">
                  <DimensionInput
                    id="custom-width"
                    label="宽"
                    value={customWidthInput}
                    onChange={updateCustomWidth}
                  />
                  <DimensionInput
                    id="custom-height"
                    label="高"
                    value={customHeightInput}
                    onChange={updateCustomHeight}
                  />
                </div>
                <p
                  className={`mt-2 text-sm ${customSizeError ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                  {customSizeError ||
                    `当前成品：${scaleLabel}，导出保持此实际尺寸。`}
                </p>
              </div>
            )}

            <Divider />
            <PanelHeading number="02" title="中文与组合示例" compact />
            <div className="template-grid">
              {DESIGN_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="template-card"
                  onClick={() => applyTemplate(template)}
                  title={`应用${template.name}示例，不改变当前尺寸`}
                >
                  <span
                    style={{ fontFamily: getFont(template.mainFont).stack }}
                  >
                    {template.mainText}
                  </span>
                  <small>{template.category}</small>
                </button>
              ))}
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              示例只替换文字、字体与徽标，不改变当前尺寸和上下3 mm虚线。
            </p>

            <Divider />
            <PanelHeading number="03" title="烫压文字" compact />
            <TextField
              id="main-text"
              label="主文字（中文、英文、数字）"
              value={mainText}
              onChange={setMainText}
            />
            <FontField
              id="main-font"
              label="主文字字体"
              value={mainFont}
              onChange={setMainFont}
            />
            <TextField
              id="sub-text"
              label="副文字"
              value={subText}
              onChange={setSubText}
            />
            <FontField
              id="sub-font"
              label="副文字字体"
              value={subFont}
              onChange={setSubFont}
            />
            {(mainFontOption.caution || subFontOption.caution) && (
              <div className="warning-note">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  当前含细笔画字体，小尺寸烫压前请检查细线是否适合皮料和模具。
                </span>
              </div>
            )}
            <RangeField
              id="font-size"
              label="主文字高度"
              value={fontSize}
              unit="mm"
              min={4}
              max={16}
              step={0.5}
              onChange={setFontSize}
            />
            <RangeField
              id="text-position"
              label="文字上下位置"
              value={textYPercent}
              unit="%"
              min={18}
              max={78}
              step={1}
              onChange={setTextYPercent}
            />
            <RangeField
              id="letter-spacing"
              label="主文字字距"
              value={letterSpacing}
              unit="mm"
              min={0}
              max={3}
              step={0.1}
              onChange={setLetterSpacing}
            />
            <ColorPicker
              id="leather-color"
              label="皮料颜色"
              value={leatherColor}
              colors={LEATHER_COLORS}
              onChange={setLeatherColor}
            />
            <ColorPicker
              id="stamp-color"
              label="烫压颜色"
              value={stampColor}
              colors={STAMP_COLORS}
              onChange={setStampColor}
            />
          </div>
        </aside>

        <section className="preview-shell min-h-[660px] rounded-2xl p-4 sm:p-7">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3 text-white">
            <div>
              <p className="section-kicker section-kicker-dark">04</p>
              <h2 className="text-xl font-semibold">毫米比例预览</h2>
            </div>
            <div className="flex gap-2 text-sm text-white/65">
              <span>{category}</span>
              <span aria-hidden="true">・</span>
              <span>{labelType}</span>
            </div>
          </div>
          <div className="preview-stage">
            <div className="ruler-note ruler-note-top">
              顶部虚线中心距边3 mm
            </div>
            <div
              className="label-frame"
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
            >
              <svg
                aria-label={`${scaleLabel}皮牌预览`}
                className="h-full w-full"
                viewBox={`0 0 ${size.width} ${size.height}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <title>{`${scaleLabel}皮牌预览`}</title>
                <rect
                  x="0"
                  y="0"
                  width={size.width}
                  height={size.height}
                  fill={leatherColor}
                />
                <line
                  x1={effectiveStitchInset}
                  x2={size.width - effectiveStitchInset}
                  y1="3"
                  y2="3"
                  stroke="#000000"
                  strokeWidth="0.45"
                  strokeDasharray={`${dashLength} ${dashGap}`}
                />
                <line
                  x1={effectiveStitchInset}
                  x2={size.width - effectiveStitchInset}
                  y1={size.height - 3}
                  y2={size.height - 3}
                  stroke="#000000"
                  strokeWidth="0.45"
                  strokeDasharray={`${dashLength} ${dashGap}`}
                />
                {asset?.kind === 'traced-vector' && asset.vector && (
                  <svg
                    x={effectiveAssetX}
                    y={effectiveAssetY}
                    width={effectiveAssetWidth}
                    height={assetHeight}
                    viewBox={`0 0 ${asset.vector.viewBoxWidth} ${asset.vector.viewBoxHeight}`}
                    preserveAspectRatio={
                      isLabelCoordinateAsset ? 'none' : 'xMidYMid meet'
                    }
                    overflow="visible"
                  >
                    <g fill={stampColor} fillRule="evenodd" stroke="none">
                      {asset.vector.paths.map((path, index) => (
                        <path key={`${path.slice(0, 24)}-${index}`} d={path} />
                      ))}
                      {asset.vector.overlays?.map((overlay, overlayIndex) => (
                        <g
                          key={`confirmed-text-${overlayIndex}`}
                          transform={`translate(${overlay.x} ${overlay.y}) scale(${overlay.scaleX} ${overlay.scaleY})`}
                        >
                          {overlay.paths.map((path, pathIndex) => (
                            <path key={pathIndex} d={path} />
                          ))}
                        </g>
                      ))}
                    </g>
                  </svg>
                )}
                {asset?.kind !== 'traced-vector' && asset?.dataUrl && (
                  <image
                    href={asset.dataUrl}
                    x={effectiveAssetX}
                    y={effectiveAssetY}
                    width={effectiveAssetWidth}
                    height={assetHeight}
                    preserveAspectRatio="xMidYMid meet"
                  />
                )}
                {markShape !== 'none' && (
                  <VectorMarkPreview
                    x={layout.markX}
                    y={layout.markY}
                    size={effectiveMarkSize}
                    shape={markShape}
                    text={markText}
                    color={markColor}
                    fontFamily={mainFontOption.stack}
                  />
                )}
                {mainText && (
                  <text
                    x={layout.textX}
                    y={layout.textY}
                    fill={stampColor}
                    fontFamily={mainFontOption.stack}
                    fontSize={fontSize}
                    fontWeight="700"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    letterSpacing={letterSpacing}
                  >
                    {mainText}
                  </text>
                )}
                {subText && (
                  <text
                    x={layout.textX}
                    y={layout.textY + fontSize * 0.72}
                    fill={stampColor}
                    fontFamily={subFontOption.stack}
                    fontSize={Math.max(2.5, fontSize * 0.34)}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    letterSpacing="0.45"
                  >
                    {subText}
                  </text>
                )}
              </svg>
            </div>
            <div className="dimension-line dimension-width">
              <span>{formatMm(size.width)} mm</span>
            </div>
            <div className="dimension-line dimension-height">
              <span>{formatMm(size.height)} mm</span>
            </div>
            <div className="ruler-note ruler-note-bottom">
              底部虚线中心距边3 mm
            </div>
          </div>
          {contentWarning && (
            <div className="preview-warning">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              图文已接近缝线或成品边缘，请调整大小、字距或位置后再制版。
            </div>
          )}
          {labelCoordinateSizeMismatch && (
            <div className="preview-warning">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              当前成品尺寸与照片校正时的 {formatMm(calibratedAssetWidth)} ×{' '}
              {formatMm(calibratedAssetHeight)} mm
              不一致。为避免图文被拉伸，请改回原尺寸或重新进行照片描绘。
            </div>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <InfoCard label="成品尺寸" value={scaleLabel} />
            <InfoCard label="缝线" value="上下各1条黑色虚线" />
            <InfoCard
              label="图文组合"
              value={
                markShape === 'none'
                  ? '纯文字排版'
                  : `${SHAPE_OPTIONS.find((item) => item.value === markShape)?.label}＋${markText || '字母'}`
              }
            />
          </div>
        </section>

        <aside className="control-panel rounded-2xl border bg-card p-5 shadow-sm xl:max-h-[calc(100vh-112px)] xl:overflow-y-auto">
          <PanelHeading number="05" title="图形＋字母" />
          <div className="space-y-5">
            <div className="space-y-2">
              <Label>组合排版</Label>
              <div className="grid grid-cols-3 gap-2">
                {LAYOUT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`mode-choice ${markLayout === option.value ? 'mode-choice-active' : ''}`}
                    onClick={() => applyMarkLayout(option.value)}
                    aria-pressed={markLayout === option.value}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <SelectObjectField
                id="mark-shape"
                label="内置矢量图形"
                value={markShape}
                options={SHAPE_OPTIONS}
                onChange={(value) => setMarkShape(value as MarkShape)}
              />
              <div className="space-y-2">
                <Label htmlFor="mark-text">图形内字母</Label>
                <Input
                  id="mark-text"
                  value={markText}
                  maxLength={4}
                  placeholder="如 YJ"
                  onChange={(event) => setMarkText(event.target.value)}
                  disabled={markShape === 'none'}
                />
              </div>
            </div>
            {markShape !== 'none' && (
              <>
                <RangeField
                  id="mark-size"
                  label="图形整体大小"
                  value={effectiveMarkSize}
                  unit="mm"
                  min={7}
                  max={maxMarkSize}
                  step={0.5}
                  onChange={setMarkSize}
                />
                <RangeField
                  id="mark-position"
                  label="图形上下位置"
                  value={markYPercent}
                  unit="%"
                  min={12}
                  max={76}
                  step={1}
                  onChange={setMarkYPercent}
                />
                <RangeField
                  id="group-position"
                  label="组合左右位置"
                  value={groupXPercent}
                  unit="%"
                  min={22}
                  max={78}
                  step={1}
                  onChange={setGroupXPercent}
                />
                <label className="flex cursor-pointer items-start gap-2 text-sm leading-5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--primary)]"
                    checked={markUsesStampColor}
                    onChange={(event) =>
                      setMarkUsesStampColor(event.target.checked)
                    }
                  />
                  <span>图形与字母跟随烫压颜色</span>
                </label>
                {!markUsesStampColor && (
                  <ColorPicker
                    id="mark-color"
                    label="图形字母颜色"
                    value={markOwnColor}
                    colors={STAMP_COLORS}
                    onChange={setMarkOwnColor}
                  />
                )}
              </>
            )}
            <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-3 text-sm leading-5 text-muted-foreground">
              圆形、盾牌、菱形等均由矢量线条组成；与字母一起导出，生成CDR时字母会自动转曲。
            </div>

            <Divider />
            <PanelHeading number="06" title="照片复刻" compact />
            <div className="space-y-3 rounded-xl border border-primary/25 bg-primary/[0.055] p-4">
              <div>
                <p className="font-medium">客户只提供照片时</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  上传整张照片，选四角拉正其中一块皮牌，输入成品毫米尺寸；生成曲线时会保留图文原来的边距和位置。
                </p>
              </div>
              <PhotoTraceWorkflow
                currentWidth={size.width}
                currentHeight={size.height}
                onApply={handlePhotoTraceApply}
              />
            </div>

            <Divider />
            <PanelHeading number="07" title="已有客户图案" compact />
            <div className="space-y-2">
              <Label htmlFor="asset-upload">客户Logo或图案</Label>
              <label className="upload-zone" htmlFor="asset-upload">
                <Upload className="size-5 text-primary" aria-hidden="true" />
                <span>选择SVG、PNG或JPG</span>
                <span className="text-sm text-muted-foreground">最大5 MB</span>
              </label>
              <Input
                id="asset-upload"
                type="file"
                accept=".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg"
                className="sr-only"
                onChange={handleAssetUpload}
              />
              {uploadError && (
                <p className="text-sm text-destructive">{uploadError}</p>
              )}
            </div>
            {asset && (
              <>
                <div className="rounded-xl border bg-background p-3">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <FileImage className="size-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {asset.name}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {assetKind}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="删除客户图案"
                      onClick={() => setAsset(null)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {isLabelCoordinateAsset ? (
                  <div
                    className={`rounded-xl border p-3 text-sm leading-6 ${labelCoordinateSizeMismatch ? 'border-amber-600/25 bg-amber-500/10 text-amber-900' : 'border-emerald-600/25 bg-emerald-500/[0.07] text-emerald-900'}`}
                  >
                    <span className="font-medium">
                      已锁定为 {formatMm(calibratedAssetWidth)} ×{' '}
                      {formatMm(calibratedAssetHeight)} mm 成品坐标
                    </span>
                    <span className="block">
                      {labelCoordinateSizeMismatch
                        ? '当前成品尺寸已经改变，已暂停导出，防止旧图文被拉伸。请改回原尺寸或重新描绘。'
                        : '图文会保持四角校正后的原始边距和位置，不再自动居中、缩放或铺满画布。'}
                    </span>
                  </div>
                ) : (
                  <>
                    <RangeField
                      id="asset-width"
                      label="客户图案宽度"
                      value={effectiveAssetWidth}
                      unit="mm"
                      min={6}
                      max={maxAssetWidth}
                      step={0.5}
                      onChange={setAssetWidth}
                    />
                    <RangeField
                      id="asset-x-position"
                      label="客户图案左右位置"
                      value={assetXPercent}
                      unit="%"
                      min={12}
                      max={88}
                      step={1}
                      onChange={setAssetXPercent}
                    />
                    <RangeField
                      id="asset-y-position"
                      label="客户图案上下位置"
                      value={assetYPercent}
                      unit="%"
                      min={12}
                      max={80}
                      step={1}
                      onChange={setAssetYPercent}
                    />
                  </>
                )}
              </>
            )}

            <Divider />
            <PanelHeading number="08" title="黑色虚线" compact />
            <RangeField
              id="dash-length"
              label="虚线每段长度"
              value={dashLength}
              unit="mm"
              min={0.5}
              max={5}
              step={0.1}
              onChange={setDashLength}
            />
            <RangeField
              id="dash-gap"
              label="虚线段间距"
              value={dashGap}
              unit="mm"
              min={0.5}
              max={5}
              step={0.1}
              onChange={setDashGap}
            />
            <RangeField
              id="stitch-inset"
              label="虚线左右缩进"
              value={effectiveStitchInset}
              unit="mm"
              min={0}
              max={Math.min(10, size.width / 4)}
              step={0.5}
              onChange={setStitchInset}
            />

            <Divider />
            <PanelHeading number="09" title="保存CDR" compact />
            <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-4">
              <div className="flex gap-3">
                <Info
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <p className="text-sm leading-6 text-muted-foreground">
                  字体由当前电脑读取。请在安装了所选字体的同一台电脑运行CDR助手；助手导入SVG后立即把文字转曲，生成的CDR便不再依赖字体文件。
                </p>
              </div>
            </div>
            <Button
              type="button"
              size="lg"
              className="h-11 w-full"
              onClick={downloadSvg}
              disabled={Boolean(
                customSizeError ||
                contentWarning ||
                labelCoordinateSizeMismatch,
              )}
            >
              {exported ? (
                <Check aria-hidden="true" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {exported
                ? '矢量稿已下载'
                : isLabelCoordinateAsset
                  ? '下载完整皮牌示意稿（含皮色/缝线）'
                  : '下载CorelDRAW矢量稿'}
            </Button>
            {isLabelCoordinateAsset && asset?.vector && (
              <div className="space-y-3 rounded-xl border border-amber-600/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900">
                <p className="font-medium">单独保存纯图文曲线</p>
                <p>
                  此文件结构上仅有曲线路径，保留成品毫米画布，不额外加入皮色、照片或示意缝线；但自动描绘可能误取旧缝线、皮纹，模糊字也可能出错。须逐处核对，不能仅凭曲线生成就发给模具厂。
                </p>
                {(asset.vector.sourcePixelsPerMillimeter ?? 0) < 8 && (
                  <p>
                    当前照片约{' '}
                    {(asset.vector.sourcePixelsPerMillimeter ?? 0).toFixed(1)}{' '}
                    像素/mm；小字可能缺笔、粘连或误认。已手动重绘{' '}
                    {asset.vector.manualTextCount ?? 0} 处文字。
                  </p>
                )}
                {hasAdditionalDesignObjects && (
                  <p>
                    画布上还有单独输入的文字或徽标，纯图文下载不会包含它们。请先清空这些额外对象，或只下载完整示意稿。
                  </p>
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-[var(--primary)]"
                    checked={photoArtworkReviewed}
                    onChange={(event) =>
                      setPhotoArtworkReviewed(event.target.checked)
                    }
                  />
                  <span>
                    我已对照客户资料逐字、逐线核对全部保留内容，确认没有皮纹、旧缝线或错误字形混入；仍会在CDR里检查后再制模。
                  </span>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={downloadPurePhotoArtwork}
                  disabled={!purePhotoArtworkReady}
                >
                  <Download aria-hidden="true" />
                  下载纯图文曲线（待CDR复核）
                </Button>
              </div>
            )}
            <a className="cdr-helper-link" href="/ArtworkToCDR.vbs" download>
              下载新版CDR保存助手
            </a>
            {isLabelCoordinateAsset && (
              <p className="text-xs leading-5 text-muted-foreground">
                纯图文文件请用上面的新版助手；以前下载的旧助手会按图案外接框重设页面，不适用于纯图文稿。新版助手若无法核对页面毫米尺寸，会停止保存而不生成错误CDR。
              </p>
            )}
            <ol className="space-y-2 text-sm leading-6 text-muted-foreground">
              <li>
                <StepNumber>1</StepNumber>下载矢量稿和保存助手。
              </li>
              <li>
                <StepNumber>2</StepNumber>把SVG文件拖到助手文件上。
              </li>
              <li>
                <StepNumber>3</StepNumber>同一文件夹自动生成真实CDR。
              </li>
            </ol>
            <div className="space-y-2 border-t pt-4">
              <CheckRow text={`${scaleLabel}成品尺寸`} />
              <CheckRow text="上下虚线中心距边均为3 mm" />
              <CheckRow text="内置图形为矢量，文字生成CDR时转曲" />
              <CheckRow text="未生成生产工艺单" />
              <CheckRow
                text={
                  asset?.kind === 'traced-vector'
                    ? '客户照片未嵌入；自动描绘结果为矢量曲线'
                    : asset?.kind === 'bitmap'
                      ? '位图已嵌入；若只作描图参考，请在最终CDR删除'
                      : '产出以矢量内容为主'
                }
              />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Header({ scaleLabel }: { scaleLabel: string }) {
  return (
    <header className="border-b border-white/10 bg-[#171716] px-5 py-4 text-white lg:px-8">
      <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-[#c6864a] text-[#171716]">
            <Scissors className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">皮牌设计台</h1>
            <p className="text-sm text-white/55">
              中文・图形字母・毫米级矢量稿
            </p>
          </div>
        </div>
        <div className="hidden items-center gap-2 text-sm text-white/55 sm:flex">
          <Ruler className="size-4" aria-hidden="true" />
          <span>{scaleLabel}</span>
        </div>
      </div>
    </header>
  );
}
