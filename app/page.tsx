'use client';

import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
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
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Slider } from '@/components/ui/slider';

type SizeOption = {
  label: string;
  width: number;
  height: number;
};

type UploadedAsset = {
  dataUrl: string;
  name: string;
  mime: string;
};

type LabelConfiguration = {
  category?: string;
  labelType?: string;
  size?: string;
  mainText?: string;
  subText?: string;
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

const SIZE_OPTIONS: SizeOption[] = [
  { label: '80 × 50 mm', width: 80, height: 50 },
  { label: '80 × 55 mm', width: 80, height: 55 },
  { label: '60 × 50 mm', width: 60, height: 50 },
  { label: '80 × 60 mm', width: 80, height: 60 },
];

const CATEGORIES = ['商务装', '女装', '男装', '童装'];
const LABEL_TYPES = ['大款皮牌', '小款皮牌', '后袋饰品皮牌'];

const LEATHER_COLORS = [
  { name: '黑色', value: '#20201f' },
  { name: '深棕', value: '#563522' },
  { name: '驼色', value: '#a16f43' },
  { name: '浅棕', value: '#c49262' },
];

const STAMP_COLORS = [
  { name: '黑色', value: '#111111' },
  { name: '金色', value: '#d8b66f' },
  { name: '银色', value: '#d8dadd' },
  { name: '白色', value: '#f4f1e9' },
];

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function safeFileName(value: string) {
  const cleaned = value.trim().replace(/[\\/:*?"<>|]+/g, '-');
  return cleaned || '未命名皮牌';
}

export default function Home() {
  const [sizeIndex, setSizeIndex] = useState(0);
  const [category, setCategory] = useState('男装');
  const [labelType, setLabelType] = useState('大款皮牌');
  const [fileName, setFileName] = useState('客户-款式01');
  const [mainText, setMainText] = useState('NORTHBOUND');
  const [subText, setSubText] = useState('EST. 1998');
  const [fontSize, setFontSize] = useState(9);
  const [textYPercent, setTextYPercent] = useState(52);
  const [letterSpacing, setLetterSpacing] = useState(0.7);
  const [leatherColor, setLeatherColor] = useState('#563522');
  const [stampColor, setStampColor] = useState('#d8b66f');
  const [dashLength, setDashLength] = useState(2);
  const [dashGap, setDashGap] = useState(1.4);
  const [stitchInset, setStitchInset] = useState(0);
  const [asset, setAsset] = useState<UploadedAsset | null>(null);
  const [assetWidth, setAssetWidth] = useState(20);
  const [assetYPercent, setAssetYPercent] = useState(27);
  const [uploadError, setUploadError] = useState('');
  const [exported, setExported] = useState(false);

  const size = SIZE_OPTIONS[sizeIndex];
  const scaleLabel = `${size.width} mm × ${size.height} mm`;
  const textY = (size.height * textYPercent) / 100;
  const assetY = (size.height * assetYPercent) / 100;
  const assetHeight = Math.max(4, assetWidth * 0.48);
  const assetKind = asset?.mime === 'image/svg+xml' ? '矢量SVG' : '位图';

  const applyConfiguration = useCallback((config: LabelConfiguration) => {
    if (config.category && CATEGORIES.includes(config.category)) {
      setCategory(config.category);
    }
    if (config.labelType && LABEL_TYPES.includes(config.labelType)) {
      setLabelType(config.labelType);
    }
    if (config.size) {
      const nextIndex = SIZE_OPTIONS.findIndex(
        (item) => `${item.width}x${item.height}` === config.size,
      );
      if (nextIndex >= 0) setSizeIndex(nextIndex);
    }
    if (typeof config.mainText === 'string') {
      setMainText(config.mainText.slice(0, 40));
    }
    if (typeof config.subText === 'string') {
      setSubText(config.subText.slice(0, 40));
    }
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const categories = [...CATEGORIES];
    const labelTypes = [...LABEL_TYPES];
    const sizes = SIZE_OPTIONS.map((item) => `${item.width}x${item.height}`);

    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'configure_leather_label',
            title: '设置皮牌设计',
            description:
              '按服装分类、皮牌类型、毫米尺寸和客户文字更新当前皮牌预览。',
            inputSchema: {
              type: 'object',
              properties: {
                category: { type: 'string', enum: categories },
                labelType: { type: 'string', enum: labelTypes },
                size: { type: 'string', enum: sizes },
                mainText: { type: 'string', maxLength: 40 },
                subText: { type: 'string', maxLength: 40 },
              },
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              untrustedContentHint: false,
            },
            execute(input) {
              if (!input || typeof input !== 'object' || Array.isArray(input)) {
                throw new Error('皮牌设置必须是一个对象。');
              }
              const config = input as LabelConfiguration;
              if (config.category && !categories.includes(config.category)) {
                throw new Error('不支持该服装分类。');
              }
              if (config.labelType && !labelTypes.includes(config.labelType)) {
                throw new Error('不支持该皮牌类型。');
              }
              if (config.size && !sizes.includes(config.size)) {
                throw new Error('不支持该成品尺寸。');
              }
              applyConfiguration(config);
              return {
                status: 'updated',
                category: config.category,
                labelType: config.labelType,
                size: config.size,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => undefined);
    } catch {
      // WebMCP is optional and unsupported browsers continue normally.
    }

    return () => lifecycle.abort();
  }, [applyConfiguration]);

  useEffect(() => {
    setStitchInset((current) => Math.min(current, size.width / 4));
    setAssetWidth((current) => Math.min(current, size.width - 8));
  }, [size.height, size.width]);

  const exportSvg = useMemo(() => {
    const assetMarkup = asset
      ? `<g id="客户图案"><image href="${escapeXml(asset.dataUrl)}" x="${(
          size.width / 2 -
          assetWidth / 2
        ).toFixed(3)}" y="${(assetY - assetHeight / 2).toFixed(3)}" width="${assetWidth.toFixed(
          3,
        )}" height="${assetHeight.toFixed(3)}" preserveAspectRatio="xMidYMid meet" /></g>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.width}mm" height="${size.height}mm" viewBox="0 0 ${size.width} ${size.height}">
  <title>${escapeXml(fileName)} — ${size.width}×${size.height}mm</title>
  <desc>${escapeXml(category)} / ${escapeXml(labelType)}。上下黑色虚线的中心线均距成品边3mm。</desc>
  <g id="成品外框">
    <rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${leatherColor}" />
  </g>
  <g id="缝线" fill="none" stroke="#000000" stroke-width="0.45" stroke-dasharray="${dashLength} ${dashGap}">
    <line x1="${stitchInset}" y1="3" x2="${size.width - stitchInset}" y2="3" />
    <line x1="${stitchInset}" y1="${size.height - 3}" x2="${size.width - stitchInset}" y2="${size.height - 3}" />
  </g>
  ${assetMarkup}
  <g id="烫压文字" fill="${stampColor}" text-anchor="middle" font-family="Arial, sans-serif">
    <text x="${size.width / 2}" y="${textY.toFixed(3)}" font-size="${fontSize}" font-weight="700" letter-spacing="${letterSpacing}" dominant-baseline="middle">${escapeXml(mainText)}</text>
    <text x="${size.width / 2}" y="${(textY + fontSize * 0.72).toFixed(3)}" font-size="${Math.max(2.5, fontSize * 0.34).toFixed(3)}" letter-spacing="0.45" dominant-baseline="middle">${escapeXml(subText)}</text>
  </g>
</svg>`;
  }, [
    asset,
    assetHeight,
    assetWidth,
    assetY,
    category,
    dashGap,
    dashLength,
    fileName,
    fontSize,
    labelType,
    leatherColor,
    letterSpacing,
    mainText,
    size.height,
    size.width,
    stampColor,
    stitchInset,
    subText,
    textY,
  ]);

  function handleAssetUpload(event: ChangeEvent<HTMLInputElement>) {
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
      if (typeof reader.result === 'string') {
        setAsset({ dataUrl: reader.result, name: file.name, mime: file.type });
      }
    };
    reader.onerror = () => setUploadError('图片读取失败，请重新选择。');
    reader.readAsDataURL(file);
  }

  function downloadSvg() {
    const blob = new Blob([exportSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(fileName)}_${size.width}x${size.height}mm.svg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setExported(true);
    window.setTimeout(() => setExported(false), 3000);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/10 bg-[#171716] px-5 py-4 text-white lg:px-8">
        <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[#c6864a] text-[#171716]">
              <Scissors className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">皮牌设计台</h1>
              <p className="text-sm text-white/55">客户定制・毫米级矢量稿</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-sm text-white/55 sm:flex">
            <Ruler className="size-4" aria-hidden="true" />
            <span>{scaleLabel}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1680px] gap-5 p-4 xl:grid-cols-[330px_minmax(0,1fr)_300px] xl:p-6">
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
                    onClick={() => setSizeIndex(index)}
                    className={`size-choice ${sizeIndex === index ? 'size-choice-active' : ''}`}
                    aria-pressed={sizeIndex === index}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <Divider />
            <PanelHeading number="02" title="烫压内容" compact />

            <TextField
              id="main-text"
              label="主文字"
              value={mainText}
              onChange={setMainText}
            />
            <TextField
              id="sub-text"
              label="副文字"
              value={subText}
              onChange={setSubText}
            />

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
              min={20}
              max={72}
              step={1}
              onChange={setTextYPercent}
            />
            <RangeField
              id="letter-spacing"
              label="字距"
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
              <p className="section-kicker section-kicker-dark">03</p>
              <h2 className="text-xl font-semibold">毫米比例预览</h2>
            </div>
            <div className="flex gap-2 text-sm text-white/65">
              <span>{category}</span>
              <span aria-hidden="true">・</span>
              <span>{labelType}</span>
            </div>
          </div>

          <div className="preview-stage">
            <div className="ruler-note ruler-note-top">顶部虚线中心距边3 mm</div>
            <div
              className="label-frame"
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
            >
              <svg
                role="img"
                aria-label={`${scaleLabel}皮牌预览`}
                className="h-full w-full"
                viewBox={`0 0 ${size.width} ${size.height}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <rect
                  x="0"
                  y="0"
                  width={size.width}
                  height={size.height}
                  fill={leatherColor}
                />
                <line
                  x1={stitchInset}
                  x2={size.width - stitchInset}
                  y1="3"
                  y2="3"
                  stroke="#000000"
                  strokeWidth="0.45"
                  strokeDasharray={`${dashLength} ${dashGap}`}
                />
                <line
                  x1={stitchInset}
                  x2={size.width - stitchInset}
                  y1={size.height - 3}
                  y2={size.height - 3}
                  stroke="#000000"
                  strokeWidth="0.45"
                  strokeDasharray={`${dashLength} ${dashGap}`}
                />
                {asset ? (
                  <image
                    href={asset.dataUrl}
                    x={size.width / 2 - assetWidth / 2}
                    y={assetY - assetHeight / 2}
                    width={assetWidth}
                    height={assetHeight}
                    preserveAspectRatio="xMidYMid meet"
                  />
                ) : null}
                <text
                  x={size.width / 2}
                  y={textY}
                  fill={stampColor}
                  fontFamily="Arial, sans-serif"
                  fontSize={fontSize}
                  fontWeight="700"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  letterSpacing={letterSpacing}
                >
                  {mainText || '主文字'}
                </text>
                <text
                  x={size.width / 2}
                  y={textY + fontSize * 0.72}
                  fill={stampColor}
                  fontFamily="Arial, sans-serif"
                  fontSize={Math.max(2.5, fontSize * 0.34)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  letterSpacing="0.45"
                >
                  {subText}
                </text>
              </svg>
            </div>
            <div className="dimension-line dimension-width">
              <span>{size.width} mm</span>
            </div>
            <div className="dimension-line dimension-height">
              <span>{size.height} mm</span>
            </div>
            <div className="ruler-note ruler-note-bottom">底部虚线中心距边3 mm</div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <InfoCard label="成品尺寸" value={scaleLabel} />
            <InfoCard label="缝线" value="上下各1条黑色虚线" />
            <InfoCard label="图案状态" value={asset ? `${assetKind}已加入` : '未加入客户图案'} />
          </div>
        </section>

        <aside className="control-panel rounded-2xl border bg-card p-5 shadow-sm xl:max-h-[calc(100vh-112px)] xl:overflow-y-auto">
          <PanelHeading number="04" title="图案与缝线" />

          <div className="space-y-5">
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
              {uploadError ? (
                <p className="text-sm text-destructive">{uploadError}</p>
              ) : null}
            </div>

            {asset ? (
              <div className="rounded-xl border bg-background p-3">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <FileImage className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{asset.name}</p>
                    <p className="text-sm text-muted-foreground">{assetKind}</p>
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
            ) : null}

            {asset ? (
              <>
                <RangeField
                  id="asset-width"
                  label="图案宽度"
                  value={assetWidth}
                  unit="mm"
                  min={6}
                  max={Math.max(10, size.width - 8)}
                  step={1}
                  onChange={setAssetWidth}
                />
                <RangeField
                  id="asset-position"
                  label="图案上下位置"
                  value={assetYPercent}
                  unit="%"
                  min={14}
                  max={70}
                  step={1}
                  onChange={setAssetYPercent}
                />
              </>
            ) : null}

            <Divider />

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
              value={stitchInset}
              unit="mm"
              min={0}
              max={10}
              step={0.5}
              onChange={setStitchInset}
            />

            <Divider />
            <PanelHeading number="05" title="保存CDR" compact />

            <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-4">
              <div className="flex gap-3">
                <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <p className="text-sm leading-6 text-muted-foreground">
                  网页先产生尺寸准确的SVG。使用CorelDRAW 2020打开后，将文字转曲并另存为CDR，才是真正的CDR文件。
                </p>
              </div>
            </div>

            <Button
              type="button"
              size="lg"
              className="h-11 w-full"
              onClick={downloadSvg}
            >
              {exported ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
              {exported ? '矢量稿已下载' : '下载CorelDRAW矢量稿'}
            </Button>

            <a className="cdr-helper-link" href="/保存为CDR助手.vbs" download>
              下载CDR保存助手
            </a>

            <ol className="space-y-2 text-sm leading-6 text-muted-foreground">
              <li><StepNumber>1</StepNumber>下载矢量稿和保存助手。</li>
              <li><StepNumber>2</StepNumber>把SVG文件拖到助手文件上。</li>
              <li><StepNumber>3</StepNumber>同一文件夹自动生成CDR。</li>
            </ol>

            <div className="space-y-2 border-t pt-4">
              <CheckRow text={`${scaleLabel}成品尺寸`} />
              <CheckRow text="上下虚线中心距边均3 mm" />
              <CheckRow text="未生成生产工艺单" />
              <CheckRow
                text={
                  asset && asset.mime !== 'image/svg+xml'
                    ? '位图已嵌入；如仅作参考，在最终CDR删除'
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

function PanelHeading({
  number,
  title,
  compact = false,
}: {
  number: string;
  title: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'mb-3' : 'mb-5'}>
      <p className="section-kicker">{number}</p>
      <h2 className={compact ? 'text-lg font-semibold' : 'text-xl font-semibold'}>
        {title}
      </h2>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-border" />;
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((item) => (
          <NativeSelectOption key={item} value={item}>
            {item}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        maxLength={40}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function RangeField({
  id,
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <output className="text-sm tabular-nums text-muted-foreground">
          {value} {unit}
        </output>
      </div>
      <Slider
        id={id}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(nextValue) => onChange(nextValue[0] ?? value)}
        aria-label={label}
      />
    </div>
  );
}

function ColorPicker({
  id,
  label,
  value,
  colors,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  colors: { name: string; value: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          type="color"
          className="h-8 w-12 cursor-pointer p-1"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {colors.map((color) => (
          <button
            key={color.value}
            type="button"
            title={color.name}
            aria-label={`使用${color.name}`}
            aria-pressed={value === color.value}
            onClick={() => onChange(color.value)}
            className={`color-swatch ${value === color.value ? 'color-swatch-active' : ''}`}
            style={{ backgroundColor: color.value }}
          />
        ))}
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-white">
      <p className="text-sm text-white/48">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function CheckRow({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-2 inline-grid size-5 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
      {children}
    </span>
  );
}
