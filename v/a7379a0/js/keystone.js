/**
 * js/keystone.js
 * Self-contained perspective ("keystone") correction module.
 *
 * This module is intentionally decoupled from the ruler-detection algorithm.
 * It exposes a small, explicit API and never mutates detector state. The
 * detection pipeline calls into it, but the detector itself contains no
 * keystone logic.
 *
 * Cascade (strongest correction that has enough evidence wins):
 *   Tier B  pre-detection full-page homography     (needs 4 sheet corners)
 *   Tier C  post-detection ruler-band perspective  (needs both long ruler edges)
 *   Tier D  post-detection tick-spacing correction (needs major-tick gradient)
 *   none    identity (current behavior)
 *
 * Design contract:
 *   - Display + ground-truth coordinate space stays the UN-warped processed
 *     space. Tier B warps only an internal working image for detection and
 *     maps detected endpoints back through the inverse homography, so nothing
 *     downstream (preview overlay, GT mapping) needs to change.
 *   - Every tier returns a confidence in [0,1]. A tier only fires when its
 *     confidence clears a threshold AND a real perspective signal is present,
 *     so near-frontal scans/photos are left untouched.
 */

(function (env) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const cv = isNode ? (env.cv || require('../vendor/opencv.js')) : env.cv;

  // --- Tunable gates -------------------------------------------------------
  // Kept conservative on purpose: the goal is to never disturb images that are
  // already (near) frontal, and only engage on clearly angled photos.
  const TIER_B_MIN_CONFIDENCE = 0.6;
  const TIER_B_MIN_AREA_FRAC = 0.18;   // quad must cover >=18% of frame
  const TIER_B_MAX_AREA_FRAC = 0.97;   // but not be the whole frame (= no border)
  const TIER_B_MIN_SKEW = 0.06;        // min opposite-side foreshortening to bother
  const TIER_C_MIN_SKEW = 0.012;       // min edge convergence to engage
  const TIER_D_MIN_GRADIENT = 0.04;    // min tick-spacing gradient to engage

  // --- Small geometry helpers ---------------------------------------------

  function orderQuad(points) {
    // Returns corners ordered: top-left, top-right, bottom-right, bottom-left.
    const pts = points.slice();
    const bySum = pts.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const byDiff = pts.slice().sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const tl = bySum[0];
    const br = bySum[bySum.length - 1];
    const tr = byDiff[0];
    const bl = byDiff[byDiff.length - 1];
    return [tl, tr, br, bl];
  }

  function dist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  // Invert a 3x3 matrix given as a flat length-9 array (row-major).
  function invert3x3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    return [
      A * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet,
      B * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet,
      C * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet,
    ];
  }

  // Apply a flat 3x3 homography to a point.
  function applyHomography(m, pt) {
    const x = m[0] * pt.x + m[1] * pt.y + m[2];
    const y = m[3] * pt.x + m[4] * pt.y + m[5];
    const w = m[6] * pt.x + m[7] * pt.y + m[8];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return { x: pt.x, y: pt.y };
    return { x: x / w, y: y / w };
  }

  // --- Tier B: full-page quad detection + homography -----------------------

  /**
   * Detect the document-sheet quadrilateral in a Mat.
   * @returns {{corners: Array<{x,y}>, areaFrac: number, skew: number} | null}
   */
  function detectPageQuad(mat) {
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let best = null;

    try {
      cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      cv.Canny(blurred, edges, 50, 150, 3, false);
      cv.dilate(edges, edges, cv.Mat.ones(3, 3, cv.CV_8U));
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const frameArea = mat.cols * mat.rows;
      let bestArea = 0;

      for (let i = 0; i < contours.size(); i += 1) {
        const cnt = contours.get(i);
        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, 0.02 * peri, approx, true);

        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const area = Math.abs(cv.contourArea(approx));
          const areaFrac = area / frameArea;
          if (
            areaFrac >= TIER_B_MIN_AREA_FRAC &&
            areaFrac <= TIER_B_MAX_AREA_FRAC &&
            area > bestArea
          ) {
            const corners = [];
            for (let k = 0; k < 4; k += 1) {
              corners.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
            }
            bestArea = area;
            best = { corners: orderQuad(corners), areaFrac };
          }
        }
        approx.delete();
        cnt.delete();
      }
    } catch (err) {
      // Detection is best-effort; never throw into the pipeline.
      best = null;
    } finally {
      gray.delete();
      blurred.delete();
      edges.delete();
      contours.delete();
      hierarchy.delete();
    }

    if (!best) return null;

    // Foreshortening / skew: how much opposite sides differ in length.
    const [tl, tr, br, bl] = best.corners;
    const top = dist(tl, tr);
    const bottom = dist(bl, br);
    const left = dist(tl, bl);
    const right = dist(tr, br);
    const widthSkew = Math.abs(top - bottom) / Math.max(1, Math.max(top, bottom));
    const heightSkew = Math.abs(left - right) / Math.max(1, Math.max(left, right));
    best.skew = Math.max(widthSkew, heightSkew);
    return best;
  }

  /**
   * Build a pre-detection full-page rectification plan from sheet corners.
   * Warps an internal working Mat and returns the inverse map (corrected->base).
   * @returns {{tier:'B', warpedBase: cv.Mat, inverse: number[], confidence: number} | null}
   */
  function estimatePagePerspective(mat) {
    const quad = detectPageQuad(mat);
    if (!quad) return null;
    if (quad.skew < TIER_B_MIN_SKEW) return null; // already near-frontal

    // Confidence blends how rectangular/large the quad is with the skew signal.
    const areaScore = Math.min(1, quad.areaFrac / 0.5);
    const skewScore = Math.min(1, quad.skew / 0.25);
    const confidence = 0.5 * areaScore + 0.5 * skewScore;
    if (confidence < TIER_B_MIN_CONFIDENCE) return null;

    const [tl, tr, br, bl] = quad.corners;
    const maxWidth = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
    const maxHeight = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
    if (maxWidth < 50 || maxHeight < 50) return null;

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, maxWidth, 0, maxWidth, maxHeight, 0, maxHeight,
    ]);

    const H = cv.getPerspectiveTransform(srcTri, dstTri);
    const flat = Array.from(H.data64F); // base -> corrected
    const inverse = invert3x3(flat);    // corrected -> base

    const warpedBase = new cv.Mat();
    let result = null;
    if (inverse) {
      cv.warpPerspective(
        mat, warpedBase, H, new cv.Size(maxWidth, maxHeight),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255)
      );
      result = { tier: 'B', warpedBase, inverse, confidence };
    }

    srcTri.delete();
    dstTri.delete();
    H.delete();
    if (!result && warpedBase) warpedBase.delete();
    return result;
  }

  /**
   * Map a point from corrected (warped) space back to the un-warped base space.
   */
  function mapCorrectedToBase(pt, plan) {
    if (!plan || !plan.inverse) return { x: pt.x, y: pt.y };
    return applyHomography(plan.inverse, pt);
  }

  // --- Tier C: ruler-band perspective (post-detection) ---------------------

  /**
   * Estimate the two long ruler edges around the detected endpoints and, if
   * they visibly converge (perspective), correct the endpoints onto the
   * ruler-band centreline with foreshortening compensation.
   *
   * @param {cv.Mat} mat - un-warped base Mat the endpoints live in.
   * @param {{x,y}} p0 @param {{x,y}} p12
   * @returns {{p0:{x,y}, p12:{x,y}, applied:boolean, skew:number}}
   */
  function refineByRulerEdges(mat, p0, p12) {
    const dx = p12.x - p0.x;
    const dy = p12.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 40) return { p0, p12, applied: false, skew: 0 };

    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    // Sample the ruler band thickness at both ends by scanning perpendicular
    // for dark ink, to measure foreshortening between the two ends.
    const band = (cx, cy) => {
      const reach = Math.min(mat.rows, mat.cols) * 0.06;
      let top = 0;
      let bottom = 0;
      for (let s = 1; s <= reach; s += 1) {
        const tx = Math.round(cx + nx * s);
        const ty = Math.round(cy + ny * s);
        if (tx < 0 || ty < 0 || tx >= mat.cols || ty >= mat.rows) break;
        const px = mat.ucharPtr(ty, tx);
        if ((px[0] + px[1] + px[2]) / 3 < 120) bottom = s; else if (s - bottom > 6) break;
      }
      for (let s = 1; s <= reach; s += 1) {
        const tx = Math.round(cx - nx * s);
        const ty = Math.round(cy - ny * s);
        if (tx < 0 || ty < 0 || tx >= mat.cols || ty >= mat.rows) break;
        const px = mat.ucharPtr(ty, tx);
        if ((px[0] + px[1] + px[2]) / 3 < 120) top = s; else if (s - top > 6) break;
      }
      return top + bottom;
    };

    const t0 = band(p0.x, p0.y);
    const t12 = band(p12.x, p12.y);
    if (t0 < 2 || t12 < 2) return { p0, p12, applied: false, skew: 0 };

    const skew = Math.abs(t0 - t12) / Math.max(t0, t12);
    if (skew < TIER_C_MIN_SKEW) return { p0, p12, applied: false, skew };

    // Foreshortening correction: the visually narrower end is farther away, so
    // its tick spacing is compressed; nudge it outward proportionally so the
    // recovered span matches the true ruler length more closely.
    const ratio = t0 < t12 ? t12 / t0 : t0 / t12;
    const adjust = Math.min(0.02, (ratio - 1) * 0.04); // capped, gentle
    const mid = { x: (p0.x + p12.x) / 2, y: (p0.y + p12.y) / 2 };
    const grow = (p, far) => {
      const s = far ? (1 + adjust) : (1 - adjust * 0.25);
      return { x: mid.x + (p.x - mid.x) * s, y: mid.y + (p.y - mid.y) * s };
    };
    const p0Far = t0 < t12;
    return {
      p0: grow(p0, p0Far),
      p12: grow(p12, !p0Far),
      applied: true,
      skew,
    };
  }

  // --- Tier D: tick-spacing gradient correction (post-detection) -----------

  /**
   * Detect dark tick marks along the ruler axis and, if their spacing grows or
   * shrinks monotonically (perspective foreshortening), correct the endpoints
   * so the span reflects an even tick distribution.
   */
  function refineByTickSpacing(mat, p0, p12) {
    const dx = p12.x - p0.x;
    const dy = p12.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 60) return { p0, p12, applied: false, gradient: 0 };

    const ux = dx / len;
    const uy = dy / len;
    const samples = Math.max(40, Math.round(len));
    const profile = new Array(samples);
    for (let i = 0; i < samples; i += 1) {
      const t = i / (samples - 1);
      const sx = Math.round(p0.x + ux * len * t);
      const sy = Math.round(p0.y + uy * len * t);
      if (sx < 0 || sy < 0 || sx >= mat.cols || sy >= mat.rows) {
        profile[i] = 255;
      } else {
        const px = mat.ucharPtr(sy, sx);
        profile[i] = (px[0] + px[1] + px[2]) / 3;
      }
    }

    // Find local minima (ticks) as positions where intensity dips.
    const ticks = [];
    for (let i = 2; i < samples - 2; i += 1) {
      if (
        profile[i] < 140 &&
        profile[i] <= profile[i - 1] &&
        profile[i] <= profile[i + 1] &&
        profile[i] < profile[i - 2] &&
        profile[i] < profile[i + 2]
      ) {
        ticks.push(i);
      }
    }
    if (ticks.length < 6) return { p0, p12, applied: false, gradient: 0 };

    const gaps = [];
    for (let i = 1; i < ticks.length; i += 1) gaps.push(ticks[i] - ticks[i - 1]);
    if (gaps.length < 5) return { p0, p12, applied: false, gradient: 0 };

    // Linear trend of gap size across the ruler: a non-zero slope indicates
    // perspective foreshortening along the axis.
    const n = gaps.length;
    const meanIdx = (n - 1) / 2;
    const meanGap = gaps.reduce((a, b) => a + b, 0) / n;
    let cov = 0;
    let varIdx = 0;
    for (let i = 0; i < n; i += 1) {
      cov += (i - meanIdx) * (gaps[i] - meanGap);
      varIdx += (i - meanIdx) * (i - meanIdx);
    }
    const slope = varIdx > 0 ? cov / varIdx : 0;
    const gradient = meanGap > 0 ? Math.abs(slope * n) / meanGap : 0;
    if (gradient < TIER_D_MIN_GRADIENT) return { p0, p12, applied: false, gradient };

    // Nudge the compressed end (smaller gaps) outward to even out spacing.
    const firstHalf = gaps.slice(0, Math.floor(n / 2)).reduce((a, b) => a + b, 0);
    const secondHalf = gaps.slice(Math.ceil(n / 2)).reduce((a, b) => a + b, 0);
    const p0End = firstHalf < secondHalf; // p0 side is compressed
    const adjust = Math.min(0.02, gradient * 0.15);
    const mid = { x: (p0.x + p12.x) / 2, y: (p0.y + p12.y) / 2 };
    const grow = (p, far) => {
      const s = far ? (1 + adjust) : 1;
      return { x: mid.x + (p.x - mid.x) * s, y: mid.y + (p.y - mid.y) * s };
    };
    return {
      p0: grow(p0, p0End),
      p12: grow(p12, !p0End),
      applied: true,
      gradient,
    };
  }

  /**
   * Post-detection refinement cascade (C then D). Operates on the un-warped
   * base Mat and the final endpoints. Returns endpoints unchanged unless a
   * tier engaged with a real perspective signal.
   */
  function refineEndpoints(mat, p0, p12) {
    if (!mat || !p0 || !p12) return { p0, p12, tier: 'none' };

    const c = refineByRulerEdges(mat, p0, p12);
    if (c.applied) {
      return { p0: c.p0, p12: c.p12, tier: 'C', signal: c.skew };
    }
    const d = refineByTickSpacing(mat, p0, p12);
    if (d.applied) {
      return { p0: d.p0, p12: d.p12, tier: 'D', signal: d.gradient };
    }
    return { p0, p12, tier: 'none' };
  }

  // --- Top-of-page photo perspective shift ---------------------------------

  /**
   * Flipped top-ruler photos can land on a ruler edge slightly above the tick
   * baseline; this nudges the endpoints down and applies an approximate
   * perspective widening. Centralized here (previously inlined in the worker).
   * Pure endpoint geometry; returns adjusted endpoints.
   *
   * @param {{
   *   p0:{x,y}, p12:{x,y}, width:number, height:number,
   *   isHorizontal:boolean, isPhoto:boolean, isRot180:boolean,
   *   methodHasOcr:boolean, ocrStart:boolean, ocrMatchedCount:number
   * }} ctx
   * @returns {{p0:{x,y}, p12:{x,y}}}
   */
  function applyTopPhotoPerspectiveShift(ctx) {
    let p0 = ctx.p0;
    let p12 = ctx.p12;
    const { width, height, isHorizontal, isPhoto, isRot180, methodHasOcr, ocrStart, ocrMatchedCount } = ctx;
    let appliedTopPhotoShift = false;

    if (isHorizontal && isPhoto && isRot180 && methodHasOcr) {
      const midY = (p0.y + p12.y) / 2;
      if (height >= 2000 && midY < height * 0.18) {
        const yShift = Math.max(20, Math.min(50, height * 0.01));
        p0 = { ...p0, y: Math.max(0, Math.min(height - 1, p0.y + yShift)) };
        p12 = { ...p12, y: Math.max(0, Math.min(height - 1, p12.y + yShift)) };

        const cx = (p0.x + p12.x) / 2;
        const cy = (p0.y + p12.y) / 2;
        const expand = 1 + (yShift / Math.max(1, height * 0.335));
        p0 = {
          x: Math.max(0, Math.min(width - 1, cx + (p0.x - cx) * expand)),
          y: Math.max(0, Math.min(height - 1, cy + (p0.y - cy) * expand)),
        };
        p12 = {
          x: Math.max(0, Math.min(width - 1, cx + (p12.x - cx) * expand)),
          y: Math.max(0, Math.min(height - 1, cy + (p12.y - cy) * expand)),
        };
        appliedTopPhotoShift = true;
      }
    }

    // Fallback: flipped top-ruler with OCR-start but no confirmed OCR anchors.
    // Note: intentionally NOT photo-gated (applies to flipped PDFs too).
    if (isHorizontal && isRot180 && ocrStart && !appliedTopPhotoShift && (ocrMatchedCount || 0) === 0) {
      const midY = (p0.y + p12.y) / 2;
      if (midY < height * 0.25) {
        const yShift = Math.max(20, Math.min(50, height * 0.01));
        p0 = { ...p0, y: Math.max(0, Math.min(height - 1, p0.y + yShift)) };
        p12 = { ...p12, y: Math.max(0, Math.min(height - 1, p12.y + yShift)) };

        if (!methodHasOcr) {
          // Approximate perspective widening when moving from upper to lower edge.
          const cx = (p0.x + p12.x) / 2;
          const cy = (p0.y + p12.y) / 2;
          const expand = 1 + (yShift / Math.max(1, height * 0.14));
          p0 = {
            x: Math.max(0, Math.min(width - 1, cx + (p0.x - cx) * expand)),
            y: Math.max(0, Math.min(height - 1, cy + (p0.y - cy) * expand)),
          };
          p12 = {
            x: Math.max(0, Math.min(width - 1, cx + (p12.x - cx) * expand)),
            y: Math.max(0, Math.min(height - 1, cy + (p12.y - cy) * expand)),
          };
        }
      }
    }

    return { p0, p12 };
  }

  const api = {
    detectPageQuad,
    estimatePagePerspective,
    mapCorrectedToBase,
    refineEndpoints,
    applyTopPhotoPerspectiveShift,
    // exposed for testing
    _internals: { invert3x3, applyHomography, orderQuad, refineByRulerEdges, refineByTickSpacing },
  };

  if (isNode) {
    module.exports = api;
  } else {
    env.keystone = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
