/**
 * js/candidate-ranking.js
 * Shared ruler-candidate ranking helpers.
 *
 * The cross-pass sorter in detectionWorker.js and the per-pass sorter in
 * ruler-detector.js historically duplicated the same photo tie-break rules,
 * which had to be edited in lockstep and were prone to silent drift. This
 * module is the single source of truth for those shared rules.
 *
 * Each comparator operates on a normalized item:
 *   {
 *     dx, dy,            // |p12.x - p0.x|, |p12.y - p0.y|
 *     score,             // candidate score
 *     detectedLengthMm,  // detected ruler length
 *     isBand,            // came from the band-restricted pass
 *     isLineFallback,    // method is a Linien-Fallback
 *     isTick,            // method is a Tick-Cluster
 *     hasEndpointTicks,  // snapMode used +endpoint-ticks
 *     frameMaxDim,       // max(cols, rows) of the candidate's frame
 *   }
 * Returns a comparator number (<0, 0, >0); 0 means "no decision, fall through".
 */
(function () {
  /**
   * Photo-only horizontal tie-breaks for near-equal candidates. Mirrors the
   * exact rules previously inlined in both sorters.
   */
  function comparePhotoHorizontalTieBreaks(a, b) {
    const aHorizontal = a.dx >= a.dy;
    const bHorizontal = b.dx >= b.dy;
    if (!aHorizontal || !bHorizontal) return 0;
    if (Math.max(a.frameMaxDim, b.frameMaxDim) > 900) return 0;
    if (a.detectedLengthMm !== b.detectedLengthMm) return 0;

    const scoreGap = Math.abs((a.score || 0) - (b.score || 0));

    // 1) Prefer the full-image candidate over a band candidate when exactly one
    //    of the pair is a line fallback and scores are close.
    if (a.isBand !== b.isBand && a.isLineFallback !== b.isLineFallback && scoreGap <= 140) {
      return a.isBand ? 1 : -1;
    }

    // 2) Prefer a flatter tick-cluster over a tilted line fallback.
    if (a.isLineFallback !== b.isLineFallback && a.isTick !== b.isTick) {
      const aTilt = a.dy / Math.max(a.dx, 1);
      const bTilt = b.dy / Math.max(b.dx, 1);
      if (Math.abs(aTilt - bTilt) >= 0.012 && scoreGap <= 140) {
        return aTilt - bTilt;
      }
    }

    // 3) When only one candidate used endpoint-tick snapping, prefer the flatter.
    if (a.hasEndpointTicks !== b.hasEndpointTicks) {
      const aTilt = a.dy / Math.max(a.dx, 1);
      const bTilt = b.dy / Math.max(b.dx, 1);
      if (Math.abs(aTilt - bTilt) >= 0.008 && scoreGap <= 80) {
        return aTilt - bTilt;
      }
    }

    return 0;
  }

  const api = { comparePhotoHorizontalTieBreaks };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.candidateRanking = api;
  }
})();
