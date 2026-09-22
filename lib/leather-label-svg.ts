import type { TracedVector } from '@/lib/photo-trace';

export type MarkShape =
  | 'none'
  | 'circle'
  | 'oval'
  | 'diamond'
  | 'hexagon'
  | 'shield'
  | 'star';

export type MarkLayout = 'badge' | 'left' | 'top';

export type LabelLayoutInput = {
  width: number;
  height: number;
  markLayout: MarkLayout;
  groupXPercent: number;
  markYPercent: number;
  textYPercent: number;
  markSize: number;
};

export type LeatherLabelSvgConfig = LabelLayoutInput & {
  fileName: string;
  category: string;
  labelType: string;
  leatherColor: string;
  stampColor: string;
  markColor: string;
  dashLength: number;
  dashGap: number;
  stitchInset: number;
  mainText: string;
  subText: string;
  mainFontFamily: string;
  subFontFamily: string;
  fontSize: number;
  letterSpacing: number;
  markShape: MarkShape;
  markText: string;
  asset?: {
    dataUrl?: string;
    vector?: TracedVector;
    width: number;
    height: number;
    xPercent: number;
    yPercent: number;
  } | null;
};

export function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function formatMm(value: number) {
  return Number(value.toFixed(3)).toString();
}

function formatScale(value: number) {
  return Number(value.toFixed(9)).toString();
}

export type CurveOnlySvgAudit = {
  passed: boolean;
  pathCount: number;
  liveTextObjectCount: number;
  bitmapObjectCount: number;
  externalReferenceCount: number;
  unsupportedElements: string[];
};

export type PhotoGlyphFidelity =
  | 'photo-outline-approximate'
  | 'exact-font-curves'
  | 'mixed-photo-and-font-curves'
  | 'no-confirmed-text';

const CURVE_ONLY_ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'title',
  'desc',
]);

export function getPhotoGlyphFidelity(
  vector: TracedVector,
): PhotoGlyphFidelity {
  const photoTextCount = vector.photoTextRegionCount ?? 0;
  const fontTextCount = vector.fontTextRegionCount ?? 0;
  if (photoTextCount > 0 && fontTextCount > 0) {
    return 'mixed-photo-and-font-curves';
  }
  if (photoTextCount > 0) return 'photo-outline-approximate';
  if (fontTextCount > 0) return 'exact-font-curves';
  return 'no-confirmed-text';
}

/**
 * Audits the exact SVG string that will be downloaded. Metadata-only title and
 * desc elements are allowed; every rendered object must be a path inside groups.
 */
export function auditCurveOnlySvg(svg: string): CurveOnlySvgAudit {
  const openingElementMatches = Array.from(
    svg.matchAll(/<\s*(?![/? !])([A-Za-z][\w:.-]*)\b[^>]*>/gu),
  );
  const openingTags = openingElementMatches.map((match) =>
    match[1].toLowerCase(),
  );
  const openingElementMarkup = openingElementMatches
    .map((match) => match[0])
    .join('\n');
  const pathElements = svg.match(/<\s*path\b[^>]*>/giu) ?? [];
  const pathCount = pathElements.filter((element) => {
    const pathData = element.match(/\bd\s*=\s*(["'])(.*?)\1/iu)?.[2];
    return Boolean(pathData?.trim());
  }).length;
  const liveTextObjectCount = openingTags.filter(
    (name) => name === 'text',
  ).length;
  const bitmapObjectCount =
    openingTags.filter((name) => name === 'image').length +
    (openingElementMarkup.match(/data\s*:\s*image\//giu)?.length ?? 0);
  const externalReferenceCount =
    (openingElementMarkup.match(/\b(?:href|xlink:href)\s*=/giu)?.length ?? 0) +
    (openingElementMarkup.match(/\burl\s*\(/giu)?.length ?? 0);
  const unsupportedElements = Array.from(
    new Set(
      openingTags.filter((name) => !CURVE_ONLY_ALLOWED_ELEMENTS.has(name)),
    ),
  ).sort();
  const emptyPathCount = pathElements.length - pathCount;
  if (emptyPathCount > 0) unsupportedElements.push('empty-path');

  return {
    passed:
      pathCount > 0 &&
      liveTextObjectCount === 0 &&
      bitmapObjectCount === 0 &&
      externalReferenceCount === 0 &&
      unsupportedElements.length === 0,
    pathCount,
    liveTextObjectCount,
    bitmapObjectCount,
    externalReferenceCount,
    unsupportedElements,
  };
}

function tracedVectorPathsMarkup(vector: TracedVector) {
  const basePaths = vector.paths
    .map((path) => `<path d="${escapeXml(path)}" />`)
    .join('\n    ');
  const confirmedText = (vector.overlays ?? [])
    .map(
      (
        overlay,
      ) => `<g fill-rule="nonzero" transform="translate(${formatMm(overlay.x)} ${formatMm(overlay.y)}) scale(${formatScale(overlay.scaleX)} ${formatScale(overlay.scaleY)})">
      ${overlay.paths
        .map((path) => `<path d="${escapeXml(path)}" />`)
        .join('\n      ')}
    </g>`,
    )
    .join('\n    ');
  return [basePaths, confirmedText].filter(Boolean).join('\n    ');
}

function tracedVectorPathCount(vector: TracedVector) {
  return (
    vector.paths.length +
    (vector.overlays ?? []).reduce(
      (count, overlay) => count + overlay.paths.length,
      0,
    )
  );
}

function contentBoundsAttributes(vector: TracedVector) {
  const bounds = vector.contentBoundsMm;
  if (!bounds) return '';
  return ` data-content-x-mm="${formatMm(bounds.x)}" data-content-y-mm="${formatMm(bounds.y)}" data-content-width-mm="${formatMm(bounds.width)}" data-content-height-mm="${formatMm(bounds.height)}"`;
}

function contentBoundsFitLabel(
  vector: TracedVector,
  width: number,
  height: number,
) {
  const bounds = vector.contentBoundsMm;
  if (!bounds) return true;
  const tolerance = 0.001;
  return (
    bounds.x >= -tolerance &&
    bounds.y >= -tolerance &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x + bounds.width <= width + tolerance &&
    bounds.y + bounds.height <= height + tolerance
  );
}

export function buildPhotoArtworkSvg(
  vector: TracedVector,
  width: number,
  height: number,
  fileName: string,
  humanReviewed: boolean,
) {
  if (
    !humanReviewed ||
    vector.coordinateSpace !== 'label' ||
    vector.geometryConfirmed !== true ||
    vector.reconstructedFromConfirmedRegions !== true ||
    (vector.productionBlockedReasons?.length ?? 0) > 0 ||
    (vector.qualityWarnings?.length ?? 0) > 0 ||
    vector.expectedTextRegionCount !== vector.manualTextCount ||
    (vector.photoTextRegionCount ?? 0) + (vector.fontTextRegionCount ?? 0) !==
      (vector.manualTextCount ?? 0) ||
    ((vector.photoTextRegionCount ?? 0) > 0 &&
      (vector.tracePixelsPerMillimeter ?? 0) < 16) ||
    ((vector.tracedGraphicRegionCount ?? 0) > 0 &&
      (vector.tracePixelsPerMillimeter ?? 0) < 8) ||
    Math.abs((vector.calibratedWidth ?? 0) - width) > 0.001 ||
    Math.abs((vector.calibratedHeight ?? 0) - height) > 0.001 ||
    !contentBoundsFitLabel(vector, width, height) ||
    tracedVectorPathCount(vector) === 0
  ) {
    throw new Error('图文曲线与当前成品尺寸不一致，请重新描绘。');
  }
  const widthMm = formatMm(width);
  const heightMm = formatMm(height);
  const traceVersionId = escapeXml(vector.traceVersionId ?? 'unversioned');
  const glyphFidelity = getPhotoGlyphFidelity(vector);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}" data-artwork-only="true" data-export-profile="leather-label-mold-artwork" data-export-version="3" data-page-unit="mm" data-geometry-confirmed="true" data-perspective-corrected="true" data-reconstruction="confirmed-regions-only" data-object-model="paths-only" data-live-text-count="0" data-bitmap-count="0" data-source-photo-embedded="false" data-curve-audit="passed" data-texture-review="human-confirmed" data-glyph-fidelity="${glyphFidelity}" data-human-reviewed="true" data-cdr-review-required="true" data-trace-version="${traceVersionId}" data-manual-text-count="${vector.manualTextCount ?? 0}" data-photo-text-count="${vector.photoTextRegionCount ?? 0}" data-font-text-count="${vector.fontTextRegionCount ?? 0}" data-photo-graphic-count="${vector.tracedGraphicRegionCount ?? 0}" data-manual-erase-count="${vector.manualEraseRegionCount ?? 0}"${contentBoundsAttributes(vector)}>
  <title>${escapeXml(fileName)} — 纯图文 ${widthMm}×${heightMm}mm</title>
  <desc>仅含曲线路径，不额外生成皮色、照片或示意缝线。自动描绘可能误取旧缝线或皮纹，使用前须逐字、逐线核对。</desc>
  <g id="纯图文曲线" transform="scale(${formatScale(width / vector.viewBoxWidth)} ${formatScale(height / vector.viewBoxHeight)})" fill="#000000" fill-rule="evenodd" stroke="none">
    ${tracedVectorPathsMarkup(vector)}
  </g>
</svg>`;
  if (!auditCurveOnlySvg(svg).passed) {
    throw new Error('纯图文文件中发现非曲线对象，已停止导出。');
  }
  return svg;
}

export function buildPhotoRepairSvg(
  vector: TracedVector,
  width: number,
  height: number,
  fileName: string,
) {
  if (
    vector.coordinateSpace !== 'label' ||
    vector.geometryConfirmed !== true ||
    vector.reconstructedFromConfirmedRegions !== true ||
    vector.expectedTextRegionCount !== vector.manualTextCount ||
    (vector.photoTextRegionCount ?? 0) + (vector.fontTextRegionCount ?? 0) !==
      (vector.manualTextCount ?? 0) ||
    Math.abs((vector.calibratedWidth ?? 0) - width) > 0.001 ||
    Math.abs((vector.calibratedHeight ?? 0) - height) > 0.001 ||
    !contentBoundsFitLabel(vector, width, height) ||
    tracedVectorPathCount(vector) === 0
  ) {
    throw new Error(
      '描修工作稿与当前成品尺寸不一致，请重新确认皮牌外边和实测尺寸。',
    );
  }
  const widthMm = formatMm(width);
  const heightMm = formatMm(height);
  const traceVersionId = escapeXml(vector.traceVersionId ?? 'unversioned');
  const glyphFidelity = getPhotoGlyphFidelity(vector);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}" data-artwork-only="true" data-export-profile="leather-label-cdr-repair-draft" data-export-version="3" data-page-unit="mm" data-geometry-confirmed="true" data-perspective-corrected="true" data-reconstruction="confirmed-regions-only" data-object-model="paths-only" data-live-text-count="0" data-bitmap-count="0" data-source-photo-embedded="false" data-curve-audit="passed" data-texture-review="required" data-glyph-fidelity="${glyphFidelity}" data-production-ready="false" data-production-use="prohibited" data-human-reviewed="false" data-cdr-review-required="true" data-trace-version="${traceVersionId}" data-manual-erase-count="${vector.manualEraseRegionCount ?? 0}"${contentBoundsAttributes(vector)}>
  <title>${escapeXml(fileName)} — CDR描修工作稿 ${widthMm}×${heightMm}mm</title>
  <desc>保持整块皮牌的实测毫米坐标，只含照片提取的黑色曲线。低清照片中不可见的细节没有被猜测补全；本文件必须在CorelDRAW逐字逐线描修和审核，不能直接制模。</desc>
  <g id="CDR描修曲线_不可直接制模" transform="scale(${formatScale(width / vector.viewBoxWidth)} ${formatScale(height / vector.viewBoxHeight)})" fill="#000000" fill-rule="evenodd" stroke="none">
    ${tracedVectorPathsMarkup(vector)}
  </g>
</svg>`;
  if (!auditCurveOnlySvg(svg).passed) {
    throw new Error('描修工作稿中发现非曲线对象，已停止导出。');
  }
  return svg;
}

export function getLabelLayout(input: LabelLayoutInput) {
  const groupX = (input.width * input.groupXPercent) / 100;
  const spacing = Math.min(input.markSize * 0.88, input.width * 0.18);
  const markX = input.markLayout === 'left' ? groupX - spacing : groupX;
  const textX = input.markLayout === 'left' ? groupX + spacing : groupX;

  return {
    groupX,
    markX,
    markY: (input.height * input.markYPercent) / 100,
    textX,
    textY: (input.height * input.textYPercent) / 100,
  };
}

function starPoints(outerRadius: number, innerRadius: number) {
  return Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    return `${(Math.cos(angle) * radius).toFixed(3)},${(
      Math.sin(angle) * radius
    ).toFixed(3)}`;
  }).join(' ');
}

export function buildMarkShapeMarkup(
  shape: MarkShape,
  size: number,
  color: string,
) {
  if (shape === 'none') return '';

  const half = size / 2;
  const strokeWidth = Math.max(0.35, size * 0.055);
  const common = `fill="none" stroke="${escapeXml(color)}" stroke-width="${formatMm(
    strokeWidth,
  )}" stroke-linejoin="round"`;

  switch (shape) {
    case 'circle':
      return `<circle cx="0" cy="0" r="${formatMm(half * 0.9)}" ${common} />`;
    case 'oval':
      return `<ellipse cx="0" cy="0" rx="${formatMm(half * 0.96)}" ry="${formatMm(
        half * 0.7,
      )}" ${common} />`;
    case 'diamond':
      return `<polygon points="0,-${formatMm(half * 0.94)} ${formatMm(
        half * 0.86,
      )},0 0,${formatMm(half * 0.94)} -${formatMm(half * 0.86)},0" ${common} />`;
    case 'hexagon':
      return `<polygon points="0,-${formatMm(half * 0.94)} ${formatMm(
        half * 0.82,
      )},-${formatMm(half * 0.47)} ${formatMm(half * 0.82)},${formatMm(
        half * 0.47,
      )} 0,${formatMm(half * 0.94)} -${formatMm(half * 0.82)},${formatMm(
        half * 0.47,
      )} -${formatMm(half * 0.82)},-${formatMm(half * 0.47)}" ${common} />`;
    case 'shield':
      return `<path d="M 0 -${formatMm(half * 0.95)} L ${formatMm(
        half * 0.78,
      )} -${formatMm(half * 0.6)} L ${formatMm(half * 0.68)} ${formatMm(
        half * 0.32,
      )} Q 0 ${formatMm(half * 1.08)} -${formatMm(half * 0.68)} ${formatMm(
        half * 0.32,
      )} L -${formatMm(half * 0.78)} -${formatMm(half * 0.6)} Z" ${common} />`;
    case 'star':
      return `<polygon points="${starPoints(half * 0.94, half * 0.43)}" ${common} />`;
  }
}

export function buildLeatherLabelSvg(config: LeatherLabelSvgConfig) {
  const width = formatMm(config.width);
  const height = formatMm(config.height);
  const layout = getLabelLayout(config);
  const markShape = buildMarkShapeMarkup(
    config.markShape,
    config.markSize,
    config.markColor,
  );
  const markMarkup =
    config.markShape === 'none'
      ? ''
      : `<g id="图形字母组合" transform="translate(${formatMm(layout.markX)} ${formatMm(
          layout.markY,
        )})">
    ${markShape}
    <text x="0" y="0" fill="${escapeXml(
      config.markColor,
    )}" text-anchor="middle" dominant-baseline="middle" font-family="${escapeXml(
      config.mainFontFamily,
    )}" font-size="${formatMm(
      Math.max(2.6, config.markSize * 0.34),
    )}" font-weight="800" letter-spacing="${formatMm(
      Math.max(0.1, config.markSize * 0.025),
    )}">${escapeXml(config.markText)}</text>
  </g>`;

  const assetUsesLabelCoordinates =
    config.asset?.vector?.coordinateSpace === 'label';
  const assetWidth = assetUsesLabelCoordinates
    ? (config.asset?.vector?.calibratedWidth ?? config.width)
    : (config.asset?.width ?? 0);
  const assetHeight = assetUsesLabelCoordinates
    ? (config.asset?.vector?.calibratedHeight ?? config.height)
    : (config.asset?.height ?? 0);
  const assetX = config.asset
    ? assetUsesLabelCoordinates
      ? 0
      : (config.width * config.asset.xPercent) / 100 - assetWidth / 2
    : 0;
  const assetY = config.asset
    ? assetUsesLabelCoordinates
      ? 0
      : (config.height * config.asset.yPercent) / 100 - assetHeight / 2
    : 0;
  const assetMarkup = config.asset?.vector
    ? `<g id="客户自动描绘矢量" transform="translate(${formatMm(
        assetX,
      )} ${formatMm(assetY)}) scale(${formatScale(
        assetWidth / config.asset.vector.viewBoxWidth,
      )} ${formatScale(
        assetHeight / config.asset.vector.viewBoxHeight,
      )})" fill="${escapeXml(
        config.stampColor,
      )}" fill-rule="evenodd" stroke="none">
    ${tracedVectorPathsMarkup(config.asset.vector)}
  </g>`
    : config.asset?.dataUrl
      ? `<g id="客户图案"><image href="${escapeXml(
          config.asset.dataUrl,
        )}" x="${formatMm(assetX)}" y="${formatMm(
          assetY,
        )}" width="${formatMm(assetWidth)}" height="${formatMm(
          assetHeight,
        )}" preserveAspectRatio="xMidYMid meet" /></g>`
      : '';

  const mainTextMarkup = config.mainText
    ? `<text x="${formatMm(layout.textX)}" y="${formatMm(
        layout.textY,
      )}" font-family="${escapeXml(
        config.mainFontFamily,
      )}" font-size="${formatMm(
        config.fontSize,
      )}" font-weight="700" letter-spacing="${formatMm(
        config.letterSpacing,
      )}" dominant-baseline="middle">${escapeXml(config.mainText)}</text>`
    : '';
  const subTextMarkup = config.subText
    ? `<text x="${formatMm(layout.textX)}" y="${formatMm(
        layout.textY + config.fontSize * 0.72,
      )}" font-family="${escapeXml(
        config.subFontFamily,
      )}" font-size="${formatMm(
        Math.max(2.5, config.fontSize * 0.34),
      )}" letter-spacing="0.45" dominant-baseline="middle">${escapeXml(
        config.subText,
      )}</text>`
    : '';
  const textMarkup =
    mainTextMarkup || subTextMarkup
      ? `<g id="烫压文字" fill="${escapeXml(
          config.stampColor,
        )}" text-anchor="middle">
    ${mainTextMarkup}
    ${subTextMarkup}
  </g>`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" data-artwork-only="false" data-export-profile="leather-label-mockup" data-production-use="prohibited">
  <title>${escapeXml(config.fileName)} — ${width}×${height}mm</title>
  <desc>${escapeXml(config.category)} / ${escapeXml(
    config.labelType,
  )}。上下黑色虚线的中心线均距成品边3mm。</desc>
  <g id="成品外框">
    <rect x="0" y="0" width="${width}" height="${height}" fill="${escapeXml(
      config.leatherColor,
    )}" />
  </g>
  <g id="缝线" fill="none" stroke="#000000" stroke-width="0.45" stroke-dasharray="${formatMm(
    config.dashLength,
  )} ${formatMm(config.dashGap)}">
    <line x1="${formatMm(config.stitchInset)}" y1="3" x2="${formatMm(
      config.width - config.stitchInset,
    )}" y2="3" />
    <line x1="${formatMm(config.stitchInset)}" y1="${formatMm(
      config.height - 3,
    )}" x2="${formatMm(config.width - config.stitchInset)}" y2="${formatMm(
      config.height - 3,
    )}" />
  </g>
  ${assetMarkup}
  ${markMarkup}
  ${textMarkup}
</svg>`;
}
