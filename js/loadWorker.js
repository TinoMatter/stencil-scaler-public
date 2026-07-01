/**
 * js/loadWorker.js
 * Web Worker for offloading file-to-canvas conversion (PDF or image) using OffscreenCanvas.
 */
// Polyfill document for PDF.js inside Web Worker context
if (typeof document === 'undefined') {
  self.document = {
    createElement(name) {
      if (name === 'canvas') {
        return new OffscreenCanvas(1, 1);
      }
      return {
        style: {},
        setAttribute() {},
        appendChild() {},
      };
    }
  };
}

// Load PDF.js core and its worker in this Worker context
importScripts('../vendor/pdf.min.js', '../vendor/pdf.worker.min.js');
// Configure PDF.js to use its own worker script for decoding
pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.js';

self.onmessage = async (e) => {
  const { id, arrayBuffer, fileType, fileName } = e.data;
  try {
    let offscreen;
    let sourceMeta;
    if (fileType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
      const doc = await pdfjsLib.getDocument({
        data: arrayBuffer,
        disableFontFace: true,
      }).promise;
      const page = await doc.getPage(1);
      const scale = 3.0; // Render scale matching test suite for high accuracy
      const viewport = page.getViewport({ scale });
      offscreen = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = offscreen.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, offscreen.width, offscreen.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const view = page.view || [0, 0, viewport.width / scale, viewport.height / scale];
      const pageBreitePt = Math.abs((view[2] || 0) - (view[0] || 0));
      const pageHöhePt = Math.abs((view[3] || 0) - (view[1] || 0));
      sourceMeta = {
        filename: fileName,
        isPdf: true,
        pageIndex: 1,
        pageBreitePt,
        pageHöhePt,
        renderScale: scale,
        sourceWidthPx: Math.ceil(viewport.width),
        sourceHeightPx: Math.ceil(viewport.height),
      };
    } else {
      const blob = new Blob([arrayBuffer], { type: fileType });
      const bitmap = await createImageBitmap(blob);
      offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = offscreen.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, offscreen.width, offscreen.height);
      ctx.drawImage(bitmap, 0, 0);
      sourceMeta = { filename: fileName, isPdf: false, pageIndex: 1 };
    }
    const imageBitmap = offscreen.transferToImageBitmap();
    self.postMessage({ id, bitmap: imageBitmap, sourceMeta }, [imageBitmap]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};