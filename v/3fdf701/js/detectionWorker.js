/**
 * js/detectionWorker.js
 * Web Worker for non-blocking scale line detection using OpenCV.js.
 */

// 1. Polyfills for headless environment
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

if (typeof window === 'undefined') {
  self.window = self;
}

if (typeof HTMLImageElement === 'undefined') {
  self.HTMLImageElement = class HTMLImageElement {};
}
if (typeof HTMLCanvasElement === 'undefined') {
  self.HTMLCanvasElement = class HTMLCanvasElement {
    static [Symbol.hasInstance](instance) {
      return instance && typeof instance.getContext === 'function';
    }
  };
}
if (typeof HTMLVideoElement === 'undefined') {
  self.HTMLVideoElement = class HTMLVideoElement {};
}

// 2. Load OpenCV first
importScripts('../vendor/opencv.js');

// 3. Monitor OpenCV loading state and import dependencies once cv is fully bound
let cvLoaded = false;
const cvReadyPromise = new Promise((resolve) => {
  function checkOpenCvReady() {
    if (typeof cv !== 'undefined' && typeof cv.Mat === 'function') {
      cvLoaded = true;
      
      // Import dependent scripts now that OpenCV has successfully initialized
      const search = self.location.search || '';
      importScripts('image-utils.js' + search);
      importScripts('candidate-ranking.js' + search);
      importScripts('ruler-detector.js' + search);
      importScripts('keystone.js' + search);
      importScripts('gui_pipeline.js' + search);
      
      self.postMessage({ type: 'cvReady' });
      resolve();
    } else {
      setTimeout(checkOpenCvReady, 30);
    }
  }
  checkOpenCvReady();
});

// Define global setUploadProgress inside worker to automatically catch progress reports
self.setUploadProgress = function(percent) {
  self.postMessage({ type: 'progress', percent });
};

// 4. Handle incoming messages
self.onmessage = async (e) => {
  const { type, width, height, buffer, sourceMeta, rulerLengthMm } = e.data;

  if (type === 'detect') {
    try {
      // Await OpenCV ready state and script imports
      await cvReadyPromise;

      // Recreate ImageData from transferred buffer
      const sourceCanvas = new OffscreenCanvas(width, height);
      const ctx = sourceCanvas.getContext('2d');
      const imgData = ctx.createImageData(width, height);
      imgData.data.set(new Uint8ClampedArray(buffer));
      ctx.putImageData(imgData, 0, 0);

      // Preprocess image (Auto-Crop, Deskew, Rotate)
      const prep = await prepareImageForDetection(sourceCanvas, sourceMeta);

      if (sourceMeta) {
        sourceMeta.scale = prep.scale || 1;
        sourceMeta.cropX = prep.cropX || 0;
        sourceMeta.cropY = prep.cropY || 0;
      }

      const candidates = [];
      const tryDetect = (mat, label) => {
        const ruler = detect(mat, sourceMeta, rulerLengthMm);
        if (!ruler) return;
        candidates.push({
          detection: ruler,
          mat,
          label,
        });
      };

      // Keystone Tier B: optional full-page perspective rectification for photos.
      // Detection runs on the rectified working image; endpoints are mapped back
      // to the un-warped base space later, so display/GT stay unchanged.
      let keystonePlan = null;
      let keystoneFlipped = null;
      if (self.keystone && (!sourceMeta || !sourceMeta.isPdf)) {
        try {
          keystonePlan = self.keystone.estimatePagePerspective(prep.baseMat);
        } catch (e) {
          keystonePlan = null;
        }
      }
      let detBase = prep.baseMat;
      let detFlipped = prep.flippedMat;
      if (keystonePlan && keystonePlan.warpedBase) {
        detBase = keystonePlan.warpedBase;
        keystoneFlipped = new cv.Mat();
        cv.rotate(keystonePlan.warpedBase, keystoneFlipped, cv.ROTATE_180);
        detFlipped = keystoneFlipped;
      }

      if (typeof setUploadProgress === "function") {
        setUploadProgress(80);
      }
      tryDetect(detBase, "");

      if (typeof setUploadProgress === "function") {
        setUploadProgress(90);
      }
      tryDetect(detFlipped, "[rot180] ");

      if (typeof setUploadProgress === "function") {
        setUploadProgress(100);
      }

      if (!candidates.length) {
        prep.baseMat.delete();
        prep.flippedMat.delete();
        throw new Error("Keine Skalierungslinie gefunden");
      }

      // Sort candidates (identical to app.js sorting)
      const ranking = (typeof globalThis !== 'undefined' && globalThis.candidateRanking)
        ? globalThis.candidateRanking
        : self.candidateRanking;
      candidates.sort((a, b) => {
        const da = a.detection;
        const db = b.detection;
        const isPhoto = !sourceMeta || !sourceMeta.isPdf;
        const aDx = Math.abs(da.p12.x - da.p0.x);
        const aDy = Math.abs(da.p12.y - da.p0.y);
        const bDx = Math.abs(db.p12.x - db.p0.x);
        const bDy = Math.abs(db.p12.y - db.p0.y);
        const aVertical = aDy > aDx;
        const bVertical = bDy > bDx;
        const aWeakOcrOrientation = Boolean(
          sourceMeta && sourceMeta.isPdf &&
          aVertical &&
          da.orientationDebug &&
          da.orientationDebug.ocrStart &&
          da.orientationDebug.ocrMatchedCount === 0 &&
          typeof da.orientationDebug.snapMode === 'string' &&
          da.orientationDebug.snapMode.includes('+ocr-reverted')
        );
        const bWeakOcrOrientation = Boolean(
          sourceMeta && sourceMeta.isPdf &&
          bVertical &&
          db.orientationDebug &&
          db.orientationDebug.ocrStart &&
          db.orientationDebug.ocrMatchedCount === 0 &&
          typeof db.orientationDebug.snapMode === 'string' &&
          db.orientationDebug.snapMode.includes('+ocr-reverted')
        );

        const ma = da.ocrDigits ? da.ocrDigits.filter(d => d.matched).length : 0;
        const mb = db.ocrDigits ? db.ocrDigits.filter(d => d.matched).length : 0;
        const strongMa = ma >= 2 ? ma : 0;
        const strongMb = mb >= 2 ? mb : 0;
        if (strongMa !== strongMb) return strongMb - strongMa;
        
        const aMatchesHint = (da.detectedLengthMm === rulerLengthMm);
        const bMatchesHint = (db.detectedLengthMm === rulerLengthMm);
        if (aMatchesHint && !bMatchesHint) return -1;
        if (!aMatchesHint && bMatchesHint) return 1;

        if (aWeakOcrOrientation && bWeakOcrOrientation) {
          const aLineFallback = Boolean(da.method && da.method.includes('Linien-Fallback'));
          const bLineFallback = Boolean(db.method && db.method.includes('Linien-Fallback'));
          const aRot180 = Boolean(a.label && a.label.includes('[rot180]'));
          const bRot180 = Boolean(b.label && b.label.includes('[rot180]'));
          const scoreGap = Math.abs((da.score || 0) - (db.score || 0));
          if (aLineFallback && bLineFallback && aRot180 !== bRot180 && scoreGap <= 25) {
            return aRot180 ? 1 : -1;
          }
          if (aRot180 !== bRot180 && scoreGap <= 25) {
            return aRot180 ? -1 : 1;
          }
        }

        if (isPhoto && aMatchesHint && bMatchesHint && strongMa === 0 && strongMb === 0) {
          const t = ranking.comparePhotoHorizontalTieBreaks(
            {
              dx: aDx, dy: aDy, score: da.score || 0,
              detectedLengthMm: da.detectedLengthMm,
              isBand: Boolean(da.isBand),
              isLineFallback: Boolean(da.method && da.method.includes('Linien-Fallback')),
              isTick: Boolean(da.method && da.method.includes('Tick-Cluster')),
              hasEndpointTicks: Boolean(da.orientationDebug && typeof da.orientationDebug.snapMode === 'string' && da.orientationDebug.snapMode.includes('+endpoint-ticks')),
              frameMaxDim: Math.max(a.mat.cols, a.mat.rows),
            },
            {
              dx: bDx, dy: bDy, score: db.score || 0,
              detectedLengthMm: db.detectedLengthMm,
              isBand: Boolean(db.isBand),
              isLineFallback: Boolean(db.method && db.method.includes('Linien-Fallback')),
              isTick: Boolean(db.method && db.method.includes('Tick-Cluster')),
              hasEndpointTicks: Boolean(db.orientationDebug && typeof db.orientationDebug.snapMode === 'string' && db.orientationDebug.snapMode.includes('+endpoint-ticks')),
              frameMaxDim: Math.max(b.mat.cols, b.mat.rows),
            }
          );
          if (t !== 0) return t;
        }

        if (isPhoto && aMatchesHint && bMatchesHint && strongMa === 0 && strongMb === 0) {
          const aHorizontal = aDx >= aDy;
          const bHorizontal = bDx >= bDy;
          const scoreGap = Math.abs((da.score || 0) - (db.score || 0));
          if (aHorizontal && bHorizontal && scoreGap <= 80) {
            const aMinMargin = Math.min(da.p0.x, da.p12.x, a.mat.cols - 1 - da.p0.x, a.mat.cols - 1 - da.p12.x);
            const bMinMargin = Math.min(db.p0.x, db.p12.x, b.mat.cols - 1 - db.p0.x, b.mat.cols - 1 - db.p12.x);
            if (Math.abs(aMinMargin - bMinMargin) >= 10) {
              return bMinMargin - aMinMargin;
            }
          }
        }

        const aSpanErr = Number.isFinite(da.expectedSpanError) ? da.expectedSpanError : Number.POSITIVE_INFINITY;
        const bSpanErr = Number.isFinite(db.expectedSpanError) ? db.expectedSpanError : Number.POSITIVE_INFINITY;
        if ((!sourceMeta || !sourceMeta.isPdf) && aSpanErr !== bSpanErr) return aSpanErr - bSpanErr;

        if (da.reliable && !db.reliable) return -1;
        if (!da.reliable && db.reliable) return 1;

        const scoreGap = Math.abs((da.score || 0) - (db.score || 0));
        if (scoreGap > 8) return (db.score || 0) - (da.score || 0);

        const aIsTick = da.method && da.method.includes("Tick-Cluster");
        const bIsTick = db.method && db.method.includes("Tick-Cluster");
        if (aIsTick !== bIsTick) {
          if (isPhoto && aMatchesHint && bMatchesHint && strongMa === 0 && strongMb === 0) {
            const aHorizontal = aDx >= aDy;
            const bHorizontal = bDx >= bDy;
            const aWeakOrientation = !(da.orientationDebug && da.orientationDebug.ocrStart);
            const bWeakOrientation = !(db.orientationDebug && db.orientationDebug.ocrStart);
            if (aHorizontal && bHorizontal && aWeakOrientation && bWeakOrientation) {
              return aIsTick ? -1 : 1;
            }
          }
          return aIsTick ? -1 : 1;
        }
        return (db.score || 0) - (da.score || 0);
      });

      const best = candidates[0];

      // When keystone rectification was applied, always display the un-warped
      // base image; detected endpoints are mapped back into that space below.
      const displayMat = (keystonePlan || (best.label && best.label.includes('[rot180]')))
        ? prep.baseMat
        : best.mat;

      // Draw final display mat to OffscreenCanvas in the same coordinate space
      // as the returned endpoints.
      const outputCanvas = new OffscreenCanvas(displayMat.cols, displayMat.rows);
      cv.imshow(outputCanvas, displayMat);

      let p0 = best.detection.p0;
      let p12 = best.detection.p12;
      // If detection came from the flipped (rot180) image, transform coordinates back
      // to the base-mat orientation so they stay aligned with displayMat/previews.
      if (best.label && best.label.includes('[rot180]')) {
        const w = best.mat.cols;
        const h = best.mat.rows;
        // 180° rotation: invert both x and y
        const p0Rot = { x: w - p0.x, y: h - p0.y };
        const p12Rot = { x: w - p12.x, y: h - p12.y };
        // Swap points to restore original start/end order
        p0 = p12Rot;
        p12 = p0Rot;
      }

      // Keystone Tier B: map endpoints from the rectified working space back to
      // the un-warped base space so all downstream logic stays unchanged.
      if (keystonePlan && self.keystone) {
        p0 = self.keystone.mapCorrectedToBase(p0, keystonePlan);
        p12 = self.keystone.mapCorrectedToBase(p12, keystonePlan);
      }

      const orientationDebug = best.detection.orientationDebug || null;
      const dx = p12.x - p0.x;
      const dy = p12.y - p0.y;
      const isHorizontal = Math.abs(dx) >= Math.abs(dy);
      const hasStrongOrientationEvidence = Boolean(
        orientationDebug && (
          orientationDebug.ocrStart ||
          (orientationDebug.ocrMatchedCount || 0) >= 2
        )
      );

      if (isHorizontal && !hasStrongOrientationEvidence) {
        const midY = (p0.y + p12.y) / 2;
        const shouldPlaceZeroOnRight = midY > outputCanvas.height * 0.5;
        const zeroIsCurrentlyOnRight = p0.x > p12.x;
        if (shouldPlaceZeroOnRight !== zeroIsCurrentlyOnRight) {
          const tmp = p0;
          p0 = p12;
          p12 = tmp;
        }

        // Keep weak-evidence horizontal lines directionally consistent with layout
        // and cap excessive tiny-perspective tilt on shorter rulers.
        const weakDy = p12.y - p0.y;
        if (Math.abs(weakDy) <= 8) {
          const absDx = Math.abs(p12.x - p0.x);
          const maxWeakAbsDy = Math.max(1.5, absDx * 0.008);
          let adjustedDy = weakDy;
          if (Math.abs(adjustedDy) > maxWeakAbsDy) {
            adjustedDy = Math.sign(adjustedDy) * maxWeakAbsDy;
          }

          // Only force dy sign on shorter rulers where tiny perspective swings
          // are unstable; keep long-ruler tilt sign from raw detector output.
          if (absDx < 600) {
            const wantNegativeDy = shouldPlaceZeroOnRight;
            const dyHasCorrectSign = wantNegativeDy ? (adjustedDy <= 0) : (adjustedDy >= 0);
            if (!dyHasCorrectSign) {
              adjustedDy = wantNegativeDy
                ? -Math.max(Math.abs(adjustedDy), 1.0)
                : Math.max(Math.abs(adjustedDy), 1.0);
            }
          }

          const midTiltY = (p0.y + p12.y) / 2;
          p0 = { ...p0, y: midTiltY - adjustedDy / 2 };
          p12 = { ...p12, y: midTiltY + adjustedDy / 2 };
        }
      }

      // Centralized in the keystone module (was two inlined perspective hacks).
      if (self.keystone && self.keystone.applyTopPhotoPerspectiveShift) {
        const shifted = self.keystone.applyTopPhotoPerspectiveShift({
          p0,
          p12,
          width: outputCanvas.width,
          height: outputCanvas.height,
          isHorizontal,
          isPhoto: (!sourceMeta || !sourceMeta.isPdf),
          isRot180: Boolean(best.label && best.label.includes('[rot180]')),
          methodHasOcr: Boolean(best.detection.method && best.detection.method.includes('+ocr')),
          ocrStart: Boolean(orientationDebug && orientationDebug.ocrStart),
          ocrMatchedCount: orientationDebug ? (orientationDebug.ocrMatchedCount || 0) : 0,
        });
        p0 = shifted.p0;
        p12 = shifted.p12;
      }

      // Keystone Tier C/D: when no full-page rectification fired, apply a gentle
      // ruler-local / tick-spacing perspective correction for photos. These tiers
      // need angled-photo ground truth to calibrate, so they stay behind an
      // explicit opt-in (sourceMeta.keystoneRefine) to avoid disturbing
      // near-frontal inputs. Tier B (full-page rectification) remains always-on.
      if (
        !keystonePlan &&
        self.keystone &&
        (!sourceMeta || !sourceMeta.isPdf) &&
        sourceMeta && sourceMeta.keystoneRefine === true
      ) {
        try {
          const refined = self.keystone.refineEndpoints(displayMat, p0, p12);
          if (refined && refined.tier && refined.tier !== 'none') {
            p0 = refined.p0;
            p12 = refined.p12;
          }
        } catch (e) {
          // refinement is best-effort; ignore failures
        }
      }

      const result = {
        p0,
        p12,
        method: best.label + best.detection.method,
        lineReliable: Boolean(best.detection.reliable),
        angleDeg: prep.angle || 0,
        detectedLengthMm: best.detection.detectedLengthMm || rulerLengthMm,
        ocrWordsNormal: [],
        ocrWordsMirrored: [],
        mirrored: best.label !== "",
        ocrDigits: best.detection.ocrDigits || [],
        orientationDebug,
        candidateDebug: candidates.map((candidate, index) => ({
          rank: index + 1,
          label: candidate.label || '[current] ',
          method: candidate.detection.method,
          reliable: Boolean(candidate.detection.reliable),
          score: candidate.detection.score || 0,
          detectedLengthMm: candidate.detection.detectedLengthMm || rulerLengthMm,
          ocrMatches: candidate.detection.ocrDigits ? candidate.detection.ocrDigits.filter(digit => digit.matched).length : 0,
          candidates: candidate.detection.candidateDebug || [],
        })),
        isFlipped: best.label !== "",
        cropX: prep.cropX || 0,
        cropY: prep.cropY || 0,
        scale: prep.scale || 1,
        sourceWidthPx: sourceMeta && Number.isFinite(sourceMeta.sourceWidthPx) ? sourceMeta.sourceWidthPx : width,
        sourceHeightPx: sourceMeta && Number.isFinite(sourceMeta.sourceHeightPx) ? sourceMeta.sourceHeightPx : height,
        croppedWidth: prep.croppedWidth || prep.baseMat.cols,
        croppedHeight: prep.croppedHeight || prep.baseMat.rows,
      };
      // Cleanup Mats
      if (keystonePlan && keystonePlan.warpedBase) keystonePlan.warpedBase.delete();
      if (keystoneFlipped) keystoneFlipped.delete();
      prep.baseMat.delete();
      prep.flippedMat.delete();

      // Transfer buffer back to main thread
      const outputCtx = outputCanvas.getContext('2d');
      const outputImgData = outputCtx.getImageData(0, 0, outputCanvas.width, outputCanvas.height);
      const outBuffer = outputImgData.data.buffer;
      self.postMessage({
        type: "success",
        result,
        width: outputCanvas.width,
        height: outputCanvas.height,
        buffer: outBuffer
      }, [outBuffer]);

    } catch (err) {
      self.postMessage({
        type: "error",
        error: err.message || String(err)
      });
    }
  }
};
