/**
 * js/pdf-generator.js
 * PDF generation and canvas layout helpers.
 */

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const PRINT_MARGIN_MM = 10;
const WEISS_THRESH = 246;

function mmToPt(mm) {
  return mm * (72 / 25.4);
}

function distance(a, b) {
  return Math.hypot((b.x - a.x), (b.y - a.y));
}

async function generateA4Pdf(cal, imageCanvas) {
  const pdfDoc = await PDFLib.PDFDocument.create();
  const page = pdfDoc.addPage([mmToPt(A4_WIDTH_MM), mmToPt(A4_HEIGHT_MM)]);
  const printCanvas = await createA4PrintCanvas(cal, imageCanvas);
  const png = await canvasToBytes(printCanvas);
  const img = await pdfDoc.embedPng(png);

  page.drawImage(img, {
    x: 0,
    y: 0,
    width: mmToPt(A4_WIDTH_MM),
    height: mmToPt(A4_HEIGHT_MM),
  });
  const bytes = await pdfDoc.save();
  return await extractFirstPdfPage(bytes);
}

async function extractFirstPdfPage(pdfBytes) {
  const src = await PDFLib.PDFDocument.load(pdfBytes);
  if (src.getPageCount() <= 1) {
    return new Blob([pdfBytes], { type: "application/pdf" });
  }

  const out = await PDFLib.PDFDocument.create();
  const [firstPage] = await out.copyPages(src, [0]);
  out.addPage(firstPage);
  const outBytes = await out.save();
  return new Blob([outBytes], { type: "application/pdf" });
}

function calculateCalibrationFromLine(base, outputCanvas) {
  const pixelDist = distance(base.p0, base.p12);
  if (!Number.isFinite(pixelDist) || pixelDist < 10) {
    throw new Error("Kalibrierlinie ist zu kurz oder ungültig.");
  }

  // Fallback to currently selected ruler length if none is stored
  const rulerLengthMm = base.detectedLengthMm || (window.getRulerLengthMm && getRulerLengthMm()) || 120;
  const pointsPerPixel = mmToPt(rulerLengthMm) / pixelDist;
  const pxPerMm = 1 / (pointsPerPixel / (72 / 25.4));
  const imageBreiteMm = outputCanvas.width / pxPerMm;
  const imageHöheMm = outputCanvas.height / pxPerMm;

  return {
    ...base,
    pixelDist,
    pointsPerPixel,
    pxPerMm,
    imageBreiteMm,
    imageHöheMm,
  };
}

async function createA4PrintCanvas(cal, imageCanvas) {
  const normalized = await normalizeImageOrientation(cal, imageCanvas);
  const trimmed = trimWhiteMargins(normalized.canvas, WEISS_THRESH);
  let source = trimmed.canvas;

  if (window.appState) {
    appState.outputOcrNormalWords = normalized.ocrWordsNormal || [];
    appState.outputOcrMirroredWords = normalized.ocrWordsMirrored || [];
    appState.outputMirrored = Boolean(normalized.mirrored);
    if (window.updateMetrics) updateMetrics();
  }

  let pxPerMm = Number(cal && cal.pxPerMm);
  if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) {
    const widthMm = Number(cal && cal.imageBreiteMm);
    if (Number.isFinite(widthMm) && widthMm > 0) {
      pxPerMm = source.width / widthMm;
    }
  }
  if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) {
    pxPerMm = Math.max(source.width / A4_WIDTH_MM, source.height / A4_HEIGHT_MM);
  }

  const a4W = Math.max(1, Math.round(pxPerMm * A4_WIDTH_MM));
  const a4H = Math.max(1, Math.round(pxPerMm * A4_HEIGHT_MM));
  const out = document.createElement("canvas");
  out.width = a4W;
  out.height = a4H;

  const ctx = out.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);

  const marginPx = Math.max(0, Math.round(pxPerMm * PRINT_MARGIN_MM));
  const inhaltMaxW = Math.max(1, out.width - marginPx * 2);
  const inhaltMaxH = Math.max(1, out.height - marginPx * 2);
  source = centerCropCanvas(source, inhaltMaxW, inhaltMaxH);

  const minX = marginPx;
  const minY = marginPx;
  const maxX = out.width - marginPx - source.width;
  const maxY = out.height - marginPx - source.height;

  let x = Math.round((out.width - source.width) / 2);
  let y = Math.round((out.height - source.height) / 2);
  if (maxX >= minX) {
    x = Math.max(minX, Math.min(maxX, x));
  }
  if (maxY >= minY) {
    y = Math.max(minY, Math.min(maxY, y));
  }

  ctx.drawImage(source, x, y);
  return out;
}

async function normalizeImageOrientation(cal, imageCanvas) {
  return {
    canvas: imageCanvas,
    mirrored: false,
    ocrWordsNormal: (window.appState && appState.outputOcrNormalWords) || [],
    ocrWordsMirrored: (window.appState && appState.outputOcrMirroredWords) || [],
  };
}
