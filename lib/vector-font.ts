import opentype, { type Font } from 'opentype.js';

export const CURVE_FONT_OPTIONS = [
  { id: 'arvo', label: 'Arvo 粗衬线', file: 'Arvo-Bold.ttf', css: 'Curve Arvo' },
  { id: 'anton', label: 'Anton 粗黑体', file: 'Anton-Regular.ttf', css: 'Curve Anton' },
  { id: 'pacifico', label: 'Pacifico 手写体', file: 'Pacifico-Regular.ttf', css: 'Curve Pacifico' },
] as const;

export type CurveFontId = (typeof CURVE_FONT_OPTIONS)[number]['id'];
export type CurveFontChoiceId = CurveFontId | 'custom';

const cachedFonts = new Map<CurveFontId, Promise<Font>>();
const cachedCustomFonts = new WeakMap<ArrayBuffer, Font>();

export function curveFontOption(id: string) {
  return CURVE_FONT_OPTIONS.find((option) => option.id === id);
}

async function loadCurveFont(id: CurveFontId): Promise<Font> {
  const existing = cachedFonts.get(id);
  if (existing) return existing;
  const option = curveFontOption(id);
  if (!option) throw new Error('未找到选定的曲线字体，请重新选择。');
  const loading = fetch(`/fonts/${option.file}`)
    .then(async (response) => {
      if (!response.ok) throw new Error('字体文件加载失败，请检查网络后重试。');
      return opentype.parse(await response.arrayBuffer());
    })
    .catch((error) => {
      cachedFonts.delete(id);
      throw error;
    });
  cachedFonts.set(id, loading);
  return loading;
}

function loadCustomCurveFont(buffer: ArrayBuffer) {
  const existing = cachedCustomFonts.get(buffer);
  if (existing) return existing;
  const font = opentype.parse(buffer.slice(0));
  cachedCustomFonts.set(buffer, font);
  return font;
}

export function validateCustomCurveFont(buffer: ArrayBuffer) {
  loadCustomCurveFont(buffer);
}

/** Returns true font outlines, never text pixels or an OS fallback font. */
export async function confirmedTextCurve(
  text: string,
  fontId: CurveFontChoiceId,
  target: { x: number; y: number; width: number; height: number },
  customFontBuffer?: ArrayBuffer,
) {
  const font =
    fontId === 'custom'
      ? customFontBuffer
        ? loadCustomCurveFont(customFontBuffer)
        : (() => {
            throw new Error('请重新选择自定义字体文件。');
          })()
      : await loadCurveFont(fontId);
  const missing = [...text].filter(
    (character) => !/\s/u.test(character) && font.charToGlyphIndex(character) === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `当前字体没有“${[...new Set(missing)].join('')}”字形，请选择支持它的字体或在 CDR 中人工绘制。`,
    );
  }
  const path = font.getPath(text, 0, 0, 1000, { kerning: true });
  const bounds = path.getBoundingBox();
  const width = bounds.x2 - bounds.x1;
  const height = bounds.y2 - bounds.y1;
  if (!(width > 0 && height > 0 && target.width > 0 && target.height > 0)) {
    throw new Error(`“${text}”没有可用的曲线或选区太小。`);
  }
  const scale = Math.min((target.width * 0.94) / width, (target.height * 0.86) / height);
  return {
    paths: [path.toPathData(3)],
    x: target.x + (target.width - width * scale) / 2 - bounds.x1 * scale,
    y: target.y + (target.height - height * scale) / 2 - bounds.y1 * scale,
    scaleX: scale,
    scaleY: scale,
  };
}
