const path = require('path');

/**
 * Rotate a point to match the rotateWithFrame transformation used in image-utils.js.
 * Accounts for the expanded canvas size produced by rotateWithFrame (no clipping).
 */
function rotatePoint(point, angleDeg, origCols, origRows) {
  const rad = (angleDeg * Math.PI) / 180;
  const absRad = Math.abs(rad);
  const sinAbs = Math.sin(absRad);
  const cosAbs = Math.cos(absRad);
  const newW = Math.ceil(origRows * sinAbs + origCols * cosAbs);
  const newH = Math.ceil(origRows * cosAbs + origCols * sinAbs);

  const cx = origCols / 2;
  const cy = origRows / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  const dx = point.x - cx;
  const dy = point.y - cy;
  
  const rx = cos * dx + sin * dy;
  const ry = -sin * dx + cos * dy;
  
  return { x: rx + newW / 2, y: ry + newH / 2 };
}

function unrotatePoint(point, angleDeg, origCols, origRows) {
  const rad = (angleDeg * Math.PI) / 180;
  const absRad = Math.abs(rad);
  const sinAbs = Math.sin(absRad);
  const cosAbs = Math.cos(absRad);
  const newW = Math.ceil(origRows * sinAbs + origCols * cosAbs);
  const newH = Math.ceil(origRows * cosAbs + origCols * sinAbs);

  const cx = origCols / 2;
  const cy = origRows / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rx = point.x - newW / 2;
  const ry = point.y - newH / 2;

  const dx = cos * rx - sin * ry;
  const dy = sin * rx + cos * ry;

  return { x: dx + cx, y: dy + cy };
}

/**
 * Map a point from the original image coordinate system to the processed (cropped, scaled, deskewed) canvas.
 * @param {{x:number, y:number}} origPt - Point in original image space.
 * @param {{cropX:number, cropY:number, scale:number, angle:number, isFlipped:boolean, W:number, H:number, croppedWidth:number, croppedHeight:number}} meta - Metadata describing the processing applied.
 * @returns {{x:number, y:number}} Point in processed canvas space.
 */
function mapOriginalToProcessed(origPt, meta) {
  let startPt = { x: origPt.x, y: origPt.y };
  if (meta.isPdf && meta.renderScale) {
    startPt.x *= meta.renderScale;
    startPt.y *= meta.renderScale;
  }
  // 1. Translate according to crop offsets and scale to processed pixel size
  let p = { x: (startPt.x - meta.cropX) * meta.scale, y: (startPt.y - meta.cropY) * meta.scale };
  
  // 2. Rotate around the centre of the processed canvas if a deskew angle was applied
  if (meta.angle && Math.abs(meta.angle) > 0.1) {
    const origCols = meta.croppedWidth;
    const origRows = meta.croppedHeight;
    p = rotatePoint(p, meta.angle, origCols, origRows);
  }
  
  // 3. Apply flip if the image was flipped during preprocessing
  if (meta.isFlipped) {
    p = { x: meta.W - p.x, y: meta.H - p.y };
  }
  
  return p;
}

function mapProcessedToOriginal(processedPt, meta) {
  let p = { x: processedPt.x, y: processedPt.y };

  if (meta.isFlipped) {
    p = { x: meta.W - p.x, y: meta.H - p.y };
  }

  if (meta.angle && Math.abs(meta.angle) > 0.1) {
    p = unrotatePoint(p, meta.angle, meta.croppedWidth, meta.croppedHeight);
  }

  const scale = meta.scale || 1;
  let sourcePt = {
    x: p.x / scale + (meta.cropX || 0),
    y: p.y / scale + (meta.cropY || 0),
  };

  if (meta.isPdf && meta.renderScale) {
    sourcePt = { x: sourcePt.x / meta.renderScale, y: sourcePt.y / meta.renderScale };
  }

  return sourcePt;
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pointInBounds(pt, width, height, padding = 2) {
  return (
    Number.isFinite(pt.x) &&
    Number.isFinite(pt.y) &&
    pt.x >= -padding &&
    pt.y >= -padding &&
    pt.x <= width + padding &&
    pt.y <= height + padding
  );
}

function buildTransformMetaFromGt(gt, fallbackW, fallbackH) {
  if (!gt.processedTransform) return null;

  const transform = gt.processedTransform || {};
  const sourceW = toFiniteNumber(gt.sourceWidth, toFiniteNumber(gt.sourceWidthPx));
  const sourceH = toFiniteNumber(gt.sourceHeight, toFiniteNumber(gt.sourceHeightPx));
  const cropX = toFiniteNumber(transform.cropX, toFiniteNumber(gt.cropX, 0));
  const cropY = toFiniteNumber(transform.cropY, toFiniteNumber(gt.cropY, 0));
  const scale = toFiniteNumber(transform.scale, toFiniteNumber(gt.scale, 1));
  const angle = toFiniteNumber(transform.angle, toFiniteNumber(gt.angle, 0));
  const croppedWidth = toFiniteNumber(transform.croppedWidth, toFiniteNumber(gt.croppedWidth, sourceW || fallbackW));
  const croppedHeight = toFiniteNumber(transform.croppedHeight, toFiniteNumber(gt.croppedHeight, sourceH || fallbackH));

  if (!sourceW || !sourceH || !croppedWidth || !croppedHeight) return null;

  return {
    isPdf: Boolean(gt.isPdf),
    renderScale: toFiniteNumber(gt.renderScale, null),
    cropX,
    cropY,
    scale,
    angle,
    isFlipped: false,
    W: fallbackW,
    H: fallbackH,
    croppedWidth,
    croppedHeight,
  };
}

function buildTransformMetaFromSource(sourceMeta, appW, appH) {
  const sourceW = toFiniteNumber(sourceMeta.sourceWidthPx, toFiniteNumber(sourceMeta.sourceWidth));
  const sourceH = toFiniteNumber(sourceMeta.sourceHeightPx, toFiniteNumber(sourceMeta.sourceHeight));
  const cropX = toFiniteNumber(sourceMeta.cropX, 0);
  const cropY = toFiniteNumber(sourceMeta.cropY, 0);
  const scale = toFiniteNumber(sourceMeta.scale, 1);
  const angle = toFiniteNumber(sourceMeta.angle, 0);
  return {
    isPdf: Boolean(sourceMeta.isPdf),
    renderScale: toFiniteNumber(sourceMeta.renderScale, null),
    cropX,
    cropY,
    scale,
    angle,
    isFlipped: false,
    W: appW,
    H: appH,
    croppedWidth: toFiniteNumber(sourceMeta.croppedWidth, sourceW ? (sourceW - cropX) * scale : appW),
    croppedHeight: toFiniteNumber(sourceMeta.croppedHeight, sourceH ? (sourceH - cropY) * scale : appH),
  };
}

/**
 * Normalize a GT entry into the current processed-canvas coordinate space.
 *
 * Coordinate contract:
 * - `coordinateSpace: "processed"` => p0/p12 are already in processed space.
 * - `coordinateSpace: "original"` => p0/p12 are in source/original file space and must be mapped.
 */
function normalizeGroundTruthForApp(gt, appMeta) {
  if (!gt || !gt.p0 || !gt.p12) {
    throw new Error('Invalid GT entry: missing p0/p12');
  }
  const W = toFiniteNumber(appMeta && appMeta.W);
  const H = toFiniteNumber(appMeta && appMeta.H);
  if (!W || !H || W <= 0 || H <= 0) {
    throw new Error('Invalid app metadata: processed canvas size missing');
  }

  const legacyWidth = toFiniteNumber(gt.original_width);
  const legacyHeight = toFiniteNumber(gt.original_height);
  const rawSpace = String(gt.coordinateSpace || '').trim().toLowerCase();
  const legacyProcessedFallback = !rawSpace && legacyWidth && legacyHeight;
  const coordinateSpace = rawSpace || (legacyProcessedFallback ? 'processed' : '');
  if (!coordinateSpace) {
    throw new Error('GT entry missing coordinateSpace (expected "processed" or "original")');
  }

  if (coordinateSpace === 'processed') {
    const rawP0 = { x: Number(gt.p0.x), y: Number(gt.p0.y) };
    const rawP12 = { x: Number(gt.p12.x), y: Number(gt.p12.y) };
    let p0 = rawP0;
    let p12 = rawP12;

    const declaredW = toFiniteNumber(gt.processedWidth, legacyWidth || W);
    const declaredH = toFiniteNumber(gt.processedHeight, legacyHeight || H);
    if (!pointInBounds(p0, declaredW, declaredH) || !pointInBounds(p12, declaredW, declaredH)) {
      throw new Error('Processed-space GT point out of bounds');
    }

    let scaleX = 1;
    let scaleY = 1;
    let scaledToApp = false;
    if (Math.abs(declaredW - W) > 2 || Math.abs(declaredH - H) > 2) {
      const gtTransform = buildTransformMetaFromGt(gt, declaredW, declaredH);
      const appTransform = buildTransformMetaFromSource((appMeta && appMeta.sourceMeta) || {}, W, H);
      if (gtTransform) {
        p0 = mapOriginalToProcessed(mapProcessedToOriginal(rawP0, gtTransform), appTransform);
        p12 = mapOriginalToProcessed(mapProcessedToOriginal(rawP12, gtTransform), appTransform);
      } else {
        scaleX = W / declaredW;
        scaleY = H / declaredH;
        p0 = { x: p0.x * scaleX, y: p0.y * scaleY };
        p12 = { x: p12.x * scaleX, y: p12.y * scaleY };
        scaledToApp = true;
      }
    }
    if (!pointInBounds(p0, W, H) || !pointInBounds(p12, W, H)) {
      throw new Error('Processed-space GT mapped out of app bounds');
    }

    return {
      coordinateSpace,
      p0,
      p12,
      displayP0: rawP0,
      displayP12: rawP12,
      diagnostics: {
        processedWidth: declaredW,
        processedHeight: declaredH,
        scaledToApp,
        scaleX,
        scaleY,
        legacyProcessedFallback,
        usedTransformMapping: !scaledToApp && (Math.abs(declaredW - W) > 2 || Math.abs(declaredH - H) > 2),
      },
    };
  }

  if (coordinateSpace === 'original') {
    const sourceMeta = (appMeta && appMeta.sourceMeta) || {};
    const sourceW = toFiniteNumber(sourceMeta.sourceWidthPx);
    const sourceH = toFiniteNumber(sourceMeta.sourceHeightPx);
    const origW = toFiniteNumber(gt.original_width);
    const origH = toFiniteNumber(gt.original_height);
    if (!sourceW || !sourceH || !origW || !origH) {
      throw new Error('Original-space GT requires original_width/original_height and runtime sourceWidthPx/sourceHeightPx');
    }

    const sx = sourceW / origW;
    const sy = sourceH / origH;
    const p0Orig = { x: Number(gt.p0.x) * sx, y: Number(gt.p0.y) * sy };
    const p12Orig = { x: Number(gt.p12.x) * sx, y: Number(gt.p12.y) * sy };

    const cropX = toFiniteNumber(sourceMeta.cropX, 0);
    const cropY = toFiniteNumber(sourceMeta.cropY, 0);
    const scale = toFiniteNumber(sourceMeta.scale, 1);
    const angle = toFiniteNumber(sourceMeta.angle, 0);
    const croppedWidth = toFiniteNumber(sourceMeta.croppedWidth, (sourceW - cropX) * scale);
    const croppedHeight = toFiniteNumber(sourceMeta.croppedHeight, (sourceH - cropY) * scale);

    const mapMeta = {
      isPdf: Boolean(sourceMeta.isPdf),
      renderScale: toFiniteNumber(sourceMeta.renderScale, null),
      cropX,
      cropY,
      scale,
      angle,
      isFlipped: false,
      W,
      H,
      croppedWidth,
      croppedHeight,
    };

    const p0 = mapOriginalToProcessed(p0Orig, mapMeta);
    const p12 = mapOriginalToProcessed(p12Orig, mapMeta);
    if (!pointInBounds(p0, W, H) || !pointInBounds(p12, W, H)) {
      throw new Error('Original-space GT mapped out of processed bounds');
    }

    return {
      coordinateSpace,
      p0,
      p12,
      displayP0: p0,
      displayP12: p12,
      diagnostics: {
        sourceWidth: sourceW,
        sourceHeight: sourceH,
        scaleX: sx,
        scaleY: sy,
        cropX,
        cropY,
        scale,
        angle,
      },
    };
  }

  throw new Error(`Unsupported GT coordinateSpace: ${gt.coordinateSpace}`);
}

module.exports = { mapOriginalToProcessed, mapProcessedToOriginal, normalizeGroundTruthForApp };

