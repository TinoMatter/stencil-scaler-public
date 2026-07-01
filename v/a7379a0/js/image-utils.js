/**
 * js/image-utils.js
 * OpenCV-based and canvas-based image processing helpers.
 */

 (function (env) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const cv = isNode ? (env.cv || require('../vendor/opencv.js')) : env.cv;


  const MM_TO_PT = 72 / 25.4;

/**
 * Deskew the given Mat by detecting dominant line angles and rotating it with frame adjustment.
 * @param {cv.Mat} src - Source image Mat (RGBA) to deskew.
 * @returns {{mat: cv.Mat, angle: number}} Rotated Mat and detected rotation angle in degrees.
 */
function deskew(src) {
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const lines = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, gray, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.Canny(gray, edges, 50, 150, 3, false);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 50, src.cols * 0.1, 15);

    const winkel = [];
    for (let i = 0; i < lines.rows; i += 1) {
      const x1 = lines.data32S[i * 4 + 0];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < src.cols * 0.1) continue;

      let deg = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg < -90) deg += 180;
      if (Math.abs(deg) <= 35) {
        winkel.push(deg);
      } else if (Math.abs(deg) >= 55) {
        const dev = (deg > 0) ? deg - 90 : deg + 90;
        winkel.push(dev);
      }
    }

    const medianWinkel = winkel.length ? median(winkel) : 0;
    if (Math.abs(medianWinkel) < 0.01) {
      return { mat: src.clone(), angle: 0 };
    }
    const rotated = rotateWithFrame(src, -medianWinkel);
    return { mat: rotated, angle: -medianWinkel };
  } finally {
    gray.delete();
    edges.delete();
    lines.delete();
  }
}

/**
 * Rotate the source Mat by angleDeg degrees, expanding the frame to avoid clipping.
 * @param {cv.Mat} src - Source image Mat to rotate.
 * @param {number} angleDeg - Rotation angle in degrees (positive = clockwise).
 * @returns {cv.Mat} New Mat containing the rotated image.
 */
function rotateWithFrame(src, angleDeg) {
  const rad = Math.abs(angleDeg * Math.PI / 180);
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const newW = Math.ceil(src.rows * sin + src.cols * cos);
  const newH = Math.ceil(src.rows * cos + src.cols * sin);

  const center = new cv.Point(src.cols / 2, src.rows / 2);
  const rotMat = cv.getRotationMatrix2D(center, angleDeg, 1);
  rotMat.data64F[2] += newW / 2 - center.x;
  rotMat.data64F[5] += newH / 2 - center.y;

  const dst = new cv.Mat();
  cv.warpAffine(src, dst, rotMat, new cv.Size(newW, newH), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
  rotMat.delete();
  return dst;
}

/**
 * Auto-crop the stencil region from a canvas, pad edges, and optionally scale to a target width.
 * @param {HTMLCanvasElement} canvas - Input canvas to crop and scale.
 * @returns {Promise<{canvas: HTMLCanvasElement, x: number, y: number, scale: number}>} Cropped (and scaled) canvas,
 *          its top-left crop offsets, and the scale factor applied.
 */
async function cropAndScaleStencilIfPossible(canvas) {
  if (!window.cv || typeof cv.Mat !== "function") {
    return canvas;
  }

  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const thresh = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    // Clear outer 5% margins to remove scan borders/noise
    const marginX = Math.round(canvas.width * 0.05);
    const marginY = Math.round(canvas.height * 0.05);
    cv.rectangle(thresh, new cv.Point(0, 0), new cv.Point(canvas.width, marginY), new cv.Scalar(0), -1);
    cv.rectangle(thresh, new cv.Point(0, canvas.height - marginY), new cv.Point(canvas.width, canvas.height), new cv.Scalar(0), -1);
    cv.rectangle(thresh, new cv.Point(0, 0), new cv.Point(marginX, canvas.height), new cv.Scalar(0), -1);
    cv.rectangle(thresh, new cv.Point(canvas.width - marginX, 0), new cv.Point(canvas.width, canvas.height), new cv.Scalar(0), -1);

    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let maxArea = 0;
    let bestRect = null;
    const totalArea = canvas.width * canvas.height;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const rect = cv.boundingRect(cnt);
      const area = rect.width * rect.height;
      if (area > maxArea && area > totalArea * 0.1 && area < totalArea * 0.98) {
        maxArea = area;
        bestRect = rect;
      }
    }

    if (bestRect) {
      const padX = Math.max(600, Math.round(canvas.width * 0.30));
      const padY = Math.max(600, Math.round(canvas.height * 0.30));

      let x0 = Math.max(0, bestRect.x - padX);
      let y0 = Math.max(0, bestRect.y - padY);
      let x1 = Math.min(canvas.width, bestRect.x + bestRect.width + padX);
      let y1 = Math.min(canvas.height, bestRect.y + bestRect.height + padY);

      const cropW = x1 - x0;
      const cropH = y1 - y0;

      if (cropW > 100 && cropH > 100) {
        let cropped = src.roi(new cv.Rect(x0, y0, cropW, cropH));
        const targetW = 2000;
        let activeMat = cropped;
        let scale = 1;

        if (cropW < targetW) {
          scale = targetW / cropW;
          activeMat = new cv.Mat();
          cv.resize(cropped, activeMat, new cv.Size(targetW, Math.round(cropH * scale)), 0, 0, cv.INTER_LINEAR);
          cropped.delete();
        }

        const croppedCanvas = document.createElement("canvas");
        croppedCanvas.width = activeMat.cols;
        croppedCanvas.height = activeMat.rows;
        cv.imshow(croppedCanvas, activeMat);
        activeMat.delete();

        return { canvas: croppedCanvas, x: x0, y: y0, scale };
      }
    }
  } catch (err) {
    console.error("Auto-Crop failed: ", err);
  } finally {
    src.delete();
    gray.delete();
    thresh.delete();
    contours.delete();
    hierarchy.delete();
  }

  return { canvas, x: 0, y: 0, scale: 1 };
}

function trimWhiteMargins(canvas, threshold = 246) {
  const ctx = canvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const idx = (y * canvas.width + x) * 4;
      const r = data[idx];
      const g = data[idx+1];
      const b = data[idx+2];
      if (r < threshold || g < threshold || b < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { canvas, x: 0, y: 0 };
  }

  const pad = 5;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(canvas.width - 1, maxX + pad);
  maxY = Math.min(canvas.height - 1, maxY + pad);

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const outCtx = out.getContext("2d");
  outCtx.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);

  return { canvas: out, x: minX, y: minY };
}

function centerCropCanvas(canvas, maxW, maxH) {
  if (canvas.width <= maxW && canvas.height <= maxH) {
    return canvas;
  }

  const w = Math.max(1, Math.min(canvas.width, maxW));
  const h = Math.max(1, Math.min(canvas.height, maxH));
  const sx = Math.max(0, Math.floor((canvas.width - w) / 2));
  const sy = Math.max(0, Math.floor((canvas.height - h) / 2));

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d", { alpha: false });
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, w, h);
  octx.drawImage(canvas, sx, sy, w, h, 0, 0, w, h);
  return out;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Bild konnte nicht geladen werden."));
    img.src = src;
  });
}

function canvasToBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("Canvas konnte nicht umgewandelt werden."));
        return;
      }
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, "image/png", 1);
  });
}

async function imageFileToCanvas(file) {
  // Load image via object URL to avoid createImageBitmap issues across browsers
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  return canvas;
}

async function pdfFirstPageToCanvas(file) {
  const data = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const page = await doc.getPage(1);

  const scale = 3.0; // Render scale matching test suite for high accuracy
  const viewport = page.getViewport({ scale });
  const view = page.view || [0, 0, viewport.width / scale, viewport.height / scale];
  const pageBreitePt = Math.abs((view[2] || 0) - (view[0] || 0));
  const pageHöhePt = Math.abs((view[3] || 0) - (view[1] || 0));

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    canvas,
    sourceMeta: { filename: file.name,
      isPdf: true,
      pageIndex: 1,
      pageBreitePt,
      pageHöhePt,
      renderScale: scale,
      sourceWidthPx: canvas.width,
      sourceHeightPx: canvas.height,
    }
  };
}

async function loadFileAsSource(file) {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return await pdfFirstPageToCanvas(file);
  }

  if (file.type.startsWith("image/") || /\.(jpg|jpeg|png)$/i.test(file.name)) {
    return {
      canvas: await imageFileToCanvas(file),
      sourceMeta: { filename: file.name, isPdf: false, pageIndex: 1 }
    };
  }

  throw new Error("Dateityp nicht unterstützt.");
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function median(values) {
  if (!values.length) return 0;
  const copy = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(copy.length / 2);
  return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}

function distance(a, b) {
  return Math.hypot((b.x - a.x), (b.y - a.y));
}

  if (isNode) {
    module.exports = {
      deskew,
      rotateWithFrame,
      cropAndScaleStencilIfPossible,
      trimWhiteMargins,
      centerCropCanvas,
      loadImage,
      canvasToBytes,
      imageFileToCanvas,
      pdfFirstPageToCanvas,
      loadFileAsSource,
      quantile,
      median,
      distance
    };
  } else {
    env.deskew = deskew;
    env.rotateWithFrame = rotateWithFrame;
    env.cropAndScaleStencilIfPossible = cropAndScaleStencilIfPossible;
    env.trimWhiteMargins = trimWhiteMargins;
    env.centerCropCanvas = centerCropCanvas;
    env.loadImage = loadImage;
    env.canvasToBytes = canvasToBytes;
    env.imageFileToCanvas = imageFileToCanvas;
    env.pdfFirstPageToCanvas = pdfFirstPageToCanvas;
    env.loadFileAsSource = loadFileAsSource;
    env.quantile = quantile;
    env.median = median;
    env.distance = distance;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
