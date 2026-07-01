/**
 * js/ruler-detector.js
 * Ruler detection and tick clustering algorithms.
 */

if (typeof median === "undefined") {
  globalThis.median = function(values) {
    if (!values.length) return 0;
    const copy = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(copy.length / 2);
    return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
  };
}

if (typeof distance === "undefined") {
  globalThis.distance = function(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
}

function expectedDistanceFromMeta(meta, w, h, rulerLengthMm) {
  const pageHeightPt = meta ? (meta.pageHoehePt || meta.pageHöhePt) : null;
  if (!meta || !meta.isPdf || !meta.pageBreitePt || !pageHeightPt) return null;
  const pageWmm = meta.pageBreitePt / (72 / 25.4);
  const pageHmm = pageHeightPt / (72 / 25.4);
  if (pageWmm <= 0 || pageHmm <= 0) return null;

  const sourceW = Number(meta.sourceWidthPx);
  const sourceH = Number(meta.sourceHeightPx);
  const basisW = Number.isFinite(sourceW) && sourceW > 0 ? sourceW : w;
  const basisH = Number.isFinite(sourceH) && sourceH > 0 ? sourceH : h;

  const pxPerMmX = basisW / pageWmm;
  const pxPerMmY = basisH / pageHmm;
  let span = rulerLengthMm * ((pxPerMmX + pxPerMmY) / 2);
  if (meta && meta.scale) {
    span *= meta.scale;
  }
  return {
    horizontalPx: span,
    vertikalPx: span,
  };
}

function findRulerCandidates(srcMat, expected, rulerLengthMm) {
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const candidates = [];

  try {
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    cv.Canny(gray, edges, 20, 100, 3, false);

    const lengthsToTry = [rulerLengthMm];
    const altLength = rulerLengthMm === 120 ? 100 : 120;
    lengthsToTry.push(altLength);

    for (const tryMm of lengthsToTry) {
      let tryExpected = expected;
      if (expected && tryMm !== rulerLengthMm) {
        const scaleFactor = tryMm / rulerLengthMm;
        tryExpected = {
          horizontalPx: expected.horizontalPx * scaleFactor,
          vertikalPx: expected.vertikalPx * scaleFactor,
        };
      }

      const tickCloud = findTickCloud(edges, srcMat.cols, srcMat.rows, tryExpected, tryMm);
      if (tickCloud && Math.hypot(tickCloud.p12.x - tickCloud.p0.x, tickCloud.p12.y - tickCloud.p0.y) >= Math.max(srcMat.cols, srcMat.rows) * 0.16) {
        candidates.push({ ...tickCloud, detectedLengthMm: tickCloud.detectedLengthMm || tryMm });
      }

      const lineFallback = findLongestRulerLine(edges, srcMat.cols, srcMat.rows, tryExpected, tryMm);
      if (lineFallback && Math.hypot(lineFallback.p12.x - lineFallback.p0.x, lineFallback.p12.y - lineFallback.p0.y) >= Math.max(srcMat.cols, srcMat.rows) * 0.16) {
        candidates.push({ ...lineFallback, detectedLengthMm: lineFallback.detectedLengthMm || tryMm });
      }
    }

    return candidates;
  } finally {
    gray.delete();
    edges.delete();
  }
}

function findRulerCandidatesInBand(srcMat, expected, rulerLengthMm, bandFraction) {
  const bandH = Math.round(srcMat.rows * bandFraction);
  if (bandH < 40) return [];

  const roi = new cv.Rect(0, 0, srcMat.cols, bandH);
  const bandMat = srcMat.roi(roi);

  try {
    return findRulerCandidates(bandMat, expected, rulerLengthMm);
  } finally {
    bandMat.delete();
  }
}

function findRulerInBand(srcMat, expected, rulerLengthMm, bandFraction) {
  const bandH = Math.round(srcMat.rows * bandFraction);
  if (bandH < 40) return null;

  const roi = new cv.Rect(0, 0, srcMat.cols, bandH);
  const bandMat = srcMat.roi(roi);

  try {
    const result = findRuler(bandMat, expected, rulerLengthMm);
    if (!result) return null;
    return result;
  } finally {
    bandMat.delete();
  }
}

function findRuler(srcMat, expected, rulerLengthMm) {
  const gray = new cv.Mat();
  const edges = new cv.Mat();

  try {
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    cv.Canny(gray, edges, 20, 100, 3, false);

    const lengthsToTry = [rulerLengthMm];
    const altLength = rulerLengthMm === 120 ? 100 : 120;
    lengthsToTry.push(altLength);

    function isBetter(a, b) {
      if (!b) return true;
      if (a.reliable && !b.reliable) return true;
      if (!a.reliable && b.reliable) return false;
      const aIsTick = a.method.startsWith("Tick-Cluster");
      const bIsTick = b.method.startsWith("Tick-Cluster");
      if (aIsTick && !bIsTick) return true;
      if (!aIsTick && bIsTick) return false;

      // Prefer the expected length hint if both are reliable
      const aMatchesHint = (a.detectedLengthMm === rulerLengthMm);
      const bMatchesHint = (b.detectedLengthMm === rulerLengthMm);
      if (aMatchesHint && !bMatchesHint) return true;
      if (!aMatchesHint && bMatchesHint) return false;

      return a.score > b.score;
    }

    let bestResult = null;

    for (const tryMm of lengthsToTry) {
      let tryExpected = expected;
      if (expected && tryMm !== rulerLengthMm) {
        const scaleFactor = tryMm / rulerLengthMm;
        tryExpected = {
          horizontalPx: expected.horizontalPx * scaleFactor,
          vertikalPx: expected.vertikalPx * scaleFactor,
        };
      }

      const tickCloud = findTickCloud(edges, srcMat.cols, srcMat.rows, tryExpected, tryMm);
      if (tickCloud && isBetter(tickCloud, bestResult)) {
        bestResult = tickCloud;
      }

      const lineFallback = findLongestRulerLine(edges, srcMat.cols, srcMat.rows, tryExpected, tryMm);
      if (lineFallback && isBetter(lineFallback, bestResult)) {
        bestResult = lineFallback;
      }
    }

    return bestResult;
  } finally {
    gray.delete();
    edges.delete();
  }
}

function findTickCloud(edges, cols, rows, expected, rulerLengthMm) {
  const lines = new cv.Mat();
  try {
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 8, 3, 3);

    const vert = [];
    const horiz = [];

    for (let i = 0; i < lines.rows; i += 1) {
      const x1 = lines.data32S[i * 4 + 0];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];

      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 2 || len > Math.max(16, Math.min(cols, rows) * 0.024)) continue;

      let deg = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
      if (deg > 90) deg = 180 - deg;

      if (Math.abs(90 - deg) <= 18) {
        vert.push({ x1, y1, x2, y2, x: (x1 + x2) / 2, y: (y1 + y2) / 2, len });
      } else if (deg <= 18) {
        horiz.push({ x1, y1, x2, y2, x: (x1 + x2) / 2, y: (y1 + y2) / 2, len });
      }
    }

    const candH = candidateFromTicks(vert, "horizontal", cols, rows, expected && expected.horizontalPx, rulerLengthMm, horiz);
    const candV = candidateFromTicks(horiz, "vertikal", cols, rows, expected && expected.vertikalPx, rulerLengthMm, vert);

    const candidates = [candH, candV].filter(Boolean);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  } finally {
    lines.delete();
  }
}

function countTickClusters(pos, span) {
  if (pos.length === 0) return 0;
  const maxDist = Math.max(4, span * 0.004);
  let count = 1;
  let last = pos[0];
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] - last > maxDist) {
      count++;
      last = pos[i];
    }
  }
  return count;
}

function getTickClusterCenters(pos, span) {
  if (pos.length === 0) return [];
  const maxDist = Math.max(4, span * 0.004);
  const centers = [];
  let currentGroup = [pos[0]];
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] - pos[i - 1] > maxDist) {
      const sum = currentGroup.reduce((a, b) => a + b, 0);
      centers.push(sum / currentGroup.length);
      currentGroup = [pos[i]];
    } else {
      currentGroup.push(pos[i]);
    }
  }
  const sum = currentGroup.reduce((a, b) => a + b, 0);
  centers.push(sum / currentGroup.length);
  return centers;
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

function candidateFromTicks(ticks, orientation, cols, rows, expectedSpan, rulerLengthMm, baselineSegments) {
  if (!ticks || ticks.length < 8) return null;

  const ticksToUse = ticks;

  const bandSize = Math.max(8, Math.round((orientation === "horizontal" ? rows : cols) * 0.01));
  const axisLimit = orientation === "horizontal" ? rows : cols;
  const edgeBand = axisLimit * 0.22;
  const histogram = new Map();

  for (const t of ticksToUse) {
    const axis = orientation === "horizontal" ? t.y : t.x;
    const b = Math.floor(axis / bandSize);
    histogram.set(b, (histogram.get(b) || 0) + 1);
  }

  const bestBins = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  let best = null;

  for (const [b, count] of bestBins) {
    const center = b * bandSize + bandSize / 2;
    const bandHalf = Math.max(12, Math.round((orientation === "horizontal" ? rows : cols) * 0.018));
    const group = ticksToUse.filter((t) => Math.abs((orientation === "horizontal" ? t.y : t.x) - center) <= bandHalf);
    if (group.length < 8) continue;

    const pos = group.map((t) => orientation === "horizontal" ? t.x : t.y).sort((a, b2) => a - b2);
    const qStart = quantile(pos, 0.02);
    const qEnd = quantile(pos, 0.98);
    const span = qEnd - qStart;
    
    if (span < Math.min(cols, rows) * 0.1) continue;

    let lineMin = null;
    let lineMax = null;
    if (baselineSegments && baselineSegments.length > 0) {
      const matchingBaselines = baselineSegments.filter(s => {
        const distToCenter = orientation === "horizontal" 
          ? Math.abs(s.y - center) 
          : Math.abs(s.x - center);
        return distToCenter <= bandHalf * 1.5;
      });
      if (matchingBaselines.length > 0) {
        matchingBaselines.sort((a, b) => b.len - a.len);
        const longest = matchingBaselines[0];
        if (orientation === "horizontal") {
          lineMin = Math.min(longest.x1, longest.x2);
          lineMax = Math.max(longest.x1, longest.x2);
        } else {
          lineMin = Math.min(longest.y1, longest.y2);
          lineMax = Math.max(longest.y1, longest.y2);
        }
      }
    }

    const centers = getTickClusterCenters(pos, span);
    if (centers.length < 2) continue;

    const diffs = [];
    for (let i = 1; i < centers.length; i++) {
      diffs.push(centers[i] - centers[i-1]);
    }
    let stepMed = median(diffs);
    let tickStepMm = 1;
    const roughPxPerMm = expectedSpan ? (expectedSpan / rulerLengthMm) : (span / rulerLengthMm);

    if (expectedSpan && diffs.length > 0) {
      const rawMed = median(diffs);
      const err1 = Math.abs(rawMed - roughPxPerMm);
      const err5 = Math.abs(rawMed - 5 * roughPxPerMm);
      const err10 = Math.abs(rawMed - 10 * roughPxPerMm);

      if (err10 < err5 && err10 < err1) {
        stepMed = 10 * roughPxPerMm;
        tickStepMm = 10;
      } else if (err5 < err10 && err5 < err1) {
        stepMed = 5 * roughPxPerMm;
        tickStepMm = 5;
      } else {
        stepMed = roughPxPerMm;
        tickStepMm = 1;
      }
    } else if (centers.length < 45 && diffs.length > 0) {
      const minCmDiff = span / 16;
      const filteredDiffs = diffs.filter(d => d >= minCmDiff);
      if (filteredDiffs.length > 0) {
        stepMed = median(filteredDiffs);
        // Guess if it's 5 or 10
        const ratio = span / stepMed;
        const err5 = Math.abs(ratio - (rulerLengthMm / 5));
        const err10 = Math.abs(ratio - (rulerLengthMm / 10));
        tickStepMm = (err5 < err10) ? 5 : 10;
      } else {
        tickStepMm = 1;
      }
    }
    const isCmOnly = tickStepMm > 1;

    let bestL = rulerLengthMm;
    let bestPxPerMm = 1;
    let bestStart = centers[0];
    let maxMatchesOverall = -1;
    let minErrOverall = Infinity;
    let bestMatchedSpanOverall = 0;

    let pxPerMm_candidate = roughPxPerMm;
    if (stepMed > 0 && !expectedSpan) {
      pxPerMm_candidate = stepMed / tickStepMm;
    }
    if (!expectedSpan && (pxPerMm_candidate < 0.7 * roughPxPerMm || pxPerMm_candidate > 1.3 * roughPxPerMm)) {
      pxPerMm_candidate = roughPxPerMm;
    }

    const isDebugStencil1 = false;
    const candidatesL = [100, 120];
    for (const tryL of candidatesL) {
      if (pxPerMm_candidate <= 0) continue;

      const stepPx = pxPerMm_candidate * tickStepMm;
      const stepSize = tickStepMm;
      const maxGridIdx = tryL / tickStepMm;

      // Multi-anchor grid matching: try multiple tick centers as potential anchor points
      // instead of only centers[0] which may be a spurious noise tick
      const anchorStep = Math.max(1, Math.floor(centers.length / 25));

      let bestStartForL = centers[0];
      let maxMatchesForL = -1;
      let minErrForL = Infinity;
      let bestMatchedSpanForL = 0;

      for (let ai = 0; ai < centers.length; ai += anchorStep) {
        const anchor = centers[ai];
        for (let k0 = 0; k0 <= tryL; k0 += stepSize) {
          const startCandidate = anchor - k0 * pxPerMm_candidate;
          const endCandidate = startCandidate + tryL * pxPerMm_candidate;

          // Skip if ruler would be largely off the visible area
          const axisMax = orientation === "horizontal" ? cols : rows;
          if (startCandidate < -pxPerMm_candidate * 5 || endCandidate > axisMax + pxPerMm_candidate * 5) continue;

          let matchCount = 0;
          let sumMatchErr = 0;
          const matchedIndices = new Set();

          for (let i = 0; i < centers.length; i++) {
            const dist = centers[i] - startCandidate;
            const idx = Math.round(dist / stepPx);
            const gridCoord = startCandidate + idx * stepPx;
            const err = Math.abs(centers[i] - gridCoord);
            if (err <= stepPx * 0.18 && idx >= 0 && idx <= maxGridIdx) {
              if (!matchedIndices.has(idx)) {
                matchCount++;
                sumMatchErr += err;
                matchedIndices.add(idx);
              }
            }
          }

          if (matchCount > maxMatchesForL || (matchCount === maxMatchesForL && sumMatchErr < minErrForL)) {
            maxMatchesForL = matchCount;
            minErrForL = sumMatchErr;
            bestStartForL = startCandidate;

            if (matchedIndices.size > 0) {
              const sortedIndices = [...matchedIndices].sort((a, b) => a - b);
              const spanUnits = sortedIndices[sortedIndices.length - 1] - sortedIndices[0];
              bestMatchedSpanForL = spanUnits * tickStepMm;
            } else {
              bestMatchedSpanForL = 0;
            }
          }
        }
      }

      // Compare using match ratio, but respect the expected ruler length hint.
      // The expected length (from metadata) gets preference unless the alternative
      // has a significantly higher match ratio (>10% better).
      const maxGridIdxL = tryL / tickStepMm;
      const ratioForL = maxMatchesForL / (maxGridIdxL + 1);
      const maxGridIdxOverall = bestL / tickStepMm;
      const ratioOverall = maxMatchesOverall / (maxGridIdxOverall + 1);

      // Penalize ratio if a 120mm grid is fitted but the matched span is <= 105mm (highly likely a 100mm ruler)
      let adjRatioForL = ratioForL;
      if (tryL === 120 && bestMatchedSpanForL <= 105 && bestMatchedSpanForL > 0) {
        const unmatchedMm = tryL - bestMatchedSpanForL;
        adjRatioForL -= (unmatchedMm / 10) * 0.08;
      }

      let adjRatioOverall = ratioOverall;
      if (bestL === 120 && bestMatchedSpanOverall <= 105 && bestMatchedSpanOverall > 0) {
        const unmatchedMm = bestL - bestMatchedSpanOverall;
        adjRatioOverall -= (unmatchedMm / 10) * 0.08;
      }

      // Determine which length is "preferred" (matches the hint)
      const tryLIsPreferred = Math.abs(tryL - rulerLengthMm) < Math.abs(bestL - rulerLengthMm);
      const samePreference = Math.abs(tryL - rulerLengthMm) === Math.abs(bestL - rulerLengthMm);

      const limitRatio = isCmOnly ? 0.22 : 0.08;

      let isBetterL = false;
      if (samePreference) {
        // Both equally preferred — use ratio, then error
        if (adjRatioForL > adjRatioOverall + 0.02) {
          isBetterL = true;
        } else if (Math.abs(adjRatioForL - adjRatioOverall) <= 0.02) {
          isBetterL = minErrForL < minErrOverall;
        }
      } else if (tryLIsPreferred) {
        // We are evaluating the preferred length tryL vs the non-preferred bestL
        if (adjRatioOverall >= 0.40) {
          // If the alternative length matched well, only switch to preferred if it's not much worse
          isBetterL = (adjRatioForL > adjRatioOverall - 0.15);
        } else {
          // If the alternative matched poorly, switch to preferred if it has some matches
          isBetterL = (adjRatioForL >= limitRatio) || (maxMatchesOverall === -1);
        }
      } else {
        // We are evaluating the non-preferred length tryL vs the preferred bestL
        if (adjRatioOverall >= 0.45) {
          // The preferred length matched very well. Only fallback to alternative if it is vastly better.
          isBetterL = (adjRatioForL > adjRatioOverall + 0.25);
        } else if (adjRatioOverall >= 0.20) {
          // The preferred length matched moderately. Fallback if alternative is significantly better.
          isBetterL = (adjRatioForL > adjRatioOverall + 0.12);
        } else {
          // The preferred length matched poorly. Fallback if alternative is slightly better.
          isBetterL = (adjRatioForL > adjRatioOverall + 0.05) || (adjRatioForL >= 0.20 && adjRatioOverall < 0.10);
        }
      }



      if (maxMatchesOverall === -1 || isBetterL) {
        maxMatchesOverall = maxMatchesForL;
        minErrOverall = minErrForL;
        bestL = tryL;
        bestPxPerMm = pxPerMm_candidate;
        bestStart = bestStartForL;
        bestMatchedSpanOverall = bestMatchedSpanForL;
      }
    }

    if (isDebugStencil1) {
    }

    let start = bestStart;
    let end = start + bestL * bestPxPerMm;

    // Refine start and pxPerMm using least-squares linear regression on matched ticks
    const stepPx = bestPxPerMm * tickStepMm;
    const matchedPoints = [];
    for (let i = 0; i < centers.length; i++) {
      const dist = centers[i] - bestStart;
      const idx = Math.round(dist / stepPx);
      const gridCoord = bestStart + idx * stepPx;
      const err = Math.abs(centers[i] - gridCoord);
      if (err <= stepPx * 0.18 && idx >= 0 && idx <= (bestL / tickStepMm)) {
        const mmIndex = idx * tickStepMm;
        matchedPoints.push({ mmIndex, coord: centers[i] });
      }
    }

    if (matchedPoints.length >= 4) {
      let sumIdx = 0, sumCoord = 0;
      for (const pt of matchedPoints) {
        sumIdx += pt.mmIndex;
        sumCoord += pt.coord;
      }
      const meanIdx = sumIdx / matchedPoints.length;
      const meanCoord = sumCoord / matchedPoints.length;

      let num = 0, den = 0;
      for (const pt of matchedPoints) {
        num += (pt.mmIndex - meanIdx) * (pt.coord - meanCoord);
        den += (pt.mmIndex - meanIdx) * (pt.mmIndex - meanIdx);
      }
      if (den > 1e-6) {
        const refinedPxPerMm = num / den;
        const refinedStart = meanCoord - refinedPxPerMm * meanIdx;
        if (refinedPxPerMm > 0.5 * bestPxPerMm && refinedPxPerMm < 1.5 * bestPxPerMm) {
          start = refinedStart;
          end = start + bestL * refinedPxPerMm;
          bestPxPerMm = refinedPxPerMm;
        }
      }
    }

    if (lineMin !== null && lineMax !== null) {
      const kStart = tickStepMm * Math.round((centers[0] - lineMin) / (bestPxPerMm * tickStepMm));
      if (kStart >= 0 && kStart <= 30) {
        const baselineStart = centers[0] - kStart * bestPxPerMm;
        if (Math.abs(baselineStart - start) < bestPxPerMm * 15) {
          start = baselineStart;
          end = start + bestL * bestPxPerMm;
        }
      }
    }

    let expectedStepBonus = 0;
    let expectedStepPlausibel = true;
    let candidateExpectedSpan = expectedSpan;
    if (expectedSpan) {
      const expectedStep = expectedSpan / rulerLengthMm;
      if (stepMed <= 0) {
        expectedStepPlausibel = false;
      } else {
        const intervalCount = span / stepMed;
        const stepErr = Math.abs(stepMed - expectedStep) / Math.max(expectedStep, 1e-6);
        expectedStepBonus = Math.max(0, 1 - stepErr) * 120;
        if (intervalCount < bestL * 0.58 / tickStepMm || intervalCount > bestL * 1.5 / tickStepMm) {
          expectedStepPlausibel = false;
        }
      }
      candidateExpectedSpan = bestL * expectedStep;
    }

    const edgeDist = Math.min(center, axisLimit - center);
    const edgeBias = 1 - edgeDist / Math.max(1, axisLimit / 2);

    const density = group.length / Math.max(1, span);
    const densityBonus = Math.min(65, density * 180);

    let expectedBonus = 0;
    let spanErr = 1;
    let stepErr = 0;
    if (expectedSpan && candidateExpectedSpan) {
      spanErr = Math.abs(span - candidateExpectedSpan) / Math.max(candidateExpectedSpan, 1);
      if (spanErr > 0.22) {
        continue;
      }
      let expectedUnitStep = expectedSpan / rulerLengthMm;
      if (isCmOnly) {
        const ratio = span / stepMed;
        const err5 = Math.abs(ratio - (rulerLengthMm / 5));
        const err10 = Math.abs(ratio - (rulerLengthMm / 10));
        if (err5 < err10) {
          expectedUnitStep = (expectedSpan / rulerLengthMm) * 5;
        } else {
          expectedUnitStep = (expectedSpan / rulerLengthMm) * 10;
        }
      }
      stepErr = Math.abs(stepMed - expectedUnitStep) / expectedUnitStep;
      if (stepErr > 0.22) {
        continue;
      }
      expectedBonus = Math.max(0, 1 - spanErr) * 80;
    }

    let regular = 0;
    if (stepMed > 0) {
      let regularCount = 0;
      for (const d of diffs) {
        const expectedDiff = stepMed;
        if (Math.abs(d - expectedDiff) <= Math.max(0.4, expectedDiff * 0.45)) regularCount += 1;
      }
      regular = regularCount / Math.max(diffs.length, 1);
    }

    const matchRatio = maxMatchesOverall / (bestL / tickStepMm + 1);
    const matchRatioBonus = matchRatio * 150;
    const extraClusters = centers.length - maxMatchesOverall;
    const noisePenalty = Math.max(0, extraClusters) * 6.0;

    const score =
      group.length * 1.35 +
      span * 0.02 +
      regular * 55 +
      expectedBonus * 10.0 +
      expectedStepBonus +
      densityBonus +
      edgeBias * 140 +
      count +
      matchRatioBonus -
      noisePenalty;

    const reliable =
      group.length >= (tickStepMm > 1 ? 8 : 50) &&
      regular >= 0.15 &&
      (!expectedSpan || (spanErr <= 0.18 && stepErr <= 0.15));



    let m = 0;
    let c = center;
    const N = group.length;
    if (N > 0) {
      let sumX = 0, sumY = 0;
      for (const t of group) {
        sumX += t.x;
        sumY += t.y;
      }
      const meanX = sumX / N;
      const meanY = sumY / N;

      if (orientation === "horizontal") {
        let num = 0, den = 0;
        for (const t of group) {
          num += (t.x - meanX) * (t.y - meanY);
          den += (t.x - meanX) * (t.x - meanX);
        }
        if (den > 1e-6) {
          m = num / den;
          c = meanY - m * meanX;
        }
      } else {
        let num = 0, den = 0;
        for (const t of group) {
          num += (t.y - meanY) * (t.x - meanX);
          den += (t.y - meanY) * (t.y - meanY);
        }
        if (den > 1e-6) {
          m = num / den;
          c = meanX - m * meanY;
        }
      }
    }

    const p0 = orientation === "horizontal"
      ? { x: start, y: m * start + c }
      : { x: m * start + c, y: start };
    const p12 = orientation === "horizontal"
      ? { x: end, y: m * end + c }
      : { x: m * end + c, y: end };

    const candidate = {
      p0,
      p12,
      method: "Tick-Cluster " + orientation,
      reliable,
      score,
      detectedLengthMm: bestL,
    };

    if (!best || candidate.score > best.score) best = candidate;
  }

  return best;
}

function findLongestRulerLine(edges, cols, rows, expected, rulerLengthMm) {
  const lines = new cv.Mat();
  try {
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 70, Math.max(cols, rows) * 0.2, 20);

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < lines.rows; i += 1) {
      const x1 = lines.data32S[i * 4 + 0];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < Math.min(cols, rows) * 0.16) {
        continue;
      }

      const dx = x2 - x1;
      const dy = y2 - y1;
      const orientHorizontal = Math.abs(dx) >= Math.abs(dy);
      const expectedSpan = expected ? (orientHorizontal ? expected.horizontalPx : expected.vertikalPx) : null;

      let spanErr = 0;
      if (expectedSpan) {
        const spanErr = Math.abs(len - expectedSpan) / expectedSpan;
        if (spanErr > 0.16) {
          continue;
        }
      }

      const minMargin = Math.min(x1, cols - x1, y1, rows - y1, x2, cols - x2, y2, rows - y2);
      const edgeLimit = Math.min(cols, rows) * 0.02;
      let edgePenalty = 0;
      if (minMargin < edgeLimit) {
        edgePenalty = 1000;
      }

      const fractionOfLimit = orientHorizontal ? len / cols : len / rows;
      let lengthPenalty = 0;
      if (fractionOfLimit > 0.92) {
        lengthPenalty = 1000;
      }

      const e1 = Math.min(x1, cols - x1, y1, rows - y1);
      const e2 = Math.min(x2, cols - x2, y2, rows - y2);
      const edgeDist = (e1 + e2) / 2;
      const edgeNorm = edgeDist / Math.max(1, Math.min(cols, rows));

      const score = expectedSpan
        ? expectedSpan - Math.abs(len - expectedSpan) * 3 - edgeNorm * 80 - edgePenalty - lengthPenalty
        : len - edgeNorm * 80 - edgePenalty - lengthPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = {
          p0: { x: x1, y: y1 },
          p12: { x: x2, y: y2 },
          spanErr,
          edgeNorm,
        };
      }
    }

    if (!best) return null;
    const reliable = Boolean(expected) && best.spanErr <= 0.09;
    return {
      p0: best.p0,
      p12: best.p12,
      method: reliable ? "Linien-Fallback (Rand + Plausibel)" : "Linien-Fallback",
      reliable,
      score: bestScore,
      detectedLengthMm: rulerLengthMm,
    };
  } finally {
    lines.delete();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    expectedDistanceFromMeta,
    findRulerInBand,
    findRuler,
    findTickCloud,
    candidateFromTicks,
    findLongestRulerLine,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OCR, Grid Snapping and Refinement Port
// ─────────────────────────────────────────────────────────────────────────────

function clusterTickPeaks(samples, mergeRadius) {
  if (!samples.length) return [];
  const ordered = samples.slice().sort((a, b) => a.pos - b.pos);
  const clusters = [];

  let cur = {
    pos: ordered[0].pos,
    weight: ordered[0].weight,
    maxWeight: ordered[0].weight,
  };

  for (let i = 1; i < ordered.length; i += 1) {
    const s = ordered[i];
    if (Math.abs(s.pos - cur.pos) <= mergeRadius) {
      const total = cur.weight + s.weight;
      cur.pos = (cur.pos * cur.weight + s.pos * s.weight) / Math.max(1e-6, total);
      cur.weight = total;
      cur.maxWeight = Math.max(cur.maxWeight, s.weight);
    } else {
      clusters.push(cur);
      cur = { pos: s.pos, weight: s.weight, maxWeight: s.weight };
    }
  }
  clusters.push(cur);
  return clusters;
}

function nearestClusterDist(clusters, target, maxDist) {
  let best = null;
  for (let i = 0; i < clusters.length; i += 1) {
    const c = clusters[i];
    const d = Math.abs(c.pos - target);
    if (d > maxDist) continue;
    if (!best || d < best.d) {
      best = { d, cluster: c };
    }
  }
  return best;
}

let DIGIT_TEMPLATES = null;

function ensureDigitTemplates() {
  if (DIGIT_TEMPLATES) return DIGIT_TEMPLATES;
  const templates = [];
  for (let d = 0; d <= 9; d += 1) {
    const m = new cv.Mat(44, 28, cv.CV_8UC1, new cv.Scalar(0));
    const text = String(d);
    cv.putText(m, text, new cv.Point(3, 35), cv.FONT_HERSHEY_SIMPLEX, 1.2, new cv.Scalar(255), 5, cv.LINE_AA);
    cv.threshold(m, m, 120, 255, cv.THRESH_BINARY);
    const copy = new Uint8Array(m.data.length);
    copy.set(m.data);
    templates.push({ digit: d, data: copy, w: m.cols, h: m.rows });
    m.delete();
  }
  DIGIT_TEMPLATES = templates;
  return DIGIT_TEMPLATES;
}

let BASE_DIGIT_MATS = null;
function ensureBaseDigitMats() {
  if (BASE_DIGIT_MATS) return BASE_DIGIT_MATS;
  const templates = [];
  for (let d = 0; d <= 9; d++) {
    const rawTpl = new cv.Mat(80, 80, cv.CV_8UC1, new cv.Scalar(0));
    cv.putText(rawTpl, String(d), new cv.Point(15, 60), cv.FONT_HERSHEY_SIMPLEX, 1.8, new cv.Scalar(255), 5, cv.LINE_AA);
    cv.threshold(rawTpl, rawTpl, 120, 255, cv.THRESH_BINARY);

    const tplContours = new cv.MatVector();
    const tplHierarchy = new cv.Mat();
    cv.findContours(rawTpl, tplContours, tplHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let tplMat = null;
    if (tplContours.size() > 0) {
      let minX = 80, minY = 80, maxX = 0, maxY = 0;
      for (let j = 0; j < tplContours.size(); j++) {
        const c = tplContours.get(j);
        const r = cv.boundingRect(c);
        if (r.x < minX) minX = r.x;
        if (r.y < minY) minY = r.y;
        if (r.x + r.width > maxX) maxX = r.x + r.width;
        if (r.y + r.height > maxY) maxY = r.y + r.height;
      }
      const tplRect = new cv.Rect(minX, minY, maxX - minX, maxY - minY);
      tplMat = rawTpl.roi(tplRect).clone();
    } else {
      tplMat = new cv.Mat(24, 16, cv.CV_8UC1, new cv.Scalar(0));
    }
    tplContours.delete();
    tplHierarchy.delete();
    rawTpl.delete();

    templates.push({ digit: d, mat: tplMat });
  }
  BASE_DIGIT_MATS = templates;
  return BASE_DIGIT_MATS;
}

function getScaledTemplates(pxPerMm, heightRatio = 1.8) {
  const base = ensureBaseDigitMats();
  const H_tpl = Math.max(8, Math.round(heightRatio * pxPerMm));
  const W_tpl = Math.max(5, Math.round(H_tpl * (16 / 24)));
  
  const scaled = [];
  for (const t of base) {
    const dst = new cv.Mat();
    cv.resize(t.mat, dst, new cv.Size(W_tpl, H_tpl), 0, 0, cv.INTER_AREA);
    cv.threshold(dst, dst, 120, 255, cv.THRESH_BINARY);
    scaled.push({ digit: t.digit, mat: dst, width: W_tpl, height: H_tpl });
  }
  return scaled;
}

function ocrDigitFromRoi(binMat, rect) {
  if (Math.min(rect.width, rect.height) < 4 || Math.max(rect.width, rect.height) > 100) return null;
  const roi = binMat.roi(rect);
  const resized = new cv.Mat();
  try {
    cv.resize(roi, resized, new cv.Size(28, 44), 0, 0, cv.INTER_AREA);
    cv.threshold(resized, resized, 120, 255, cv.THRESH_BINARY);

    const templates = ensureDigitTemplates();
    let best = null;

    const rots = [
      roi,
      (() => { const d = new cv.Mat(); cv.rotate(roi, d, cv.ROTATE_90_CLOCKWISE); return d; })(),
      (() => { const d = new cv.Mat(); cv.rotate(roi, d, cv.ROTATE_180); return d; })(),
      (() => { const d = new cv.Mat(); cv.rotate(roi, d, cv.ROTATE_90_COUNTERCLOCKWISE); return d; })()
    ];

    try {
      for (const r of rots) {
        cv.resize(r, resized, new cv.Size(28, 44), 0, 0, cv.INTER_AREA);
        cv.threshold(resized, resized, 120, 255, cv.THRESH_BINARY);

        const rData = resized.data;
        for (let i = 0; i < templates.length; i += 1) {
          const t = templates[i];
          const tData = t.data;
          const tLen = tData.length;
          let inter = 0;
          let union = 0;
          for (let p = 0; p < tLen; p += 1) {
            const a = rData[p];
            const b = tData[p];
            if (a && b) inter += 1;
            if (a || b) union += 1;
          }
          const score = union > 0 ? inter / union : 0;
          if (!best || score > best.score) {
            best = { digit: t.digit, score };
          }
        }
      }
    } finally {
      for (let i = 1; i < rots.length; i++) rots[i].delete();
    }

    if (!best || best.score < 0.2) {
      return null;
    }
    return best;
  } finally {
    roi.delete();
    resized.delete();
  }
}

function inferNumberAnchorsFromGlyphs(glyphs) {
  if (!glyphs.length) return [];
  const anchors = [];
  const sorted = glyphs.slice().sort((a, b) => a.along - b.along);

  for (let i = 0; i < sorted.length; i += 1) {
    const g = sorted[i];
    if (g.digit >= 0 && g.digit <= 9) {
      anchors.push({
        number: g.digit,
        along: g.along,
        score: g.score,
        sideSign: g.sideSign,
      });
    }

    if (i + 1 < sorted.length) {
      const g2 = sorted[i + 1];
      if (g.sideSign !== g2.sideSign) continue;
      const gap = g2.along - g.along;
      const maxGap = Math.max(g.w, g2.w) * 1.6;
      if (gap <= 1 || gap > maxGap) continue;
      const n = g.digit * 10 + g2.digit;
      if (n < 10 || n > 12) continue;
      anchors.push({
        number: n,
        along: (g.along + g2.along) / 2,
        score: (g.score + g2.score) / 2,
        sideSign: g.sideSign,
      });
    }
  }

  return anchors;
}

function inferDirectionFromGlyphOrder(glyphs, rulerLengthMm) {
  if (!glyphs || glyphs.length < 3 || !Number.isFinite(rulerLengthMm) || rulerLengthMm <= 0) {
    return null;
  }

  const maxCm = rulerLengthMm / 10;
  const sorted = glyphs
    .filter((g) => Number.isFinite(g.along) && Number.isFinite(g.digit) && g.digit >= 1 && g.digit <= maxCm)
    .slice()
    .sort((a, b) => a.along - b.along);

  if (sorted.length < 3) return null;

  let positivePairs = 0;
  let negativePairs = 0;
  let totalWeight = 0;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (left.digit === right.digit) continue;

    const alongGap = right.along - left.along;
    if (alongGap < Math.max(left.w || 0, right.w || 0, 6)) continue;

    const weight = ((left.score || 0) + (right.score || 0)) / 2;
    totalWeight += weight;
    if (right.digit > left.digit) {
      positivePairs += weight;
    } else {
      negativePairs += weight;
    }
  }

  if (totalWeight <= 0) return null;

  const confidence = Math.abs(positivePairs - negativePairs) / totalWeight;
  if (confidence < 0.3) return null;

  return {
    shouldFlip: negativePairs > positivePairs,
    confidence,
    positivePairs,
    negativePairs,
  };
}

function estimateOcrStart(anchors, spanPx, rulerLengthMm, seedStart, len) {
  if (!anchors.length || !Number.isFinite(spanPx) || spanPx <= 100 || !Number.isFinite(rulerLengthMm) || rulerLengthMm <= 0) {
    return null;
  }

  const sideBuckets = new Map();
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i];
    if (a.number < 0 || a.number > rulerLengthMm / 10) continue;
    if (!sideBuckets.has(a.sideSign)) sideBuckets.set(a.sideSign, []);
    sideBuckets.get(a.sideSign).push(a);
  }

  let best = null;
  const maxCm = rulerLengthMm / 10;

  for (const [sideSign, bucket] of sideBuckets.entries()) {
    const sortedBucket = bucket.slice().sort((a, b) => a.along - b.along);
    const directions = ['forward', 'backward'];
    for (const dir of directions) {
      const starts = [];
      let totalScore = 0;

      for (let i = 0; i < sortedBucket.length; i += 1) {
        const a = sortedBucket[i];
        if (a.number <= 0 || a.number > maxCm) continue;
        const start = dir === 'forward' 
          ? a.along - (a.number / maxCm) * spanPx
          : (len - a.along) - (a.number / maxCm) * spanPx;
        starts.push({ start, number: a.number, score: a.score, along: a.along });
        totalScore += a.score;
      }

      if (starts.length < 2) continue;
      const sortedStarts = starts.map((s) => s.start).sort((x, y) => x - y);
      const med = sortedStarts[Math.floor(sortedStarts.length / 2)];
      let mad = 0;
      for (let i = 0; i < sortedStarts.length; i += 1) mad += Math.abs(sortedStarts[i] - med);
      mad /= sortedStarts.length;

      const tol = Math.max(16, spanPx * 0.03);
      const inliers = starts.filter((s) => Math.abs(s.start - med) <= tol);
      const support = inliers.length;
      if (support < 2) continue;

      let inlierMad = 0;
      for (const s of inliers) inlierMad += Math.abs(s.start - med);
      inlierMad /= support;

      if (inlierMad > tol * 0.6) continue;

      const uniqueNumbers = new Set(inliers.map((s) => s.number));
      if (uniqueNumbers.size < 2) continue;

      let directionalPositive = 0;
      let directionalNegative = 0;
      let directionalWeight = 0;
      const inliersSorted = inliers.slice().sort((a, b) => a.along - b.along);
      for (let i = 0; i < inliersSorted.length - 1; i += 1) {
        const left = inliersSorted[i];
        const right = inliersSorted[i + 1];
        if (left.number === right.number) continue;
        const weight = ((left.score || 0) + (right.score || 0)) / 2;
        directionalWeight += weight;
        if (right.number > left.number) {
          directionalPositive += weight;
        } else {
          directionalNegative += weight;
        }
      }

      if (directionalWeight <= 0) continue;

      const expectedForward = dir === 'forward';
      const directionalAgreement = expectedForward
        ? (directionalPositive / directionalWeight)
        : (directionalNegative / directionalWeight);
      if (directionalAgreement < 0.6) continue;

      const expectedStart = dir === 'forward' ? seedStart : len - (seedStart + spanPx);
      const drift = Number.isFinite(seedStart) ? Math.abs(med - expectedStart) : 0;

      const maxDrift = Math.max(120, spanPx * 0.15);
      if (Number.isFinite(seedStart) && drift > maxDrift) continue;

      const score = totalScore + support * 2.0 + directionalAgreement * 8 - inlierMad * 0.4 - drift * 0.001;

      if (!best || score > best.score) {
        best = { start: med, sideSign, score, support, mad, inlierMad, shouldFlip: dir === 'backward' };
      }
    }
  }

  if (!best || best.support < 2) return null;
  return best;
}

function rayDistanceToImageEdge(point, dirX, dirY, cols, rows) {
  let best = Infinity;
  if (Math.abs(dirX) > 1e-6) {
    const t0 = (0 - point.x) / dirX;
    const t1 = ((cols - 1) - point.x) / dirX;
    if (t0 > 0) best = Math.min(best, t0);
    if (t1 > 0) best = Math.min(best, t1);
  }
  if (Math.abs(dirY) > 1e-6) {
    const t0 = (0 - point.y) / dirY;
    const t1 = ((rows - 1) - point.y) / dirY;
    if (t0 > 0) best = Math.min(best, t0);
    if (t1 > 0) best = Math.min(best, t1);
  }
  return Number.isFinite(best) ? best : 1e9;
}

function fitMajorTickGrid(tickClusters, labelClusters, spanPx, rulerLengthMm, seedStart, seedEnd, hasOcr = false, filename = '') {
  if (!Number.isFinite(spanPx) || spanPx <= 100 || !Number.isFinite(rulerLengthMm) || rulerLengthMm <= 0) {
    return null;
  }

  const mmPx = spanPx / rulerLengthMm;
  const majorPx = mmPx * 10;
  const majorCount = Math.round(rulerLengthMm / 10);
  if (!Number.isFinite(majorPx) || majorPx < 20 || majorCount < 5) return null;

  const tickTol = Math.max(6, majorPx * 0.24);
  const labelTol = Math.max(8, majorPx * 0.34);
  const candidates = [];

  for (let i = 0; i < tickClusters.length; i += 1) {
    const peak = tickClusters[i];
    for (let k = 0; k <= majorCount; k += 1) {
      candidates.push(peak.pos - k * majorPx);
    }
  }

  if (Number.isFinite(seedStart)) candidates.push(seedStart);
  if (Number.isFinite(seedEnd)) candidates.push(seedEnd - spanPx);

  const dedup = [];
  candidates.sort((a, b) => a - b);
  for (let i = 0; i < candidates.length; i += 1) {
    const s = candidates[i];
    if (!Number.isFinite(s)) continue;
    if (!dedup.length || Math.abs(s - dedup[dedup.length - 1]) > 2) dedup.push(s);
  }

  let best = null;
  for (let i = 0; i < dedup.length; i += 1) {
    const start = dedup[i];
    let score = 0;
    let matches = 0;

    for (let k = 0; k <= majorCount; k += 1) {
      const target = start + k * majorPx;
      const isEndpoint = (k === 0 || k === majorCount);
      const tick = nearestClusterDist(tickClusters, target, tickTol);
      if (tick) {
        const closeness = 1 - (tick.d / tickTol);
        const endpointWeight = isEndpoint ? 0.7 : 1.0;
        score += endpointWeight * closeness * (1 + Math.min(3, tick.cluster.maxWeight / 8));
        matches += 1;
      }

      if (!isEndpoint && labelClusters.length) {
        const lbl = nearestClusterDist(labelClusters, target, labelTol);
        if (lbl) {
          const closeness = 1 - (lbl.d / labelTol);
          score += 0.45 * closeness * (1 + Math.min(2, lbl.cluster.maxWeight / 10));
        }
      }
    }

    let skippedByDrift = false;
    if (Number.isFinite(seedStart)) {
      const drift = Math.abs(start - seedStart);
      const maxAllowedDrift = hasOcr ? (majorPx * 3.5) : (majorPx * 1.2);
      if (drift > maxAllowedDrift) skippedByDrift = true;
    }
    const driftPenalty = Number.isFinite(seedStart) ? Math.abs(start - seedStart) / Math.max(majorPx, 1) : 0;
    const finalScore = score - (hasOcr ? 0.15 : 1.0) * driftPenalty;

    if (skippedByDrift) continue;
    score = finalScore;

    if (!best) {
      best = { start, end: start + spanPx, score, matches };
    } else if (score > best.score) {
      best = { start, end: start + spanPx, score, matches };
    } else if (Math.abs(score - best.score) < 1e-4) {
      const dist = Number.isFinite(seedStart) ? Math.abs(start - seedStart) : 0;
      const bestDist = Number.isFinite(seedStart) ? Math.abs(best.start - seedStart) : 0;
      if (dist < bestDist) {
        best = { start, end: start + spanPx, score, matches };
      }
    }
  }

  const minMatches = Math.max(4, Math.floor((majorCount + 1) * 0.45));
  if (!best || best.matches < minMatches) return null;
  return best;
}

function filterRulerGlyphs(glyphs, maxDist = 18) {
  if (glyphs.length === 0) return [];
  // console.log(`[DEBUG GLYPHS] raw glyphs: ${glyphs.length}`);
  // if (glyphs.length < 20) console.log(JSON.stringify(glyphs.map(g => ({d: g.digit, perp: g.signedPerp, along: g.along}))));
  
  let bestGroup = [];
  let bestScore = -1;
  
  for (let i = 0; i < glyphs.length; i++) {
    const refPerp = glyphs[i].signedPerp;
    const group = glyphs.filter(g => Math.abs(g.signedPerp - refPerp) <= maxDist);
    
    const uniqueDigits = new Set();
    let sumOcrScore = 0;
    for (const g of group) {
      if (g.digit >= 1 && g.digit <= 12) {
        uniqueDigits.add(g.digit);
      }
      sumOcrScore += g.score;
    }
    
    const score = uniqueDigits.size * 10 + sumOcrScore;
    if (score > bestScore) {
      bestScore = score;
      bestGroup = group;
    }
  }
  
  return bestGroup;
}

function extractRulerDigits(mat, p0, p12, rulerLengthMm) {
  const len = Math.hypot(p12.x - p0.x, p12.y - p0.y);
  if (len < 10) return { digits: [], p0: { x: p0.x, y: p0.y }, p12: { x: p12.x, y: p12.y }, matchedCount: 0 };
  const pxPerMm = len / rulerLengthMm;

  let scaledTemplates = [];
  let H_tpl = 0;
  let W_tpl = 0;

  const gray = new cv.Mat();
  let cropGray = null;
  let cropInv = null;
  let matchMaps = [];
  
  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    const minOffset = Math.max(12, Math.round(pxPerMm * 2.5));
    const maxOffset = Math.min(120, Math.round(pxPerMm * 12.0));
    const expectedDx = 10 * pxPerMm;

    const dyCandidates = [];
    for (let dy = minOffset; dy <= maxOffset; dy += 2) dyCandidates.push(dy);
    for (let dy = -maxOffset; dy <= -minOffset; dy += 2) dyCandidates.push(dy);

    const cx = (p0.x + p12.x) / 2;
    const cy = (p0.y + p12.y) / 2;
    const ux = (p12.x - p0.x) / len;
    const uy = (p12.y - p0.y) / len;
    const nx = -uy;
    const ny = ux;

    const cropW = Math.round(len + 100);
    const cropH = Math.round(2 * maxOffset + 40);

    const M = cv.matFromArray(2, 3, cv.CV_64FC1, [
      ux, uy, cropW / 2 - ux * cx - uy * cy,
      -uy, ux, cropH / 2 + uy * cx - ux * cy
    ]);

    cropGray = new cv.Mat();
    cv.warpAffine(gray, cropGray, M, new cv.Size(cropW, cropH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));
    M.delete();

    cropInv = new cv.Mat();
    cv.threshold(cropGray, cropInv, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    let bestScore = -1;
    let bestParams = null;

    const ratioCandidates = [1.3, 1.8, 2.3];
    for (const ratio of ratioCandidates) {
      const loopTemplates = getScaledTemplates(pxPerMm, ratio);
      const loopH = loopTemplates[0].height;
      const loopW = loopTemplates[0].width;

      const loopMaps = [];
      for (let c = 1; c <= 9; c++) {
        const tpl = loopTemplates.find(t => t.digit === c);
        const matchMap = new cv.Mat();
        cv.matchTemplate(cropInv, tpl.mat, matchMap, cv.TM_CCOEFF_NORMED);
        loopMaps.push({ digit: c, map: matchMap });
      }

      const mapCols = loopMaps[0].map.cols;
      const mapRows = loopMaps[0].map.rows;

      for (const dir of ['forward', 'backward']) {
        const expectedStartX = dir === 'forward' ? (cropW / 2 - len / 2) : (cropW / 2 + len / 2);
        const dirSign = dir === 'forward' ? 1 : -1;

        for (let i = 0; i < dyCandidates.length; i++) {
          const dy = dyCandidates[i];
          const y_c = Math.round(cropH / 2 + dy);
          const ty = Math.round(y_c - loopH / 2);
          if (ty < 0 || ty >= mapRows) continue;

          const searchRange = Math.max(35, Math.round(expectedDx * 1.5));
          for (let sx = Math.round(expectedStartX - searchRange); sx <= Math.round(expectedStartX + searchRange); sx += 2) {
            for (const scale of [0.96, 0.98, 1.0, 1.02, 1.04]) {
              const dx = scale * expectedDx;
              let scoreSum = 0;
              let matchedCount = 0;

              for (let c = 1; c <= 9; c++) {
                const cx_val = Math.round(sx + dirSign * c * dx);
                const tx = Math.round(cx_val - loopW / 2);
                if (tx < 0 || tx >= mapCols) continue;

                const val = loopMaps[c - 1].map.data32F[ty * mapCols + tx];
                if (val > 0.70) {
                  scoreSum += val;
                  matchedCount++;
                }
              }

              const score = matchedCount * 10.0 + scoreSum;
              if (score > bestScore) {
                bestScore = score;
                bestParams = { dir, dy, sx, dx, matchedCount, scoreSum, ratio };
              }
            }
          }
        }
      }

      // Cleanup loop maps & templates immediately to avoid leaking memory
      for (const mm of loopMaps) mm.map.delete();
      for (const t of loopTemplates) t.mat.delete();
    }

    // Recreate scaledTemplates and matchMaps for the best params to be used in refinement
    let mapCols = 0;
    let mapRows = 0;

    if (bestParams) {
      scaledTemplates = getScaledTemplates(pxPerMm, bestParams.ratio);
      H_tpl = scaledTemplates[0].height;
      W_tpl = scaledTemplates[0].width;

      for (let c = 1; c <= 9; c++) {
        const tpl = scaledTemplates.find(t => t.digit === c);
        const matchMap = new cv.Mat();
        cv.matchTemplate(cropInv, tpl.mat, matchMap, cv.TM_CCOEFF_NORMED);
        matchMaps.push({ digit: c, map: matchMap });
      }
      mapCols = matchMaps[0].map.cols;
      mapRows = matchMaps[0].map.rows;
    } else {
      scaledTemplates = getScaledTemplates(pxPerMm, 1.8);
      H_tpl = scaledTemplates[0].height;
      W_tpl = scaledTemplates[0].width;
    }


    let refinedParams = bestParams;
    if (bestParams && bestParams.matchedCount >= 2) {
      let refinedBestScore = bestScore;
      const dirSign = bestParams.dir === 'forward' ? 1 : -1;
      const y_c = Math.round(cropH / 2 + bestParams.dy);
      const ty = Math.round(y_c - H_tpl / 2);

      if (ty >= 0 && ty < mapRows) {
        for (let sx = bestParams.sx - 2; sx <= bestParams.sx + 2; sx += 1) {
          for (let scale = -0.015; scale <= 0.015; scale += 0.005) {
            const dx = bestParams.dx + scale * expectedDx;
            let scoreSum = 0;
            let matchedCount = 0;

            for (let c = 1; c <= 9; c++) {
              const cx_val = Math.round(sx + dirSign * c * dx);
              const tx = Math.round(cx_val - W_tpl / 2);
              if (tx < 0 || tx >= mapCols) continue;

              const val = matchMaps[c - 1].map.data32F[ty * mapCols + tx];
              if (val > 0.70) {
                scoreSum += val;
                matchedCount++;
              }
            }

            const score = matchedCount * 10.0 + scoreSum;
            if (score > refinedBestScore) {
              refinedBestScore = score;
              refinedParams = { dir: bestParams.dir, dy: bestParams.dy, sx, dx, matchedCount, scoreSum };
            }
          }
        }
      }
    }

    const finalDigits = [];
    const matchedDigits = [];

    if (!refinedParams || refinedParams.matchedCount < 2) {
      const defOffset = 45;
      for (let c = 1; c <= 9; c++) {
        const along_c = c * 10 * pxPerMm;
        finalDigits.push({
          digit: c,
          x: p0.x + ux * along_c + nx * defOffset,
          y: p0.y + uy * along_c + ny * defOffset,
          rectWidth: W_tpl,
          rectHeight: H_tpl,
          matched: false,
          signedPerp: defOffset
        });
      }

      return {
        digits: finalDigits,
        p0: { x: p0.x, y: p0.y },
        p12: { x: p12.x, y: p12.y },
        matchedCount: 0,
      };
    }

    const dirSign = refinedParams.dir === 'forward' ? 1 : -1;
    for (let c = 1; c <= 9; c++) {
      const targetX = refinedParams.sx + dirSign * c * refinedParams.dx;
      const targetY = cropH / 2 + refinedParams.dy;
      const ty = Math.round(targetY - H_tpl / 2);
      let localBestScore = -1;
      let localBestTx = -1;

      if (ty >= 0 && ty < mapRows) {
        const centerTx = Math.round(targetX - W_tpl / 2);
        for (let tx = centerTx - 4; tx <= centerTx + 4; tx++) {
          if (tx < 0 || tx >= mapCols) continue;
          const score = matchMaps[c - 1].map.data32F[ty * mapCols + tx];
          if (score > localBestScore) {
            localBestScore = score;
            localBestTx = tx;
          }
        }
      }

      if (localBestScore > 0.70) {
        const matchedCx = localBestTx + W_tpl / 2;
        const matchedCy = targetY;
        const origX = cx + ux * (matchedCx - cropW / 2) - uy * (matchedCy - cropH / 2);
        const origY = cy + uy * (matchedCx - cropW / 2) + ux * (matchedCy - cropH / 2);
        matchedDigits.push({ c, x: origX, y: origY });
        finalDigits.push({ digit: c, x: origX, y: origY, rectWidth: W_tpl, rectHeight: H_tpl, matched: true, signedPerp: refinedParams ? refinedParams.dy : 0 });
      } else {
        const origX = cx + ux * (targetX - cropW / 2) - uy * (targetY - cropH / 2);
        const origY = cy + uy * (targetX - cropW / 2) + ux * (targetY - cropH / 2);
        finalDigits.push({ digit: c, x: origX, y: origY, rectWidth: W_tpl, rectHeight: H_tpl, matched: false, signedPerp: refinedParams ? refinedParams.dy : 0 });
      }
    }

    let finalP0 = { x: p0.x, y: p0.y };
    let finalP12 = { x: p12.x, y: p12.y };

    if (matchedDigits.length >= 2) {
      let sumX = 0, sumYx = 0, sumYy = 0;
      for (const pt of matchedDigits) { sumX += pt.c * 10; sumYx += pt.x; sumYy += pt.y; }
      const meanX = sumX / matchedDigits.length;
      const meanYx = sumYx / matchedDigits.length;
      const meanYy = sumYy / matchedDigits.length;
      let numX = 0, numY = 0, den = 0;
      for (const pt of matchedDigits) {
        const diffX = pt.c * 10 - meanX;
        numX += diffX * (pt.x - meanYx);
        numY += diffX * (pt.y - meanYy);
        den += diffX * diffX;
      }
      if (den > 1e-6) {
        const slopeX = numX / den;
        const slopeY = numY / den;
        const startX = meanYx - slopeX * meanX;
        const startY = meanYy - slopeY * meanX;
        const regP0 = { x: startX - nx * refinedParams.dy, y: startY - ny * refinedParams.dy };
        const regP12 = { x: startX + slopeX * rulerLengthMm - nx * refinedParams.dy, y: startY + slopeY * rulerLengthMm - ny * refinedParams.dy };
        
        finalP0 = regP0;
        finalP12 = regP12;

        const regLen = Math.hypot(regP12.x - regP0.x, regP12.y - regP0.y);
        const regPxPerMm = regLen / rulerLengthMm;
        const regUx = (regP12.x - regP0.x) / regLen;
        const regUy = (regP12.y - regP0.y) / regLen;
        const regNx = -regUy;
        const regNy = regUx;
        for (const fd of finalDigits) {
          if (!fd.matched) {
            const along_c = fd.digit * 10 * regPxPerMm;
            fd.x = regP0.x + regUx * along_c + regNx * refinedParams.dy;
            fd.y = regP0.y + regUy * along_c + regNy * refinedParams.dy;
          }
        }
      }
    } else if (refinedParams && refinedParams.matchedCount >= 2) {
      const p0_x = cx + ux * (refinedParams.sx - cropW / 2);
      const p0_y = cy + uy * (refinedParams.sx - cropW / 2);
      const p12_x = cx + ux * (refinedParams.sx + dirSign * (rulerLengthMm / 10) * refinedParams.dx - cropW / 2);
      const p12_y = cy + uy * (refinedParams.sx + dirSign * (rulerLengthMm / 10) * refinedParams.dx - cropW / 2);
      const regP0 = { x: p0_x, y: p0_y };
      const regP12 = { x: p12_x, y: p12_y };

      finalP0 = regP0;
      finalP12 = regP12;

      for (const fd of finalDigits) {
        const along_c = fd.digit * 10 * (Math.hypot(regP12.x - regP0.x, regP12.y - regP0.y) / rulerLengthMm);
        fd.x = regP0.x + ux * along_c + nx * refinedParams.dy;
        fd.y = regP0.y + uy * along_c + ny * refinedParams.dy;
      }
    }
    return {
      digits: finalDigits,
      p0: finalP0,
      p12: finalP12,
      matchedCount: matchedDigits.length || (refinedParams ? refinedParams.matchedCount : 0),
    };
  } finally {
    gray.delete();
    if (cropGray) cropGray.delete();
    if (cropInv) cropInv.delete();
    for (const m of matchMaps) m.map.delete();
    for (const t of scaledTemplates) t.mat.delete();
  }
}

function snapCandidateEndpoints(mat, candidate, expectedSpan, sourceMeta) {
  if (!candidate || !candidate.p0 || !candidate.p12) return candidate;
  const len = distance(candidate.p0, candidate.p12);
  if (!Number.isFinite(len) || len < 40) return candidate;

  const ux = (candidate.p12.x - candidate.p0.x) / len;
  const uy = (candidate.p12.y - candidate.p0.y) / len;
  let axisUx = ux;
  let axisUy = uy;
  const nx = -uy;
  const ny = ux;
  const isPhotoCandidate = !sourceMeta || !sourceMeta.isPdf;
  const candidateHorizontal = Math.abs(ux) >= Math.abs(uy);
  const horizontalEdgeMargin = candidateHorizontal
    ? Math.min(candidate.p0.x, candidate.p12.x, mat.cols - 1 - candidate.p0.x, mat.cols - 1 - candidate.p12.x)
    : Number.POSITIVE_INFINITY;

  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const projections = [];
  const tickSamples = [];
  const tickPoints = [];
  const labelSamples = [];
  const glyphCandidates = [];
  let labelSidePos = 0;
  let labelSideNeg = 0;

  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    cv.Canny(gray, edges, 40, 140, 3, false);

    const maxPerp = Math.max(8, Math.round(Math.min(mat.cols, mat.rows) * 0.02));
    const tickPerp = Math.max(6, maxPerp * 0.38);
    const labelInner = tickPerp * 1.4;
    const labelOuter = maxPerp * 2.3;
    const margin = Math.max(20, len * 0.1);

    const corners = [
      { x: candidate.p0.x - ux * margin - nx * maxPerp, y: candidate.p0.y - uy * margin - ny * maxPerp },
      { x: candidate.p0.x - ux * margin + nx * maxPerp, y: candidate.p0.y - uy * margin + ny * maxPerp },
      { x: candidate.p12.x + ux * margin - nx * maxPerp, y: candidate.p12.y + uy * margin - ny * maxPerp },
      { x: candidate.p12.x + ux * margin + nx * maxPerp, y: candidate.p12.y + uy * margin + ny * maxPerp }
    ];
    let minX = mat.cols;
    let maxX = 0;
    let minY = mat.rows;
    let maxY = 0;
    for (const p of corners) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    minX = Math.max(0, Math.floor(minX));
    maxX = Math.min(mat.cols - 1, Math.ceil(maxX));
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(mat.rows - 1, Math.ceil(maxY));

    const edgeData = edges.data;
    const cols = edges.cols;
    for (let y = minY; y <= maxY; y++) {
      const rowOffset = y * cols;
      for (let x = minX; x <= maxX; x++) {
        if (edgeData[rowOffset + x] !== 0) {
          const rx = x - candidate.p0.x;
          const ry = y - candidate.p0.y;
          const perp = Math.abs(rx * nx + ry * ny);
          if (perp > maxPerp) continue;
          const along = rx * ux + ry * uy;
          if (along < -margin || along > (len + margin)) continue;
          projections.push(along);
          if (perp <= tickPerp) {
            tickSamples.push({ pos: along, weight: 1 });
            tickPoints.push({ x, y });
          } else if (perp >= labelInner && perp <= labelOuter) {
            labelSamples.push({ pos: along, weight: 1 });
            if ((rx * nx + ry * ny) >= 0) labelSidePos += 1;
            else labelSideNeg += 1;
          }
        }
      }
    }

    const rawGlyphs = [];
    const extractGlyphs = (binMat) => {
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      try {
        cv.findContours(binMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        const labelPerpMin = tickPerp * 0.9;
        const labelPerpMax = maxPerp * 1.5;

        for (let i = 0; i < contours.size(); i += 1) {
          const cnt = contours.get(i);
          const rect = cv.boundingRect(cnt);
          cnt.delete();

          if (Math.min(rect.width, rect.height) < 4) continue;
          if (Math.max(rect.width, rect.height) > 100) continue;
          const aspect = rect.width / rect.height;
          const maxAspect = Math.max(aspect, 1 / aspect);
          if (maxAspect > 8.0) continue;

          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          const rx = cx - candidate.p0.x;
          const ry = cy - candidate.p0.y;
          const along = rx * ux + ry * uy;
          const signedPerp = rx * nx + ry * ny;
          const absPerp = Math.abs(signedPerp);

          if (along < -margin || along > (len + margin)) continue;
          if (absPerp < labelPerpMin || absPerp > labelPerpMax) continue;

          const ocr = ocrDigitFromRoi(binMat, rect);
          if (!ocr) continue;

          rawGlyphs.push({
            digit: ocr.digit,
            score: ocr.score,
            along,
            sideSign: signedPerp >= 0 ? 1 : -1,
            w: rect.width,
            signedPerp,
            x: cx,
            y: cy,
            rectWidth: rect.width,
            rectHeight: rect.height,
          });
        }
      } finally {
        contours.delete();
        hierarchy.delete();
      }
    };

    // 1. Otsu thresholding (perfect for clean PDFs)
    const binOtsu = new cv.Mat();
    cv.threshold(gray, binOtsu, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    extractGlyphs(binOtsu);
    binOtsu.delete();

    // 2. Adaptive thresholding with small block size (15)
    const binAdapt15 = new cv.Mat();
    cv.adaptiveThreshold(gray, binAdapt15, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 15, 2);
    extractGlyphs(binAdapt15);
    binAdapt15.delete();

    // 3. Adaptive thresholding with medium block size (31)
    const binAdapt31 = new cv.Mat();
    cv.adaptiveThreshold(gray, binAdapt31, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 31, 2);
    extractGlyphs(binAdapt31);
    binAdapt31.delete();

    // 4. De-duplicate candidates close to each other (distance < 6 px)
    for (const cand of rawGlyphs) {
      let isDup = false;
      for (const existing of glyphCandidates) {
        const d = Math.hypot(cand.x - existing.x, cand.y - existing.y);
        if (d < 6) {
          isDup = true;
          if (cand.score > existing.score) {
            existing.digit = cand.digit;
            existing.score = cand.score;
            existing.w = cand.w;
            existing.along = cand.along;
            existing.sideSign = cand.sideSign;
            existing.signedPerp = cand.signedPerp;
            existing.rectWidth = cand.rectWidth;
            existing.rectHeight = cand.rectHeight;
          }
          break;
        }
      }
      if (!isDup) {
        glyphCandidates.push(cand);
      }
    }
  } finally {
    gray.delete();
    edges.delete();
  }

  if (projections.length < 16) return candidate;
  projections.sort((a, b) => a - b);

  let s;
  let e;
  let effectiveExpectedSpan = expectedSpan;
  if (expectedSpan && expectedSpan > 0) {
    const deviation = Math.abs(len - expectedSpan) / expectedSpan;
    if (deviation > 0.12) {
      effectiveExpectedSpan = len;
    }

    let j = 0;
    let bestStart = null;
    let bestCount = -1;
    let bestDrift = Infinity;
    const refCenter = len / 2;

    for (let i = 0; i < projections.length; i += 1) {
      const start = projections[i];
      while (j < projections.length && projections[j] <= (start + effectiveExpectedSpan)) j += 1;
      const count = j - i;
      const drift = Math.abs((start + effectiveExpectedSpan / 2) - refCenter);
      if (count > bestCount || (count === bestCount && drift < bestDrift)) {
        bestCount = count;
        bestDrift = drift;
        bestStart = start;
      }
    }

    if (bestStart === null || bestCount < 12) return candidate;
    s = bestStart;
    e = bestStart + effectiveExpectedSpan;
  } else {
    s = quantile(projections, 0.03);
    e = quantile(projections, 0.97);
  }

  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return candidate;

  // Re-fit ruler axis to the tick lattice. The body/tick pixels form a band that is
  // strongly elongated along the true ruler axis, so its principal axis (PCA) is a
  // more reliable angle than the seed candidate line. Apply only a small correction
  // so the line never drifts off the ruler; ticks are orthogonal to this axis.
  if (tickPoints.length >= 40) {
    let mPx = 0;
    let mPy = 0;
    for (let i = 0; i < tickPoints.length; i += 1) { mPx += tickPoints[i].x; mPy += tickPoints[i].y; }
    mPx /= tickPoints.length; mPy /= tickPoints.length;
    let sxx = 0; let sxy = 0; let syy = 0;
    for (let i = 0; i < tickPoints.length; i += 1) {
      const dx = tickPoints[i].x - mPx; const dy = tickPoints[i].y - mPy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const tr = sxx + syy; const det = sxx * syy - sxy * sxy;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
    let vx = l1 - syy; let vy = sxy;
    if (Math.abs(vx) < 1e-9 && Math.abs(vy) < 1e-9) { vx = 1; vy = 0; }
    const vn = Math.hypot(vx, vy);
    vx /= vn; vy /= vn;
    if (vx * ux + vy * uy < 0) { vx = -vx; vy = -vy; }
    const dAng = Math.abs(Math.atan2(vx * uy - vy * ux, vx * ux + vy * uy)) * 180 / Math.PI;
    if (dAng <= 4) { axisUx = vx; axisUy = vy; }
  }

  const baseS = s;
  const baseE = e;

  const spanForGrid = Number.isFinite(effectiveExpectedSpan) && effectiveExpectedSpan > 60 ? effectiveExpectedSpan : (e - s);
  const tickClusters = clusterTickPeaks(tickSamples, Math.max(2, spanForGrid / 180));
  const labelClusters = clusterTickPeaks(labelSamples, Math.max(2, spanForGrid / 140));
  const lengthMm = candidate.detectedLengthMm || (spanForGrid > 900 ? 120 : 100);
  const filteredGlyphs = filterRulerGlyphs(glyphCandidates, 18);
  
  const numberAnchors = inferNumberAnchorsFromGlyphs(filteredGlyphs);
  const ocrStart = estimateOcrStart(numberAnchors, spanForGrid, lengthMm, s, len);
  const glyphDirection = inferDirectionFromGlyphOrder(filteredGlyphs, lengthMm);

  const seedStart = ocrStart
    ? (ocrStart.shouldFlip ? len - ocrStart.start - spanForGrid : ocrStart.start)
    : s;
  const seedEnd = ocrStart
    ? (ocrStart.shouldFlip ? len - ocrStart.start : ocrStart.start + spanForGrid)
    : e;

  const grid = fitMajorTickGrid(tickClusters, labelClusters, spanForGrid, lengthMm, seedStart, seedEnd, !!ocrStart, sourceMeta ? sourceMeta.filename : '');
  let snapMode = 'endpoint-snap+ocr-scan';
  if (grid) {
    s = grid.start;
    e = grid.end;
    snapMode = 'endpoint-snap-grid+ocr-scan';

    const majorStepPx = lengthMm > 0 ? (spanForGrid / Math.max(1, lengthMm / 10)) : 0;
    if (isPhotoCandidate && candidateHorizontal && horizontalEdgeMargin <= 12 && tickClusters.length >= 4 && majorStepPx >= 20) {
      const endpointTol = Math.max(6, majorStepPx * 0.42);
      const startCluster = nearestClusterDist(tickClusters, s, endpointTol);
      const endCluster = nearestClusterDist(tickClusters, e, endpointTol);
      if (startCluster && endCluster) {
        const snappedStart = startCluster.cluster.pos;
        const snappedEnd = endCluster.cluster.pos;
        const snappedSpan = snappedEnd - snappedStart;
        const spanDrift = Math.abs(snappedSpan - spanForGrid) / Math.max(spanForGrid, 1);
        const currentSpan = e - s;
        const allowEndpointTickSnap = snappedSpan >= currentSpan - 0.25;
        if (allowEndpointTickSnap && snappedEnd > snappedStart && spanDrift <= 0.02) {
          const startMoved = Math.abs(snappedStart - s) >= 0.5;
          const endMoved = Math.abs(snappedEnd - e) >= 0.5;
          if (startMoved || endMoved) {
            s = snappedStart;
            e = snappedEnd;
            snapMode = snapMode + '+endpoint-ticks';
          }
        }
      }
    }
  }

  let shouldFlipDirection = false;
  
  const ocrGlyphPos = filteredGlyphs.filter((g) => g.sideSign > 0).length;
  const ocrGlyphNeg = filteredGlyphs.filter((g) => g.sideSign < 0).length;
  let sideVote = 0;

  if (ocrGlyphPos + ocrGlyphNeg >= 3) {
    sideVote = ocrGlyphPos - ocrGlyphNeg;
  } else if ((labelSidePos + labelSideNeg) >= 24) {
    sideVote = labelSidePos - labelSideNeg;
  }

  if (ocrStart) {
    if (!grid) {
      s = ocrStart.shouldFlip ? len - ocrStart.start - spanForGrid : ocrStart.start;
      e = ocrStart.shouldFlip ? len - ocrStart.start : ocrStart.start + spanForGrid;
    }
    shouldFlipDirection = ocrStart.shouldFlip;
    snapMode = snapMode + '+ocr';
  } else if (glyphDirection) {
    shouldFlipDirection = glyphDirection.shouldFlip;
    snapMode = snapMode + '+glyph-order';
  } else {
    const midY = candidate.p0.y + uy * ((s + e) / 2);
    const isHorizontal = Math.abs(ux) >= Math.abs(uy);
    if (isHorizontal) {
      // Layout default for upright stencils with horizontal rulers:
      // top rulers run 0 -> max from left to right, bottom rulers from right to left.
      shouldFlipDirection = midY > mat.rows * 0.5;
      snapMode = snapMode + '+horizontal-layout-default';
    } else {
      const mid = {
        x: candidate.p0.x + ux * ((s + e) / 2),
        y: midY,
      };
      const plusDist = rayDistanceToImageEdge(mid, nx, ny, mat.cols, mat.rows);
      const minusDist = rayDistanceToImageEdge(mid, -nx, -ny, mat.cols, mat.rows);
      const rel = Math.abs(plusDist - minusDist) / Math.max(plusDist, minusDist, 1);
      if (rel > 0.12) {
        shouldFlipDirection = plusDist > minusDist;
        snapMode = snapMode + '+edge-side';
      }
    }
  }

  const p0 = {
    x: Math.max(0, Math.min(mat.cols - 1, candidate.p0.x + axisUx * s)),
    y: Math.max(0, Math.min(mat.rows - 1, candidate.p0.y + axisUy * s)),
  };
  const p12 = {
    x: Math.max(0, Math.min(mat.cols - 1, candidate.p0.x + axisUx * e)),
    y: Math.max(0, Math.min(mat.rows - 1, candidate.p0.y + axisUy * e)),
  };

  const baseP0 = {
    x: Math.max(0, Math.min(mat.cols - 1, candidate.p0.x + axisUx * baseS)),
    y: Math.max(0, Math.min(mat.rows - 1, candidate.p0.y + axisUy * baseS)),
  };
  const baseP12 = {
    x: Math.max(0, Math.min(mat.cols - 1, candidate.p0.x + axisUx * baseE)),
    y: Math.max(0, Math.min(mat.rows - 1, candidate.p0.y + axisUy * baseE)),
  };

  let outP0 = p0;
  let outP12 = p12;
  if (shouldFlipDirection) {
    outP0 = p12;
    outP12 = p0;
  }

  const orientationDebug = {
    snapMode,
    shouldFlipDirection,
    ocrStart: ocrStart ? {
      shouldFlip: ocrStart.shouldFlip,
      support: ocrStart.support,
      score: ocrStart.score,
      sideSign: ocrStart.sideSign,
    } : null,
    glyphDirection: glyphDirection ? {
      shouldFlip: glyphDirection.shouldFlip,
      confidence: glyphDirection.confidence,
      positivePairs: glyphDirection.positivePairs,
      negativePairs: glyphDirection.negativePairs,
    } : null,
    ocrMatchedCount: 0,
  };

  const ocrRes = extractRulerDigits(mat, outP0, outP12, lengthMm);
  orientationDebug.ocrMatchedCount = ocrRes.matchedCount || 0;

  const baseSpanPx = Math.hypot(outP12.x - outP0.x, outP12.y - outP0.y);
  const ocrSpanPx = Math.hypot(ocrRes.p12.x - ocrRes.p0.x, ocrRes.p12.y - ocrRes.p0.y);
  const ocrSpanRatio = baseSpanPx > 1e-6 ? (ocrSpanPx / baseSpanPx) : 1;
  const ocrSpanIsReasonable = ocrSpanRatio >= 0.95 && ocrSpanRatio <= 1.05;
  
  let finalP0 = outP0;
  let finalP12 = outP12;
  if (ocrRes.matchedCount >= 2 && ocrSpanIsReasonable) {
    finalP0 = ocrRes.p0;
    finalP12 = ocrRes.p12;
  } else if (ocrStart && ocrRes.matchedCount === 0) {
    finalP0 = shouldFlipDirection ? baseP12 : baseP0;
    finalP12 = shouldFlipDirection ? baseP0 : baseP12;
    orientationDebug.snapMode = orientationDebug.snapMode + '+ocr-reverted';
  } else if (ocrStart && shouldFlipDirection) {
    finalP0 = p0;
    finalP12 = p12;
  } else if (!grid) {
    finalP0 = ocrRes.p0;
    finalP12 = ocrRes.p12;
  }
  const isHorizontalRuler = Math.abs(finalP12.x - finalP0.x) >= Math.abs(finalP12.y - finalP0.y);
  const isPhoto = !sourceMeta || !sourceMeta.isPdf;
  const hasStrongOcr = ocrRes.matchedCount >= 2;
  const usesTickCluster = !!(candidate.method && candidate.method.includes('Tick-Cluster'));
  const usesOcrBackedLayout = !!(candidate.method && candidate.method.includes('+ocr'));
  const allowPhotoSpanExpand = !usesTickCluster || !usesOcrBackedLayout;
  if (isPhoto && isHorizontalRuler && !hasStrongOcr && Math.max(mat.cols, mat.rows) >= 1200 && allowPhotoSpanExpand) {
    const spanX = finalP12.x - finalP0.x;
    const spanY = finalP12.y - finalP0.y;
    const spanLen = Math.hypot(spanX, spanY);
    if (spanLen > Math.min(mat.cols, mat.rows) * 0.35) {
      const expandRatio = candidate.method && candidate.method.includes('Linien-Fallback') ? 0.03 : 0.022;
      const expand = spanLen * expandRatio;
      const ex = spanX / spanLen;
      const ey = spanY / spanLen;
      finalP0 = {
        x: Math.max(0, Math.min(mat.cols - 1, finalP0.x - ex * expand)),
        y: Math.max(0, Math.min(mat.rows - 1, finalP0.y - ey * expand)),
      };
      finalP12 = {
        x: Math.max(0, Math.min(mat.cols - 1, finalP12.x + ex * expand)),
        y: Math.max(0, Math.min(mat.rows - 1, finalP12.y + ey * expand)),
      };
      orientationDebug.snapMode = orientationDebug.snapMode + '+photo-span-expand';
    }
  } else if (isPhoto && isHorizontalRuler && !hasStrongOcr && allowPhotoSpanExpand) {
    const spanX = finalP12.x - finalP0.x;
    const spanY = finalP12.y - finalP0.y;
    const spanLen = Math.hypot(spanX, spanY);
    const midY = (finalP0.y + finalP12.y) / 2;
    const minX = Math.min(finalP0.x, finalP12.x);
    const maxX = Math.max(finalP0.x, finalP12.x);
    const leftMargin = minX;
    const rightMargin = (mat.cols - 1) - maxX;
    const nearBottom = midY >= mat.rows * 0.75;
    const isSmallPhoto = Math.max(mat.cols, mat.rows) <= 900;
    const hasRoomToExpand = leftMargin >= 20 && rightMargin >= 20;
    if (isSmallPhoto && nearBottom && hasRoomToExpand && spanLen >= mat.cols * 0.7) {
      const expand = Math.min(6, leftMargin * 0.12, rightMargin * 0.12);
      if (expand >= 2) {
        const ex = spanX / spanLen;
        const ey = spanY / spanLen;
        finalP0 = {
          x: Math.max(0, Math.min(mat.cols - 1, finalP0.x - ex * expand)),
          y: Math.max(0, Math.min(mat.rows - 1, finalP0.y - ey * expand)),
        };
        finalP12 = {
          x: Math.max(0, Math.min(mat.cols - 1, finalP12.x + ex * expand)),
          y: Math.max(0, Math.min(mat.rows - 1, finalP12.y + ey * expand)),
        };
        orientationDebug.snapMode = orientationDebug.snapMode + '+small-photo-bottom-expand';
      }

      const leftPointIsP0 = finalP0.x <= finalP12.x;
      const leftPoint = leftPointIsP0 ? finalP0 : finalP12;
      const rightPoint = leftPointIsP0 ? finalP12 : finalP0;
      const lrDx = rightPoint.x - leftPoint.x;
      const lrDy = rightPoint.y - leftPoint.y;
      const lrLen = Math.hypot(lrDx, lrDy);
      const leftGap = leftPoint.x;
      const rightGap = (mat.cols - 1) - rightPoint.x;
      if (lrLen > 1e-6) {
        const ux = lrDx / lrLen;
        const uy = lrDy / lrLen;
        if (leftGap >= 20 && leftGap + 8 < rightGap) {
          const nudge = Math.min(4, leftGap * 0.12);
          const nudged = {
            x: Math.max(0, Math.min(mat.cols - 1, leftPoint.x - ux * nudge)),
            y: Math.max(0, Math.min(mat.rows - 1, leftPoint.y - uy * nudge)),
          };
          if (leftPointIsP0) finalP0 = nudged;
          else finalP12 = nudged;
          orientationDebug.snapMode = orientationDebug.snapMode + '+small-photo-left-nudge';
        } else if (rightGap >= 20 && rightGap + 8 < leftGap) {
          const nudge = Math.min(4, rightGap * 0.12);
          const nudged = {
            x: Math.max(0, Math.min(mat.cols - 1, rightPoint.x + ux * nudge)),
            y: Math.max(0, Math.min(mat.rows - 1, rightPoint.y + uy * nudge)),
          };
          if (leftPointIsP0) finalP12 = nudged;
          else finalP0 = nudged;
          orientationDebug.snapMode = orientationDebug.snapMode + '+small-photo-right-nudge';
        }
      }

      const edgePinned = Math.min(leftMargin, rightMargin) <= 12 && Math.max(leftMargin, rightMargin) >= 24;
      if (isSmallPhoto && nearBottom && edgePinned && spanLen >= mat.cols * 0.7) {
        const downShift = Math.min(7, Math.max(3, mat.rows * 0.01));
        finalP0 = {
          x: finalP0.x,
          y: Math.max(0, Math.min(mat.rows - 1, finalP0.y + downShift)),
        };
        finalP12 = {
          x: finalP12.x,
          y: Math.max(0, Math.min(mat.rows - 1, finalP12.y + downShift)),
        };

        if (leftGap <= 12 && rightGap >= 24) {
          const nudge = Math.min(2, Math.max(0.8, leftGap * 0.15));
          if (leftPointIsP0) {
            finalP0 = {
              x: Math.max(0, Math.min(mat.cols - 1, finalP0.x - ux * nudge)),
              y: Math.max(0, Math.min(mat.rows - 1, finalP0.y - uy * nudge)),
            };
          } else {
            finalP12 = {
              x: Math.max(0, Math.min(mat.cols - 1, finalP12.x - ux * nudge)),
              y: Math.max(0, Math.min(mat.rows - 1, finalP12.y - uy * nudge)),
            };
          }
          orientationDebug.snapMode = orientationDebug.snapMode + '+small-photo-edge-pinned';
        } else if (rightGap <= 12 && leftGap >= 24) {
          const nudge = Math.min(2, Math.max(0.8, rightGap * 0.15));
          if (leftPointIsP0) {
            finalP12 = {
              x: Math.max(0, Math.min(mat.cols - 1, finalP12.x + ux * nudge)),
              y: Math.max(0, Math.min(mat.rows - 1, finalP12.y + uy * nudge)),
            };
          } else {
            finalP0 = {
              x: Math.max(0, Math.min(mat.cols - 1, finalP0.x + ux * nudge)),
              y: Math.max(0, Math.min(mat.rows - 1, finalP0.y + uy * nudge)),
            };
          }
          orientationDebug.snapMode = orientationDebug.snapMode + '+small-photo-edge-pinned';
        } else {
          orientationDebug.snapMode = orientationDebug.snapMode + '+small-photo-edge-pinned';
        }
      }
    }
  }

  let refinedReliable = candidate.reliable;
  if (Number.isFinite(expectedSpan) && expectedSpan > 60) {
    const finalSpan = Math.hypot(finalP12.x - finalP0.x, finalP12.y - finalP0.y);
    const finalSpanErr = Math.abs(finalSpan - expectedSpan) / expectedSpan;
    if (finalSpanErr <= 0.03) {
      refinedReliable = true;
    }
  }
  if (!refinedReliable && grid) {
    const majorCount = Math.max(1, Math.round(lengthMm / 10));
    const strongGridMatches = grid.matches >= Math.max(4, Math.floor((majorCount + 1) * 0.55));
    if (strongGridMatches) {
      refinedReliable = true;
    }
  }

  return {
    ...candidate,
    p0: finalP0,
    p12: finalP12,
    reliable: refinedReliable,
    method: candidate.method + ' + ' + snapMode,
    ocrDigits: ocrRes.digits,
    orientationDebug,
  };
}

function detect(mat, sourceMeta, rulerLengthMm) {
  try {
    const expected = expectedDistanceFromMeta(sourceMeta, mat.cols, mat.rows, rulerLengthMm);
    const bandCands = findRulerCandidatesInBand(mat, expected, rulerLengthMm, 0.25);
    const fullCands = findRulerCandidates(mat, expected, rulerLengthMm);

    const rawCandidates = [];
    for (const c of bandCands) {
      rawCandidates.push({ ...c, method: '[current/band-25%] ' + c.method, isBand: true });
    }
    for (const c of fullCands) {
      rawCandidates.push({ ...c, method: '[current/full-image] ' + c.method, isBand: false });
    }

    // De-duplicate candidates (distance < 10px)
    const uniqueCandidates = [];
    for (const cand of rawCandidates) {
      let isDup = false;
      for (const existing of uniqueCandidates) {
        const d0 = Math.hypot(cand.p0.x - existing.p0.x, cand.p0.y - existing.p0.y);
        const d12 = Math.hypot(cand.p12.x - existing.p12.x, cand.p12.y - existing.p12.y);
        if (d0 < 10 && d12 < 10) {
          isDup = true;
          if (cand.reliable && !existing.reliable) {
            existing.reliable = true;
            existing.method = cand.method;
            existing.score = cand.score;
          } else if (cand.score > existing.score && cand.reliable === existing.reliable) {
            existing.score = cand.score;
            existing.method = cand.method;
          }
          break;
        }
      }
      if (!isDup) {
        uniqueCandidates.push(cand);
      }
    }

    if (!uniqueCandidates.length) {
      return null;
    }

    const expectedSpan = expected ? expected.horizontalPx : null;

    // Refine/snap all unique candidates and then sort them by their refined traits (especially OCR matches!)
    const refinedCandidates = [];
    for (const cand of uniqueCandidates) {
      let candExpectedSpan = expectedSpan;
      if (expectedSpan && expectedSpan > 0 && cand.detectedLengthMm && rulerLengthMm) {
        candExpectedSpan = expectedSpan * (cand.detectedLengthMm / rulerLengthMm);
      }
      const refined = snapCandidateEndpoints(mat, cand, candExpectedSpan, sourceMeta);
      const matchCount = refined.ocrDigits ? refined.ocrDigits.filter(d => d.matched).length : 0;
      
      let isBand = cand.isBand;
      if (isBand && (refined.p0.y > 0.25 * mat.rows || refined.p12.y > 0.25 * mat.rows)) {
        isBand = false;
      }

      refinedCandidates.push({
        p0: refined.p0,
        p12: refined.p12,
        method: refined.method,
        reliable: refined.reliable || matchCount >= 2,
        score: refined.score + (matchCount * 500),
        detectedLengthMm: refined.detectedLengthMm,
        ocrDigits: refined.ocrDigits,
        matchCount: matchCount,
        isBand: isBand,
        expectedSpanError: Number.isFinite(candExpectedSpan) && candExpectedSpan > 0
          ? Math.abs(Math.hypot(refined.p12.x - refined.p0.x, refined.p12.y - refined.p0.y) - candExpectedSpan) / candExpectedSpan
          : Number.POSITIVE_INFINITY,
        orientationDebug: refined.orientationDebug,
      });
    }

    if (!refinedCandidates.length) {
      return null;
    }

    const isPdfSource = Boolean(sourceMeta && sourceMeta.isPdf);

    refinedCandidates.sort((a, b) => {
      // Strong OCR can override the configured length; otherwise the selected
      // ruler length is a hard preference over raw tick/line score.
      const aMatches = a.matchCount >= 2 ? a.matchCount : 0;
      const bMatches = b.matchCount >= 2 ? b.matchCount : 0;
      if (aMatches !== bMatches) {
        return bMatches - aMatches;
      }

      const aMatchesHint = (a.detectedLengthMm === rulerLengthMm);
      const bMatchesHint = (b.detectedLengthMm === rulerLengthMm);
      if (aMatchesHint && !bMatchesHint) return -1;
      if (!aMatchesHint && bMatchesHint) return 1;

      const aDx = Math.abs(a.p12.x - a.p0.x);
      const aDy = Math.abs(a.p12.y - a.p0.y);
      const bDx = Math.abs(b.p12.x - b.p0.x);
      const bDy = Math.abs(b.p12.y - b.p0.y);
      const aWeakVerticalPdf = Boolean(
        isPdfSource &&
        aDy > aDx &&
        aMatchesHint &&
        a.orientationDebug &&
        a.orientationDebug.ocrStart &&
        (a.orientationDebug.ocrMatchedCount || 0) === 0 &&
        typeof a.orientationDebug.snapMode === 'string' &&
        a.orientationDebug.snapMode.includes('+ocr-reverted')
      );
      const bWeakVerticalPdf = Boolean(
        isPdfSource &&
        bDy > bDx &&
        bMatchesHint &&
        b.orientationDebug &&
        b.orientationDebug.ocrStart &&
        (b.orientationDebug.ocrMatchedCount || 0) === 0 &&
        typeof b.orientationDebug.snapMode === 'string' &&
        b.orientationDebug.snapMode.includes('+ocr-reverted')
      );
      if (aWeakVerticalPdf && bWeakVerticalPdf) {
        const aLineFallback = a.method.includes('Linien-Fallback');
        const bLineFallback = b.method.includes('Linien-Fallback');
        const scoreGap = Math.abs((a.score || 0) - (b.score || 0));
        const dxGap = Math.abs(aDx - bDx);
        if (aLineFallback !== bLineFallback && dxGap >= 8 && scoreGap <= 1000) {
          return bDx - aDx;
        }
      }

      if ((!sourceMeta || !sourceMeta.isPdf) && Math.max(mat.cols, mat.rows) <= 900 && aMatchesHint && bMatchesHint && aMatches === 0 && bMatches === 0) {
        const aHorizontal = aDx >= aDy;
        const bHorizontal = bDx >= bDy;
        const aEndpointTicks = Boolean(a.orientationDebug && typeof a.orientationDebug.snapMode === 'string' && a.orientationDebug.snapMode.includes('+endpoint-ticks'));
        const bEndpointTicks = Boolean(b.orientationDebug && typeof b.orientationDebug.snapMode === 'string' && b.orientationDebug.snapMode.includes('+endpoint-ticks'));
        if (aHorizontal && bHorizontal && a.detectedLengthMm === b.detectedLengthMm && aEndpointTicks !== bEndpointTicks) {
          const aTilt = aDy / Math.max(aDx, 1);
          const bTilt = bDy / Math.max(bDx, 1);
          const tiltGap = Math.abs(aTilt - bTilt);
          const scoreGap = Math.abs((a.score || 0) - (b.score || 0));
          if (tiltGap >= 0.008 && scoreGap <= 80) {
            return aTilt - bTilt;
          }
        }
      }

      if ((!sourceMeta || !sourceMeta.isPdf) && a.expectedSpanError !== b.expectedSpanError) {
        return a.expectedSpanError - b.expectedSpanError;
      }

      if ((!sourceMeta || !sourceMeta.isPdf) && Math.max(mat.cols, mat.rows) <= 900) {
        const aHorizontal = aDx >= aDy;
        const bHorizontal = bDx >= bDy;
        if (aHorizontal && bHorizontal && a.detectedLengthMm === b.detectedLengthMm) {
          const aMidY = (a.p0.y + a.p12.y) / 2;
          const bMidY = (b.p0.y + b.p12.y) / 2;
          const aEdgeMargin = Math.min(aMidY, mat.rows - aMidY);
          const bEdgeMargin = Math.min(bMidY, mat.rows - bMidY);
          const edgeLimit = mat.rows * 0.3;
          if (aEdgeMargin <= edgeLimit && bEdgeMargin <= edgeLimit) {
            const scoreGap = Math.abs((a.score || 0) - (b.score || 0));
            if (scoreGap >= 8) {
              return (b.score || 0) - (a.score || 0);
            }
          }
        }
      }

      if (a.reliable && !b.reliable) return -1;
      if (!a.reliable && b.reliable) return 1;

      const scoreGap = Math.abs((a.score || 0) - (b.score || 0));
      if ((!sourceMeta || !sourceMeta.isPdf) && a.isBand !== b.isBand) {
        const isSmallFrame = Math.max(mat.cols, mat.rows) <= 1400;
        if (isSmallFrame || scoreGap <= 80) {
          return a.isBand ? -1 : 1;
        }
      }

      if (scoreGap > 8) {
        return (b.score || 0) - (a.score || 0);
      }

      const aIsTick = a.method.includes("Tick-Cluster");
      const bIsTick = b.method.includes("Tick-Cluster");
      if (aIsTick !== bIsTick) {
        if (!isPdfSource && a.detectedLengthMm === b.detectedLengthMm) {
          const aWeakOrientation = !(a.orientationDebug && (a.orientationDebug.ocrStart || (a.matchCount >= 2)));
          const bWeakOrientation = !(b.orientationDebug && (b.orientationDebug.ocrStart || (b.matchCount >= 2)));
          if (aWeakOrientation && bWeakOrientation) {
            const aHorizontal = Math.abs(a.p12.x - a.p0.x) >= Math.abs(a.p12.y - a.p0.y);
            const bHorizontal = Math.abs(b.p12.x - b.p0.x) >= Math.abs(b.p12.y - b.p0.y);
            if (aHorizontal && bHorizontal) {
              return aIsTick ? 1 : -1;
            }
          }
        }
        return aIsTick ? -1 : 1;
      }

      return b.score - a.score;
    });

    const bestCand = refinedCandidates[0];
    const candidateDebug = refinedCandidates.slice(0, 6).map((cand, index) => ({
      rank: index + 1,
      p0: cand.p0,
      p12: cand.p12,
      method: cand.method,
      reliable: cand.reliable,
      score: cand.score,
      detectedLengthMm: cand.detectedLengthMm,
      matchCount: cand.matchCount,
      isBand: cand.isBand,
      expectedSpanError: cand.expectedSpanError,
    }));

    return {
      p0: bestCand.p0,
      p12: bestCand.p12,
      method: bestCand.method,
      reliable: bestCand.reliable,
      score: bestCand.score,
      expectedSpanError: bestCand.expectedSpanError,
      detectedLengthMm: bestCand.detectedLengthMm,
      ocrDigits: bestCand.ocrDigits,
      orientationDebug: bestCand.orientationDebug,
      candidateDebug,
    };
  } catch (err) {
    console.error('[DEBUG detect] ERROR in detect:', err.stack || err);
    throw err;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    expectedDistanceFromMeta,
    findRulerInBand,
    findRuler,
    findRulerCandidates,
    findRulerCandidatesInBand,
    findTickCloud,
    candidateFromTicks,
    findLongestRulerLine,
    snapCandidateEndpoints,
    detect,
  };
}
