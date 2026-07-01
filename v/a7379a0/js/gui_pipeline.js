/**
 * js/gui_pipeline.js
 * Encapsulates the GUI-specific image preparation pipeline.
 */

 (function (env) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const helpers = isNode ? require('./image-utils.js') : env;
  const { cropAndScaleStencilIfPossible, deskew: deskewFn } = helpers;
  // OpenCV.js loaded in Node for headless pipeline
  const cv = isNode ? (env.cv || require('../vendor/opencv.js')) : env.cv;

/**
 * Prepares a raw image for detection by cropping, deskewing, and rotating.
 * This represents the current GUI-only pipeline.
 * 
 * @param {HTMLCanvasElement} sourceCanvas - The raw input canvas.
 * @param {Object} sourceMeta - Metadata about the source file.
 * @returns {Promise<{baseMat: cv.Mat, flippedMat: cv.Mat, angle: number, canvas: HTMLCanvasElement, cropX: number, cropY: number, scale: number}>} An object containing the prepared Mats, rotation angle, cropped canvas, crop offsets, and scale factor.
 */
async function prepareImageForDetection(sourceCanvas, sourceMeta) {
  let currentCanvas = sourceCanvas;

  if (typeof setUploadProgress === "function") {
    setUploadProgress(30);
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  // 1. Auto-Crop (capture offsets for ground truth mapping)
  let cropX = 0, cropY = 0, scale = 1;
  const cropRes = await cropAndScaleStencilIfPossible(currentCanvas);
  if (cropRes.canvas !== currentCanvas) {
    currentCanvas = cropRes.canvas;
    cropX = cropRes.x;
    cropY = cropRes.y;
    scale = cropRes.scale || 1;
  }

  if (typeof setUploadProgress === "function") {
    setUploadProgress(50);
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  // 2. Deskew
  const src = cv.imread(currentCanvas);
  const croppedWidth = src.cols;
  const croppedHeight = src.rows;
  const deskewRes = deskewFn(src);
  src.delete();

  const baseMat = deskewRes.mat;

  if (typeof setUploadProgress === "function") {
    setUploadProgress(65);
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  // 3. Rotation (180 degrees)
  const flippedMat = new cv.Mat();
  cv.rotate(baseMat, flippedMat, cv.ROTATE_180);

  if (typeof setUploadProgress === "function") {
    setUploadProgress(75);
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  // Return the prepared data with crop offsets
  return {
    baseMat,
    flippedMat,
    angle: deskewRes.angle || 0,
    canvas: currentCanvas, // Return the cropped canvas for UI updates
    cropX,
    cropY,
    scale,
    croppedWidth,
    croppedHeight
  };
}

  if (isNode) {
    module.exports = { prepareImageForDetection };
  }

  if (env) {
    env.prepareImageForDetection = prepareImageForDetection;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
