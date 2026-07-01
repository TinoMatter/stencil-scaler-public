/**
 * js/app.js
 * Frontend application controller and UI handlers.
 */

// Worker Source mapping (will be modified for offline package)
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const OCR_KEYWORDS = ["datum", "coloplast", "stoma", "messschablone", "name"];

const ocrMirrorCache = new Map();

// UI Elements
const dateiInput = document.getElementById("dateiInput");
const batchInput = document.getElementById("batchInput");
const rulerLengthInput = document.getElementById("rulerLengthInput");
const rulerLengthCustomInput = document.getElementById("rulerLengthCustomInput");
const erkennenBtn = document.getElementById("erkennenBtn");
const manuellBtn = document.getElementById("manuellBtn");
const downloadBtn = document.getElementById("downloadBtn");
const printBtn = document.getElementById("printBtn");
const batchBtn = document.getElementById("batchBtn");
const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
const canvasContainer = previewCanvas.parentElement;
const selectedFileName = document.getElementById("selectedFileName");
const versionSwitcher = document.getElementById("versionSwitcher");
const versionSelect = document.getElementById("versionSelect");
const browserWarning = document.getElementById("browserWarning");
const dismissBrowserWarning = document.getElementById("dismissBrowserWarning");
const statusBox = document.getElementById("statusBox");
const autoAlarm = document.getElementById("autoAlarm");
const busyIndicator = document.getElementById("busyIndicator");
const manualNote = document.getElementById("manualNote");
const batchLog = document.getElementById("batchLog");
const abortBtn = document.getElementById("abortBtn");

const MAG_RADIUS = 70;
const MAG_DISPLAY_SIZE = MAG_RADIUS * 2;
const magnifierCanvas = document.createElement("canvas");
magnifierCanvas.style.position = "absolute";
magnifierCanvas.style.left = "0px";
magnifierCanvas.style.top = "0px";
magnifierCanvas.style.width = `${MAG_DISPLAY_SIZE}px`;
magnifierCanvas.style.height = `${MAG_DISPLAY_SIZE}px`;
magnifierCanvas.style.pointerEvents = "none";
magnifierCanvas.style.zIndex = "20";
magnifierCanvas.style.display = "none";
magnifierCanvas.style.opacity = "0.7";
const magnifierCtx = magnifierCanvas.getContext("2d");
if (canvasContainer) {
  canvasContainer.appendChild(magnifierCanvas);
}

// Web Worker for non-blocking file loading
let loadWorker = null;

// Web Worker for non-blocking detection
let detectionWorker = null;
let currentDetectionResolver = null;
let currentDetectionRejecter = null;

function initDetectionWorker() {
  if (detectionWorker) {
    detectionWorker.terminate();
  }
  detectionWorker = new Worker("js/detectionWorker.js?v=" + Date.now());
  appState.detectionWorker = detectionWorker;
  
  detectionWorker.onmessage = ({ data }) => {
    const { type, percent, result, error, width, height, buffer } = data;
    
    if (type === "cvReady") {
      appState.cvReady = true;
      setStatus("OpenCV.js ist geladen. Datei kann verarbeitet werden.");
      if (appState.sourceCanvas && !appState.calibration) {
        startAutoDetection();
      }
      const files = batchInput.files ? batchInput.files.length : 0;
      batchBtn.disabled = files === 0;
    } else if (type === "progress") {
      setUploadProgress(percent);
    } else if (type === "success") {
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = width;
      outputCanvas.height = height;
      const ctx = outputCanvas.getContext("2d");
      const imgData = ctx.createImageData(width, height);
      imgData.data.set(new Uint8ClampedArray(buffer));
      ctx.putImageData(imgData, 0, 0);
      
      result.outputCanvas = outputCanvas;
      
      // Sync preprocessed crop offsets and scale back to sourceMeta on main thread
      if (appState.sourceMeta) {
        appState.sourceMeta.scale = result.scale;
        appState.sourceMeta.cropX = result.cropX;
        appState.sourceMeta.cropY = result.cropY;
        appState.sourceMeta.angle = result.angleDeg || 0;
        appState.sourceMeta.sourceWidthPx = result.sourceWidthPx || (appState.sourceCanvas ? appState.sourceCanvas.width : undefined);
        appState.sourceMeta.sourceHeightPx = result.sourceHeightPx || (appState.sourceCanvas ? appState.sourceCanvas.height : undefined);
        appState.sourceMeta.croppedWidth = result.croppedWidth || (appState.processedCanvas ? appState.processedCanvas.width : undefined);
        appState.sourceMeta.croppedHeight = result.croppedHeight || (appState.processedCanvas ? appState.processedCanvas.height : undefined);
      }
      
      // Update appState OCR cache fields if needed
      appState.outputOcrNormalWords = result.ocrWordsNormal;
      appState.outputOcrMirroredWords = result.ocrWordsMirrored;
      appState.outputMirrored = result.mirrored;
      
      if (currentDetectionResolver) {
        currentDetectionResolver(result);
        currentDetectionResolver = null;
        currentDetectionRejecter = null;
      }
    } else if (type === "error") {
      if (currentDetectionRejecter) {
        currentDetectionRejecter(new Error(error));
        currentDetectionResolver = null;
        currentDetectionRejecter = null;
      }
    }
  };
  
  detectionWorker.onerror = (err) => {
    console.error("Fehler im Detection-Worker:", err);
    if (currentDetectionRejecter) {
      currentDetectionRejecter(new Error("Detection-Worker Fehler: " + err.message));
      currentDetectionResolver = null;
      currentDetectionRejecter = null;
    }
  };
}

const methodValue = document.getElementById("methodValue");
const angleValue = document.getElementById("angleValue");
const distanceValue = document.getElementById("distanceValue");
const resolutionValue = document.getElementById("resolutionValue");
const sizeValue = document.getElementById("sizeValue");
const ocrNormalValue = document.getElementById("ocrNormalValue");
const ocrMirroredValue = document.getElementById("ocrMirroredValue");

// Application State
const appState = {
  cvReady: false,
  sourceName: "",
  originalFile: null,
  sourceCanvas: null,
  sourceMeta: null,
  processedCanvas: null,
  calibration: null,
  manualActive: false,
  manualPoints: [],
  manualPlacement: { active: false, mode: null, cursor: null, keyboardAdjusted: false },
  drag: { active: false, mode: null, last: null, cursor: null },
  alarmActive: false,
  outputOcrNormalWords: [],
  outputOcrMirroredWords: [],
  outputMirrored: null,
  ocrBusy: false,
  ocrRequestId: 0,
  userOverrodeLength: false,
  abortActive: false,
};
window.appState = appState;

function getPublicRootUrl() {
  let path = window.location.pathname.replace(/index\.html$/, "");
  path = path.replace(/\/v\/[^/]+\/?$/, "/");
  if (!path.endsWith("/")) {
    path += "/";
  }
  return new URL(path, window.location.origin);
}

function getCurrentVersionSha() {
  const path = window.location.pathname.replace(/index\.html$/, "");
  const match = path.match(/\/v\/([^/]+)\/?$/);
  return match ? match[1] : "";
}

function isLikelySafari() {
  const ua = navigator.userAgent || "";
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|OPiOS|Firefox|FxiOS|Android/i.test(ua);
}

function initBrowserWarning() {
  if (!browserWarning || !dismissBrowserWarning) {
    return;
  }

  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem("dismissSafariWarning") === "1";
  } catch (_) {
    dismissed = false;
  }

  if (isLikelySafari() && !dismissed) {
    browserWarning.style.display = "block";
  }

  dismissBrowserWarning.addEventListener("click", () => {
    browserWarning.style.display = "none";
    try {
      window.localStorage.setItem("dismissSafariWarning", "1");
    } catch (_) {
      // Ignore storage failures and still dismiss for the current session.
    }
  });
}

async function initVersionSwitcher() {
  if (!versionSwitcher || !versionSelect) {
    return;
  }

  try {
    const rootUrl = getPublicRootUrl();
    const response = await fetch(new URL("versions.json", rootUrl));
    if (!response.ok) {
      throw new Error(`versions.json unavailable (${response.status})`);
    }
    const versions = await response.json();
    if (!Array.isArray(versions) || versions.length === 0) {
      versionSwitcher.hidden = true;
      return;
    }

    const latestSha = versions[0] && versions[0].sha ? versions[0].sha : "";
    const currentSha = getCurrentVersionSha();
    const options = [`<option value="__latest__">Aktuell${latestSha ? ` (${latestSha})` : ""}</option>`];

    for (const version of versions) {
      if (!version || !version.sha || version.sha === latestSha) {
        continue;
      }
      const dateLabel = version.date ? ` - ${version.date}` : "";
      options.push(`<option value="${version.sha}">${version.sha}${dateLabel}</option>`);
    }

    versionSelect.innerHTML = options.join("");
    versionSelect.value = currentSha || "__latest__";
    versionSwitcher.hidden = false;

    versionSelect.addEventListener("change", () => {
      const selected = versionSelect.value;
      const targetUrl = selected === "__latest__"
        ? new URL("./", rootUrl)
        : new URL(`v/${selected}/`, rootUrl);
      window.location.href = targetUrl.toString();
    });
  } catch (_) {
    versionSwitcher.hidden = true;
  }
}

function detectExpectedRulerLengthFromFilename(filename) {
  if (!filename) return 12;
  let cleaned = filename.trim().toLowerCase();
  
  // Strip standard date formats like DD.MM.YYYY or DD.MM.YY to avoid matching day prefix
  cleaned = cleaned.replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, "");

  if (cleaned.includes("publicare") || cleaned.includes("0-10") || cleaned.includes("spontantest") || cleaned.includes("spontan_test")) {
    return 10;
  }
  const match = cleaned.match(/(?:^|\D)(\d+)(?:\.[^.]+)?$/) || cleaned.match(/(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if ([1, 2, 3, 4, 5, 6, 11, 16].includes(num)) {
      return 10;
    }
  }
  return 12;
}
window.detectExpectedRulerLengthFromFilename = detectExpectedRulerLengthFromFilename;

function getRulerLengthCm() {
  if (rulerLengthInput && rulerLengthInput.value === "custom") {
    return parseFloat(rulerLengthCustomInput.value) || 12;
  }
  return parseFloat(rulerLengthInput ? rulerLengthInput.value : 12) || 12;
}

function getRulerLengthMm() {
  return getRulerLengthCm() * 10;
}
window.getRulerLengthMm = getRulerLengthMm;

function updateSelectedFileName(name = "") {
  if (!selectedFileName) return;
  selectedFileName.textContent = name || "Keine Datei ausgewählt.";
}

function updateRulerLengthUi() {
  const len = getRulerLengthCm();
  manuellBtn.textContent = `Manuell 0 cm und ${len} cm setzen`;
  manualNote.textContent = `Manuell aktiv: erst 0 cm, dann ${len} cm im Bild klicken.`;
  if (!appState.calibration || appState.calibration.pixelDist === undefined) {
    distanceValue.textContent = `0-${len} cm Distanz (px): -`;
  } else {
    distanceValue.textContent = `0-${len} cm Distanz (px): ` + appState.calibration.pixelDist.toFixed(2);
  }
  if (rulerLengthInput.value === "custom") {
    rulerLengthCustomInput.style.display = "inline-block";
  } else {
    rulerLengthCustomInput.style.display = "none";
  }
}
window.updateRulerLengthUi = updateRulerLengthUi;

// Initialize background detection worker
initDetectionWorker();
initVersionSwitcher();
initBrowserWarning();

// Event Listeners
rulerLengthInput.addEventListener("change", () => {
  appState.userOverrodeLength = true;
  updateRulerLengthUi();
  if (appState.calibration) {
    appState.calibration.detectedLengthMm = getRulerLengthMm();
    updateCalibrationFromLine(
      "Manuell angepasst",
      appState.calibration.lineReliable,
      appState.calibration.forceLineScale
    );
  }
});

rulerLengthCustomInput.addEventListener("input", () => {
  appState.userOverrodeLength = true;
  updateRulerLengthUi();
  if (appState.calibration) {
    appState.calibration.detectedLengthMm = getRulerLengthMm();
    updateCalibrationFromLine(
      "Manuell angepasst",
      appState.calibration.lineReliable,
      appState.calibration.forceLineScale
    );
  }
});

dateiInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  updateSelectedFileName(file.name);
  resetStateForNewFile();
  updateSelectedFileName(file.name);
  const defaultLength = detectExpectedRulerLengthFromFilename(file.name);
  if (defaultLength === 10) {
    rulerLengthInput.value = "10";
  } else {
    rulerLengthInput.value = "12";
  }
  updateRulerLengthUi();

  appState.originalFile = file;
  appState.sourceName = file.name;
  appState.abortActive = false;
  setStatus("Datei wird geladen ...");
  setBusy(true, "Datei wird geladen ...");
  setUploadProgress(0);

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    // Standard JPEG/PNG image: load directly on the main thread (createImageBitmap is non-blocking)
    imageFileToCanvas(file).then((canvas) => {
      if (appState.abortActive) return;
      appState.sourceCanvas = canvas;
      appState.sourceMeta = { filename: file.name, isPdf: false, pageIndex: 1 };
      drawBaseCanvas(canvas);
      erkennenBtn.disabled = false;
      manuellBtn.disabled = false;
      setUploadProgress(100);
      if (appState.cvReady) startAutoDetection(); else setBusy(false);
    }).catch((err) => {
      setStatus("Fehler beim Laden des Bildes: " + err.message, true);
      setBusy(false);
    });
    return;
  }

  const reader = new FileReader();
  reader.onprogress = (e) => {
    if (e.lengthComputable) setUploadProgress((e.loaded / e.total) * 100);
  };
  reader.onerror = () => {
    setStatus("Fehler beim Lesen: " + reader.error, true);
    setBusy(false);
  };
  reader.onload = () => {
    if (appState.abortActive) return;
    // Offload PDF rendering to worker
    if (loadWorker) {
      loadWorker.terminate();
      loadWorker = null;
    }
    setStatus("Datei geladen. Auto-Erkennung startet ...");
    setUploadProgress(100);

    loadWorker = new Worker("js/loadWorker.js?v=" + Date.now());
    const loadId = Math.random().toString(36).slice(2);
    loadWorker.onerror = (err) => {
      setStatus("Fehler im Lade-Worker: " + err.message, true);
      setBusy(false);
      loadWorker.terminate();
      loadWorker = null;
    };
    loadWorker.onmessage = ({ data }) => {
      const { id, bitmap, sourceMeta, error } = data;
      if (id !== loadId) return;
      loadWorker.terminate();
      loadWorker = null;
      if (error) {
        setStatus("Fehler beim Rendering: " + error, true);
        setBusy(false);
        return;
      }
      if (appState.abortActive) return;
      const off = document.createElement("canvas");
      off.width = bitmap.width;
      off.height = bitmap.height;
      off.getContext("2d").drawImage(bitmap, 0, 0);
      appState.sourceCanvas = off;
      appState.sourceMeta = sourceMeta;
      // ensure preview is updated in a single place
      drawBaseCanvas(off);
      erkennenBtn.disabled = false;
      manuellBtn.disabled = false;
      if (appState.abortActive) return;
      if (appState.cvReady) startAutoDetection(); else setBusy(false);
    };
    loadWorker.postMessage({ id: loadId, arrayBuffer: reader.result, fileType: file.type, fileName: file.name }, [reader.result]);
  };
  reader.readAsArrayBuffer(file);
});

abortBtn.addEventListener("click", () => {
  if (loadWorker) {
    loadWorker.terminate();
    loadWorker = null;
  }
  if (detectionWorker) {
    detectionWorker.terminate();
    detectionWorker = null;
  }
  initDetectionWorker();

  appState.abortActive = true;
  resetStateForNewFile();

  if (currentDetectionRejecter) {
    currentDetectionRejecter(new Error("Erkennung abgebrochen"));
    currentDetectionResolver = null;
    currentDetectionRejecter = null;
  }

  if (appState.sourceCanvas) {
    drawBaseCanvas(appState.sourceCanvas);
    setStatus("Erkennung abgebrochen. Sie können manuell kalibrieren oder eine neue Datei laden.");
    enableFallbackCalibration("Erkennung abgebrochen (Manuell)");
  } else {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    setStatus("Erkennung abgebrochen. Bitte eine neue Datei laden.");
  }
});

function enableFallbackCalibration(methodName) {
  if (!appState.sourceCanvas) return;
  const w = appState.sourceCanvas.width;
  const h = appState.sourceCanvas.height;
  const p0 = { x: w * 0.2, y: h * 0.4 };
  const p12 = { x: w * 0.8, y: h * 0.4 };
  appState.processedCanvas = appState.sourceCanvas;
  appState.calibration = {
    method: methodName,
    p0,
    p12,
    lineReliable: false,
    showRulerLine: true,
    overlayColor: "#d97706",
    forceLineScale: true,
    angleDeg: 0,
    detectedLengthMm: getRulerLengthMm() || 120,
  };
  updateCalibrationFromLine(methodName, false, true);
  downloadBtn.disabled = false;
  printBtn.disabled = false;
}

erkennenBtn.addEventListener("click", async () => {
  await startAutoDetection();
});

manuellBtn.addEventListener("click", () => {
  if (!appState.processedCanvas) {
    setStatus("Bitte zuerst eine Datei laden.", true);
    return;
  }
  appState.manualActive = true;
  appState.manualPoints = [];
  appState.manualHover = null;
  appState.manualPlacement = { active: false, mode: null, cursor: null, keyboardAdjusted: false };
  manualNote.style.display = "block";
  const len = getRulerLengthCm();
  setStatus(`Manuell aktiv: Klicken Sie nahe der 0 cm Markierung, bewegen Sie das Fadenkreuz, klicken Sie zum Setzen.`);
});

previewCanvas.addEventListener("mousedown", (event) => {
  if (!appState.calibration || appState.manualActive) return;
  const p = canvasCoordinateFromClick(event, previewCanvas);
  if (!p) return;
});

previewCanvas.addEventListener("mousemove", (event) => {
  const p = canvasCoordinateFromClick(event, previewCanvas);
  if (!p) return;

  if (appState.manualPlacement.active) {
    appState.manualPlacement.cursor = p;
    appState.manualPlacement.keyboardAdjusted = false;
    previewCanvas.style.cursor = "none";
    drawCurrentPreview();
    return;
  }

  if (!appState.calibration || appState.manualActive) {
    previewCanvas.style.cursor = appState.manualActive ? "crosshair" : "default";
    if (appState.manualActive) drawCurrentPreview();
    return;
  }

  if (!appState.drag.active) {
    const hover = determineHoverMode(p);
    if (hover === "p0" || hover === "p12") {
      previewCanvas.style.cursor = "pointer";
    } else if (hover === "line") {
      previewCanvas.style.cursor = "grab";
    } else {
      previewCanvas.style.cursor = "default";
    }
    return;
  }

  previewCanvas.style.cursor = "none";
  applyDragMove(p);
});

window.addEventListener("mousemove", (event) => {
  if (!appState.drag.active || !appState.calibration || appState.manualActive) return;
  const rect = previewCanvas.getBoundingClientRect();
  const isInsideCanvas = (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
  if (isInsideCanvas) return;
  const p = canvasCoordinateFromClick(event, previewCanvas);
  if (!p) return;
  applyDragMove(p);
});

window.addEventListener("mouseup", () => {
  if (appState.drag.active) {
    appState.drag = { active: false, mode: null, last: null, cursor: null };
    previewCanvas.style.cursor = "default";
    drawCurrentPreview();
    updateOcrDiagnosticsFromCalibration();
  }
});

previewCanvas.addEventListener("mouseleave", () => {
  if (!appState.drag.active) {
    previewCanvas.style.cursor = appState.manualActive ? "crosshair" : "default";
  }
  if (appState.manualActive && !appState.manualPlacement.active) {
    appState.manualHover = null;
    drawCurrentPreview();
  }
});

previewCanvas.addEventListener("click", (event) => {
  if (!appState.processedCanvas) return;
  const p = canvasCoordinateFromClick(event, previewCanvas);
  if (!p) return;

  if (appState.manualPlacement.active) {
    completeManualPlacement(appState.manualPlacement.keyboardAdjusted ? appState.manualPlacement.cursor : p);
    return;
  }

  if (!appState.manualActive && appState.calibration) {
    const mode = determineHoverMode(p);
    if (mode === "p0" || mode === "p12") {
      beginManualPlacement(mode, p);
    }
    return;
  }

  if (!appState.manualActive) return;

  const mode = appState.manualPoints.length === 0 ? "p0" : "p12";
  beginManualPlacement(mode, p);
});

window.addEventListener("keydown", (event) => {
  if (!appState.manualPlacement.active || !appState.manualPlacement.cursor) return;
  const deltas = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = deltas[event.key];
  if (!delta) return;

  event.preventDefault();
  const step = event.shiftKey ? 5 : (event.altKey ? 0.1 : 0.25);
  const width = appState.processedCanvas ? appState.processedCanvas.width : previewCanvas.width;
  const height = appState.processedCanvas ? appState.processedCanvas.height : previewCanvas.height;
  appState.manualPlacement.cursor = {
    x: Math.max(0, Math.min(width - 1, appState.manualPlacement.cursor.x + delta[0] * step)),
    y: Math.max(0, Math.min(height - 1, appState.manualPlacement.cursor.y + delta[1] * step)),
  };
  appState.manualPlacement.keyboardAdjusted = true;
  drawCurrentPreview();
});

function beginManualPlacement(mode, p) {
  appState.manualPlacement = { active: true, mode, cursor: p, keyboardAdjusted: false };
  appState.manualHover = null;
  previewCanvas.style.cursor = "none";
  const len = getRulerLengthCm();
  const label = mode === "p0" ? "0 cm" : `${len} cm`;
  setStatus(`${label} Markierung ausgewählt. Bewegen, bei Bedarf mit Pfeiltasten feinjustieren, dann klicken zum Setzen.`);
  drawCurrentPreview();
}

function completeManualPlacement(p) {
  if (!p) return;
  const placement = appState.manualPlacement;
  const mode = placement.mode;
  appState.manualPlacement = { active: false, mode: null, cursor: null, keyboardAdjusted: false };

  if (!appState.manualActive && appState.calibration && (mode === "p0" || mode === "p12")) {
    appState.calibration[mode] = { x: p.x, y: p.y };
    updateCalibrationFromLine("Feinjustiert (Klick)", true, true);
    updateOcrDiagnosticsFromCalibration();
    previewCanvas.style.cursor = "default";
    drawCurrentPreview();
    setStatus(`${mode === "p0" ? "0 cm" : `${getRulerLengthCm()} cm`} Markierung aktualisiert.`);
    return;
  }

  if (!appState.manualActive) return;

  if (mode === "p0") {
    appState.manualPoints = [{ x: p.x, y: p.y }];
    const len = getRulerLengthCm();
    previewCanvas.style.cursor = "crosshair";
    setStatus(`0 cm Markierung gesetzt. Klicken Sie nahe der ${len} cm Markierung, bewegen Sie das Fadenkreuz, klicken Sie zum Setzen.`);
    drawCurrentPreview();
    return;
  }

  const p0 = appState.manualPoints[0];
  const p12 = { x: p.x, y: p.y };
  const len = getRulerLengthCm();
  appState.calibration = {
    method: `Manuell gesetzt (0 -> ${len} cm)`,
    p0,
    p12,
    lineReliable: true,
    showRulerLine: true,
    overlayColor: "#0ea55f",
    forceLineScale: true,
    angleDeg: appState.calibration ? appState.calibration.angleDeg : 0,
    detectedLengthMm: getRulerLengthMm(),
  };

  appState.manualActive = false;
  appState.manualPoints = [];
  appState.manualHover = null;
  manualNote.style.display = "none";
  updateCalibrationFromLine(appState.calibration.method, true, true);
  updateOcrDiagnosticsFromCalibration();
  setAutoAlarm(false);
  setStatus(`Manuelle Kalibrierung (0 bis ${len} cm) übernommen. Ausgabe ist bereit.`);
}

// Automatic Training Data & Ground Truth Unified Upload Logic
async function autoSaveCalibration() {
  // Disabled: OneDrive / Offline bundle generation is now handled via ZIP download directly.
}

printBtn.addEventListener("click", async () => {
  if (!appState.calibration || !appState.processedCanvas) {
    setStatus("Please run detection first.", true);
    return;
  }

  try {
    printBtn.disabled = true;
    setStatus("Druckansicht wird vorbereitet ...");

    await printCanvasDirect(appState.calibration, appState.processedCanvas);
  } catch (err) {
    setStatus("Fehler beim Drucken: " + err.message, true);
  } finally {
    printBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!appState.calibration || !appState.processedCanvas || !appState.originalFile) {
    setStatus("Bitte zuerst Erkennung durchführen.", true);
    return;
  }

  try {
    downloadBtn.disabled = true;
    setStatus("Zip-Archiv wird erstellt ...");

    // 1. Generate PDF
    const pdfBlob = await generateA4Pdf(appState.calibration, appState.processedCanvas);
    
    // 2. Generate JSON Ground Truth
    const jsonStr = JSON.stringify({
      filename: appState.sourceName,
      coordinateSpace: "processed",
      processedWidth: appState.processedCanvas.width,
      processedHeight: appState.processedCanvas.height,
      sourceWidth: appState.sourceCanvas ? appState.sourceCanvas.width : null,
      sourceHeight: appState.sourceCanvas ? appState.sourceCanvas.height : null,
      processedTransform: {
        cropX: appState.sourceMeta ? appState.sourceMeta.cropX || 0 : 0,
        cropY: appState.sourceMeta ? appState.sourceMeta.cropY || 0 : 0,
        scale: appState.sourceMeta ? appState.sourceMeta.scale || 1 : 1,
        angle: appState.sourceMeta ? appState.sourceMeta.angle || 0 : 0,
        croppedWidth: appState.sourceMeta ? appState.sourceMeta.croppedWidth || appState.processedCanvas.width : appState.processedCanvas.width,
        croppedHeight: appState.sourceMeta ? appState.sourceMeta.croppedHeight || appState.processedCanvas.height : appState.processedCanvas.height
      },
      p0: { x: parseFloat(appState.calibration.p0.x.toFixed(2)), y: parseFloat(appState.calibration.p0.y.toFixed(2)) },
      p12: { x: parseFloat(appState.calibration.p12.x.toFixed(2)), y: parseFloat(appState.calibration.p12.y.toFixed(2)) },
      rulerLengthMm: appState.calibration.detectedLengthMm || 120,
      method: appState.calibration.method
    }, null, 2);

    // 3. Create Zip Bundle
    const zip = new JSZip();
    const baseName = filenameWithoutExtension(appState.sourceName);
    
    // Add the original file under a new name with _orig suffix
    const originalName = appState.originalFile.name;
    const origFileName = originalName.replace(/(\.[^/.]+)$/, '_orig$1');
    zip.file(origFileName, appState.originalFile);
    zip.file(`${baseName}_scaled.pdf`, pdfBlob);
    zip.file(`${baseName}_ground_truth.json`, jsonStr);

    const zipBlob = await zip.generateAsync({ type: "blob" });
    await ladeBlobHerunter(zipBlob, `${baseName}_bundle.zip`);
    
    setStatus("Zip-Archiv erfolgreich erstellt und heruntergeladen.");
  } catch (err) {
    setStatus("Fehler bei Zip-Erstellung: " + err.message, true);
  } finally {
    downloadBtn.disabled = false;
  }
});


batchInput.addEventListener("change", () => {
  const files = batchInput.files ? batchInput.files.length : 0;
  batchBtn.disabled = !appState.cvReady || files === 0;
});

batchBtn.addEventListener("click", async () => {
  const files = Array.from(batchInput.files || []);
  if (!files.length) {
    setStatus("Bitte Batch-Dateien auswählen.", true);
    return;
  }

  setBusy(true, "Batch wird verarbeitet ...");
  setBatchLogStart(files.length);
  batchBtn.disabled = true;
  let ok = 0;

  for (let i = 0; i < files.length; i += 1) {
    try {
      const source = await loadFileAsSource(files[i]);
      const result = await autoDetectFromSource(source.canvas, source.sourceMeta);
      const cal = calculateCalibrationFromLine(result, result.outputCanvas);
      const blob = await generateA4Pdf(cal, result.outputCanvas);
      await ladeBlobHerunter(blob, filenameWithoutExtension(files[i].name) + " scaled.pdf");
      writeBatchLog(files[i].name + " : OK (" + result.method + ")", "ok");
      ok += 1;
    } catch (err) {
      writeBatchLog(files[i].name + " : FEHLER - " + err.message, "error");
    }
  }

  setStatus(`Batch fertig: ${ok}/${files.length} erfolgreich.`);
  batchBtn.disabled = false;
  setBusy(false);
});

async function autoDetectFromSource(sourceCanvas, sourceMeta) {
  const rulerLengthMm = getRulerLengthMm();
  
  const ctx = sourceCanvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const buffer = imageData.data.buffer;
  
  return new Promise((resolve, reject) => {
    currentDetectionResolver = resolve;
    currentDetectionRejecter = reject;
    
    detectionWorker.postMessage({
      type: "detect",
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      buffer,
      sourceMeta,
      rulerLengthMm
    }, [buffer]);
  });
}

async function startAutoDetection() {
  if (!appState.sourceCanvas) {
    setStatus("Bitte zuerst eine Datei laden.", true);
    return;
  }

  appState.abortActive = false;

  try {
    setBusy(true, "Erkennung läuft ...");
    setStatus("Auto-Erkennung läuft ...");
    const result = await autoDetectFromSource(appState.sourceCanvas, appState.sourceMeta);

    if (appState.abortActive) throw new Error("Erkennung abgebrochen");

    appState.processedCanvas = result.outputCanvas;
    appState.calibration = {
      method: result.method,
      p0: result.p0,
      p12: result.p12,
      lineReliable: result.lineReliable,
      showRulerLine: true,
      overlayColor: result.lineReliable ? "#00a651" : "#d97706",
      forceLineScale: result.lineReliable,
      angleDeg: result.angleDeg,
      detectedLengthMm: result.detectedLengthMm,
      ocrDigits: result.ocrDigits || [],
      orientationDebug: result.orientationDebug || null,
      candidateDebug: result.candidateDebug || [],
      isFlipped: result.isFlipped || false,
    };

    if (result.detectedLengthMm === 100) {
      rulerLengthInput.value = "10";
    } else if (result.detectedLengthMm === 120) {
      rulerLengthInput.value = "12";
    } else {
      rulerLengthInput.value = "custom";
      rulerLengthCustomInput.value = (result.detectedLengthMm / 10).toString();
    }
    updateCalibrationFromLine(result.method, result.lineReliable, true);
    updateRulerLengthUi();
    await updateOcrDiagnosticsFromCalibration();

    if (appState.abortActive) throw new Error("Erkennung abgebrochen");

    if (!result.lineReliable) {
      setAutoAlarm(true, "ALARM: Automatische Erkennung unsicher. Vorschlagslinie prüfen, dann per Drag-and-Drop oder manuell korrigieren.");
      setStatus("Automatik unsicher: Bitte Vorschlagslinie prüfen.");
    } else {
      setAutoAlarm(false);
      if (appState.calibration.imageBreiteMm > A4_WIDTH_MM || appState.calibration.imageHöheMm > A4_HEIGHT_MM) {
        setStatus("Verarbeitung abgeschlossen. Hinweis: Inhalt ist bei 1:1 größer als A4 und kann beschnitten werden.");
      } else {
        setStatus("Verarbeitung abgeschlossen. PDF kann heruntergeladen werden.");
      }
    }

    downloadBtn.disabled = false;
    printBtn.disabled = false;
  } catch (err) {
    if (err.message === "Erkennung abgebrochen" || appState.abortActive) {
      // Handled by abortBtn click.
    } else {
      setStatus("Erkennung fehlgeschlagen: " + err.message + ". A default calibration line has been set.", true);
      enableFallbackCalibration("Standard-Vorgabe (Erkennung fehlgeschlagen)");
    }
  } finally {
    setBusy(false);
  }
}

function drawBaseCanvas(canvas) {
  previewCanvas.width = canvas.width;
  previewCanvas.height = canvas.height;
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.drawImage(canvas, 0, 0);
}

function hideMagnifierOverlay() {
  magnifierCanvas.style.display = "none";
}

function drawMagnifierOverlay(dragPoint, angle) {
  if (!dragPoint || !appState.processedCanvas) {
    hideMagnifierOverlay();
    return;
  }

  const magRadius = MAG_RADIUS;
  const zoom = 2.5;
  const lensSize = MAG_DISPLAY_SIZE;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const requiredPx = Math.round(lensSize * dpr);
  if (magnifierCanvas.width !== requiredPx || magnifierCanvas.height !== requiredPx) {
    magnifierCanvas.width = requiredPx;
    magnifierCanvas.height = requiredPx;
  }

  magnifierCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  magnifierCtx.imageSmoothingEnabled = true;
  magnifierCtx.imageSmoothingQuality = "high";

  const scaleX = previewCanvas.clientWidth / Math.max(1, previewCanvas.width);
  const scaleY = previewCanvas.clientHeight / Math.max(1, previewCanvas.height);

  const cssCenterX = dragPoint.x * scaleX;
  const cssCenterY = dragPoint.y * scaleY;

  magnifierCanvas.style.display = "block";
  magnifierCanvas.style.transform = `translate(${cssCenterX - magRadius}px, ${cssCenterY - magRadius}px)`;

  magnifierCtx.clearRect(0, 0, lensSize, lensSize);

  magnifierCtx.save();
  magnifierCtx.beginPath();
  magnifierCtx.arc(magRadius, magRadius, magRadius, 0, 2 * Math.PI);
  magnifierCtx.clip();

  magnifierCtx.fillStyle = "#ffffff";
  magnifierCtx.fillRect(0, 0, lensSize, lensSize);

  const imgW = appState.processedCanvas.width;
  const imgH = appState.processedCanvas.height;
  const sampleX = Math.max(0, Math.min(imgW - 1, dragPoint.x));
  const sampleY = Math.max(0, Math.min(imgH - 1, dragPoint.y));

  const srcSize = lensSize / zoom;
  let sx = sampleX - srcSize / 2;
  let sy = sampleY - srcSize / 2;
  let sw = srcSize;
  let sh = srcSize;
  let dx = 0;
  let dy = 0;
  let dw = lensSize;
  let dh = lensSize;

  if (sx < 0) {
    const diff = -sx;
    sx = 0;
    sw -= diff;
    dx += diff * zoom;
    dw -= diff * zoom;
  }
  if (sy < 0) {
    const diff = -sy;
    sy = 0;
    sh -= diff;
    dy += diff * zoom;
    dh -= diff * zoom;
  }

  if (sx + sw > imgW) {
    const diff = (sx + sw) - imgW;
    sw -= diff;
    dw -= diff * zoom;
  }
  if (sy + sh > imgH) {
    const diff = (sy + sh) - imgH;
    sh -= diff;
    dh -= diff * zoom;
  }

  if (sw > 0 && sh > 0 && dw > 0 && dh > 0) {
    magnifierCtx.drawImage(appState.processedCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  magnifierCtx.restore();

  magnifierCtx.save();
  magnifierCtx.beginPath();
  magnifierCtx.arc(magRadius, magRadius, magRadius, 0, 2 * Math.PI);
  magnifierCtx.strokeStyle = "#1e293b";
  magnifierCtx.lineWidth = 3;
  magnifierCtx.stroke();

  magnifierCtx.beginPath();
  magnifierCtx.arc(magRadius, magRadius, magRadius - 1.5, 0, 2 * Math.PI);
  magnifierCtx.strokeStyle = "#ffffff";
  magnifierCtx.lineWidth = 1;
  magnifierCtx.stroke();

  magnifierCtx.translate(magRadius, magRadius);
  magnifierCtx.rotate(angle || 0);
  magnifierCtx.strokeStyle = "#ff00ff";
  magnifierCtx.lineWidth = 1.5;

  magnifierCtx.beginPath();
  magnifierCtx.moveTo(-magRadius, 0);
  magnifierCtx.lineTo(magRadius, 0);
  magnifierCtx.stroke();

  magnifierCtx.beginPath();
  magnifierCtx.moveTo(0, -magRadius);
  magnifierCtx.lineTo(0, magRadius);
  magnifierCtx.stroke();
  magnifierCtx.restore();
}

function getActiveGuideAngle(dragPoint, placement) {
  if (placement && dragPoint) {
    if (appState.manualActive && placement.mode === "p12" && appState.manualPoints.length === 1) {
      const p0 = appState.manualPoints[0];
      return Math.atan2(dragPoint.y - p0.y, dragPoint.x - p0.x);
    }
    if (appState.calibration) {
      const p0 = placement.mode === "p0" ? dragPoint : appState.calibration.p0;
      const p12 = placement.mode === "p12" ? dragPoint : appState.calibration.p12;
      return Math.atan2(p12.y - p0.y, p12.x - p0.x);
    }
  }

  if (appState.calibration) {
    const p0 = appState.calibration.p0;
    const p12 = appState.calibration.p12;
    return Math.atan2(p12.y - p0.y, p12.x - p0.x);
  }

  return 0;
}

function drawCurrentPreview() {
  if (!appState.processedCanvas || (!appState.calibration && !appState.manualActive)) {
    if (appState.sourceCanvas) drawBaseCanvas(appState.sourceCanvas);
    return;
  }

  drawBaseCanvas(appState.processedCanvas);

  const placement = appState.manualPlacement && appState.manualPlacement.active
    ? appState.manualPlacement
    : null;
  const placementCursor = placement && placement.cursor ? placement.cursor : null;

  // Only keep the ruler-orthogonal guide so placement stays aligned without covering the ruler.
  const isDragging = appState.drag && appState.drag.active && (appState.drag.mode === "p0" || appState.drag.mode === "p12");
  const showPlacementCrosshair = Boolean(placementCursor);
  if (isDragging || showPlacementCrosshair) {
    const dragPoint = showPlacementCrosshair
      ? placementCursor
      : appState.drag.cursor || (appState.drag.mode === "p0" ? appState.calibration.p0 : appState.calibration.p12);
    const angle = getActiveGuideAngle(dragPoint, placement);

    previewCtx.save();
    previewCtx.translate(dragPoint.x, dragPoint.y);
    previewCtx.rotate(angle);
    previewCtx.strokeStyle = "rgba(220, 38, 38, 0.45)"; // Soft red
    previewCtx.lineWidth = 1.5;
    previewCtx.setLineDash([6, 4]);

    // Perpendicular line
    previewCtx.beginPath();
    previewCtx.moveTo(0, -3000);
    previewCtx.lineTo(0, 3000);
    previewCtx.stroke();
    
    previewCtx.restore();
  }
  
  if (appState.calibration) {
    const p0 = placementCursor && placement.mode === "p0"
      ? placementCursor
      : appState.calibration.p0;
    const p12 = placementCursor && placement.mode === "p12"
      ? placementCursor
      : appState.calibration.p12;
    const color = appState.calibration.overlayColor || (appState.calibration.lineReliable ? "#00a651" : "#d97706");

    previewCtx.save();
    if (!appState.calibration.lineReliable) {
      previewCtx.setLineDash([10, 7]);
    }
    previewCtx.strokeStyle = color;
    previewCtx.fillStyle = color;
    previewCtx.lineWidth = Math.max(1.5, previewCanvas.width / 800);
    previewCtx.beginPath();
    previewCtx.moveTo(p0.x, p0.y);
    previewCtx.lineTo(p12.x, p12.y);
    previewCtx.stroke();
    previewCtx.setLineDash([]);

    // Support dynamic ruler length (e.g. 100mm vs 120mm) instead of hardcoded 120
    const snapMm = appState.calibration.detectedLengthMm || getRulerLengthMm() || 120;

    drawEndpointMarker(previewCtx, p0, p12, color, `0`, 0.625);
    drawEndpointMarker(previewCtx, p12, p0, color, `${snapMm / 10}`, 0.5);
    
    // Draw tickmarks along the ruler
    const dx = p12.x - p0.x;
    const dy = p12.y - p0.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    
    const pxPerMm = len / snapMm;
    
    // Scale tick marks proportionally to canvas size so they are beautifully visible
    const maxDim = Math.max(previewCanvas.width, previewCanvas.height);
    const cmLen = Math.max(20, Math.round(maxDim / 80)); // 1 cm tick length
    const halfCmLen = Math.round(cmLen * 0.7);
    const mmLen = Math.round(cmLen * 0.45);
    
    const origWidth = previewCtx.lineWidth;
    
    for (let i = 0; i <= snapMm; i++) {
      const isCm = (i % 10 === 0);
      const isHalfCm = (i % 5 === 0 && !isCm);
      
      let tickLength = mmLen;
      let tickWidth = Math.max(2, origWidth * 0.8);
      
      if (isCm) {
        tickLength = cmLen;
        tickWidth = Math.max(5, origWidth * 1.8);
      } else if (isHalfCm) {
        tickLength = halfCmLen;
        tickWidth = Math.max(3.5, origWidth * 1.3);
      }
      
      const pxOffset = i * pxPerMm;
      const tx = p0.x + ux * pxOffset;
      const ty = p0.y + uy * pxOffset;
      
      previewCtx.beginPath();
      previewCtx.lineWidth = tickWidth;
      previewCtx.moveTo(tx, ty);
      previewCtx.lineTo(tx + nx * tickLength, ty + ny * tickLength);
      previewCtx.stroke();
    }
    
    previewCtx.lineWidth = origWidth;
    previewCtx.restore();
  }



  if (appState.manualActive && appState.manualPoints.length === 1) {
    const p0 = appState.manualPoints[0];
    previewCtx.fillStyle = "#0ea55f";
    zeichnePunkt(previewCtx, p0.x, p0.y, 7);

    if (placementCursor && placement.mode === "p12") {
      const p12 = placementCursor;
      const color = "#0ea55f";

      previewCtx.save();
      previewCtx.setLineDash([5, 5]);
      previewCtx.strokeStyle = color;
      previewCtx.lineWidth = Math.max(1.5, previewCanvas.width / 800);
      previewCtx.beginPath();
      previewCtx.moveTo(p0.x, p0.y);
      previewCtx.lineTo(p12.x, p12.y);
      previewCtx.stroke();
      previewCtx.setLineDash([]);

      const snapMm = getRulerLengthMm() || 120;
      drawEndpointMarker(previewCtx, p0, p12, color, `0`, 0.625);
      drawEndpointMarker(previewCtx, p12, p0, color, `${snapMm / 10}`, 0.5);

      // Draw tickmarks along the hover line
      const dx = p12.x - p0.x;
      const dy = p12.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len > 10) {
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;

        const pxPerMm = len / snapMm;

        const maxDim = Math.max(previewCanvas.width, previewCanvas.height);
        const cmLen = Math.max(20, Math.round(maxDim / 80));
        const halfCmLen = Math.round(cmLen * 0.7);
        const mmLen = Math.round(cmLen * 0.45);

        const origWidth = previewCtx.lineWidth;

        for (let i = 0; i <= snapMm; i++) {
          const isCm = (i % 10 === 0);
          const isHalfCm = (i % 5 === 0 && !isCm);

          let tickLength = mmLen;
          let tickWidth = Math.max(2, origWidth * 0.8);

          if (isCm) {
            tickLength = cmLen;
            tickWidth = Math.max(5, origWidth * 1.8);
          } else if (isHalfCm) {
            tickLength = halfCmLen;
            tickWidth = Math.max(3.5, origWidth * 1.3);
          }

          const pxOffset = i * pxPerMm;
          const tx = p0.x + ux * pxOffset;
          const ty = p0.y + uy * pxOffset;

          previewCtx.beginPath();
          previewCtx.lineWidth = tickWidth;
          previewCtx.moveTo(tx, ty);
          previewCtx.lineTo(tx + nx * tickLength, ty + ny * tickLength);
          previewCtx.stroke();
        }
        previewCtx.lineWidth = origWidth;
      }
      previewCtx.restore();
    }
  }

  // Draw magnifying lens in overlay canvas so it can extend into the shell padding.
  if (isDragging || placementCursor) {
    let dragPoint;
    if (placementCursor) {
      dragPoint = placementCursor;
    } else if (isDragging) {
      dragPoint = appState.drag.cursor || (appState.drag.mode === "p0" ? appState.calibration.p0 : appState.calibration.p12);
    }
    const angle = getActiveGuideAngle(dragPoint, placement);
    drawMagnifierOverlay(dragPoint, angle);
  } else {
    hideMagnifierOverlay();
  }
}

function updateMetrics() {
  const rulerLengthCm = getRulerLengthCm();
  if (!appState.calibration) {
    methodValue.textContent = "Methode: -";
    angleValue.textContent = "Korrekturwinkel: -";
    distanceValue.textContent = `0-${rulerLengthCm} cm Distanz (px): -`;
    resolutionValue.textContent = "Berechnete Auflösung: -";
    sizeValue.textContent = "Bildgröße bei 1:1: -";
    ocrNormalValue.textContent = "OCR (Normal): -";
    ocrMirroredValue.textContent = "OCR (Gespiegelt): -";
    return;
  }

  const c = appState.calibration;
  methodValue.textContent = "Methode: " + c.method;
  angleValue.textContent = "Korrekturwinkel: " + (c.angleDeg || 0).toFixed(2) + "°";
  distanceValue.textContent = `0-${rulerLengthCm} cm Distanz (px): ` + c.pixelDist.toFixed(2);
  resolutionValue.textContent = "Berechnete Auflösung: " + c.pxPerMm.toFixed(4) + " px/mm";
  sizeValue.textContent = "Bildgröße bei 1:1: " + c.imageBreiteMm.toFixed(2) + " mm × " + c.imageHöheMm.toFixed(2) + " mm";
  const busyText = appState.ocrBusy ? "läuft ..." : "-";
  const wordsNormal = appState.outputOcrNormalWords && appState.outputOcrNormalWords.length
    ? appState.outputOcrNormalWords.join(", ")
    : busyText;
  const wordsMirrored = appState.outputOcrMirroredWords && appState.outputOcrMirroredWords.length
    ? appState.outputOcrMirroredWords.join(", ")
    : busyText;
  ocrNormalValue.textContent = "OCR (Normal): " + wordsNormal;
  ocrMirroredValue.textContent = "OCR (Gespiegelt): " + wordsMirrored;
}
window.updateMetrics = updateMetrics;

function resetStateForNewFile() {
  appState.calibration = null;
  appState.processedCanvas = null;
  appState.originalFile = null;
  appState.sourceName = "";
  appState.manualActive = false;
  appState.manualPoints = [];
  appState.manualHover = null;
  appState.manualPlacement = { active: false, mode: null, cursor: null, keyboardAdjusted: false };
  appState.drag = { active: false, mode: null, last: null, cursor: null };
  appState.outputOcrNormalWords = [];
  appState.outputOcrMirroredWords = [];
  appState.outputMirrored = null;
  appState.ocrBusy = false;
  appState.ocrRequestId += 1;
  appState.userOverrodeLength = false;
  
  // Clear file inputs so the same file can be re-selected
  if (dateiInput) dateiInput.value = "";
  if (batchInput) batchInput.value = "";
  updateSelectedFileName();

  manualNote.style.display = "none";
  setAutoAlarm(false);
  setBusy(false);
  downloadBtn.disabled = true;
  printBtn.disabled = true;
  updateMetrics();
}

// Reset upload progress bar to default indeterminate state
function setUploadProgress(percent) {
  const bar = busyIndicator.querySelector('.busy-bar');
  if (bar) {
    bar.classList.remove('indeterminate');
    bar.style.width = Math.min(100, Math.max(0, percent)) + '%';
  }
}

function setAutoAlarm(aktiv, text = "") {
  appState.alarmActive = aktiv;
  if (!aktiv) {
    autoAlarm.style.display = "none";
    autoAlarm.textContent = "";
    return;
  }
  autoAlarm.textContent = text || "ALARM: Automatische Erkennung unsicher.";
  autoAlarm.style.display = "block";
}

function setBusy(aktiv, text = "Erkennung läuft ...") {
  if (!busyIndicator) {
    return;
  }
  if (!aktiv) {
    busyIndicator.style.display = "none";
    return;
  }

  const busyLabel = busyIndicator.querySelector('.busy-label');
  if (busyLabel) {
    busyLabel.textContent = text;
  }

  const bar = busyIndicator.querySelector('.busy-bar');
  if (bar) {
    bar.classList.add('indeterminate');
    bar.style.width = '';
  }

  const stageUpload = document.getElementById("stageUpload");
  const stageDetect = document.getElementById("stageDetect");

  if (stageUpload && stageDetect) {
    const uploadStatus = stageUpload.querySelector(".stage-status");
    const detectStatus = stageDetect.querySelector(".stage-status");

    if (text.includes("geladen") || text.includes("Laden")) {
      // Stage 1: Uploading
      stageUpload.style.opacity = "1";
      if (uploadStatus) {
        uploadStatus.textContent = "Läuft...";
        uploadStatus.style.color = "#176f9a";
      // determinate bar
      setUploadProgress(0);
      }
      stageDetect.style.opacity = "0.5";
      if (detectStatus) {
        detectStatus.textContent = "Wartend";
        detectStatus.style.color = "#708090";
      }
    } else if (text.includes("Erkennung") || text.includes("läuft") || text.includes("verarbeitet")) {
      // Stage 1: Completed, Stage 2: Detecting
      stageUpload.style.opacity = "0.7";
      if (uploadStatus) {
        uploadStatus.textContent = "Fertig";
        uploadStatus.style.color = "#0ea55f";
      }
      stageDetect.style.opacity = "1";
      if (detectStatus) {
        detectStatus.textContent = "Läuft...";
        detectStatus.style.color = "#176f9a";
      // initialize detection stage at 20%
      setUploadProgress(20);
      }
    } else {
      // Fallback/Generic
      stageUpload.style.opacity = "1";
      if (uploadStatus) {
        uploadStatus.textContent = text;
        uploadStatus.style.color = "#176f9a";
      }
      stageDetect.style.opacity = "0.5";
      if (detectStatus) {
        detectStatus.textContent = "Wartend";
        detectStatus.style.color = "#708090";
      }
    }
  }

  busyIndicator.style.display = "block";
}

// setUploadProgress is defined above

function setBatchLogStart(count) {
  batchLog.innerHTML = "";
  writeBatchLog("Batch gestartet: " + count + " Datei(en)", "");
}

function writeBatchLog(text, type) {
  const item = document.createElement("div");
  item.className = "batch-item" + (type ? " " + type : "");
  item.textContent = text;
  batchLog.appendChild(item);
  batchLog.scrollTop = batchLog.scrollHeight;
}

async function ladeBlobHerunter(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  await new Promise((resolve) => setTimeout(resolve, 180));
  URL.revokeObjectURL(url);
}

async function printCanvasDirect(cal, imageCanvas) {
  const pdfBlob = await generateA4Pdf(cal, imageCanvas);
  const pdfUrl = URL.createObjectURL(pdfBlob);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = pdfUrl;
  document.body.appendChild(frame);

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(pdfUrl);
        resolve();
      }, 1800);
    };

    frame.onload = () => {
      setTimeout(() => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          setStatus("Druckdialog geöffnet. Bitte auf 100% / Tatsächliche Größe achten.");
        } catch {
          setStatus("Druckdialog konnte nicht direkt geöffnet werden. Bitte PDF herunterladen und drucken.");
        } finally {
          finish();
        }
      }, 350);
    };

    frame.onerror = () => {
      try {
        setStatus("Druckdialog konnte nicht direkt geöffnet werden. Bitte PDF herunterladen und drucken.");
      } finally {
        finish();
      }
    };
  });
}

function setStatus(text, isError = false) {
  statusBox.textContent = "Status: " + text;
  statusBox.classList.toggle("error", Boolean(isError));
}

function waitForOpenCv() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = window.cv && typeof cv.Mat === "function";
      if (ready) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 45000) {
        clearInterval(timer);
        reject(new Error("Timeout loading OpenCV.js"));
      }
    }, 120);
  });
}

function canvasCoordinateFromClick(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function pointToLineDistance(p, a, b) {
  const l2 = Math.max(1e-6, distance(a, b) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
  const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  return distance(p, proj);
}

function determineHoverMode(p) {
  if (!appState.calibration) {
    return "none";
  }
  const { p0, p12 } = appState.calibration;
  const r = 18;
  if (distance(p, p0) <= r) {
    return "p0";
  }
  if (distance(p, p12) <= r) {
    return "p12";
  }
  if (pointToLineDistance(p, p0, p12) <= 14) {
    return "line";
  }
  return "none";
}

function applyDragMove(p) {
  if (!appState.drag.active || !appState.calibration || !p || !appState.drag.last) return;

  if (appState.drag.mode === "p0") {
    // Endpoint drag is absolute so the endpoint stays exactly under the crosshair.
    appState.calibration.p0.x = p.x;
    appState.calibration.p0.y = p.y;
  } else if (appState.drag.mode === "p12") {
    // Endpoint drag is absolute so the endpoint stays exactly under the crosshair.
    appState.calibration.p12.x = p.x;
    appState.calibration.p12.y = p.y;
  } else if (appState.drag.mode === "line") {
    const dx = p.x - appState.drag.last.x;
    const dy = p.y - appState.drag.last.y;
    appState.calibration.p0.x += dx;
    appState.calibration.p0.y += dy;
    appState.calibration.p12.x += dx;
    appState.calibration.p12.y += dy;
  }

  appState.drag.last = p;
  appState.drag.cursor = p;
  updateCalibrationFromLine("Feinjustiert (Drag)", true, true);
}

function drawEndpointMarker(ctx, endpoint, other, color, labelText = "", labelOffsetScale = 1) {
  const dx = other.x - endpoint.x;
  const dy = other.y - endpoint.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const maxDim = Math.max(previewCanvas.width, previewCanvas.height);
  const half = Math.max(10, Math.round(maxDim / 120));
  const thick = Math.max(1.5, Math.round(maxDim / 600));
  const crosshairRadius = Math.max(4, Math.round(maxDim / 300));

  ctx.save();
  ctx.fillStyle = color;

  ctx.beginPath();
  ctx.moveTo(endpoint.x + px * half, endpoint.y + py * half);
  ctx.lineTo(endpoint.x + ux * thick, endpoint.y + uy * thick);
  ctx.lineTo(endpoint.x - px * half, endpoint.y - py * half);
  ctx.lineTo(endpoint.x - ux * thick, endpoint.y - uy * thick);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(endpoint.x - ux * half, endpoint.y - uy * half);
  ctx.lineTo(endpoint.x + px * thick, endpoint.y + py * thick);
  ctx.lineTo(endpoint.x - px * thick, endpoint.y - py * thick);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(maxDim / 1000));
  ctx.beginPath();
  ctx.arc(endpoint.x, endpoint.y, crosshairRadius, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();

  if (labelText) {
    const fontSize = Math.max(11, Math.round(maxDim / 72));
    const baseLabelOffset = Math.max(22, Math.round(maxDim / 30));
    const labelOffset = baseLabelOffset * Math.max(0.25, labelOffsetScale);
    ctx.font = `600 ${fontSize}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = Math.max(1.5, Math.round(fontSize / 6));
    ctx.globalAlpha = 0.7;
    ctx.strokeText(labelText, endpoint.x + px * labelOffset, endpoint.y + py * labelOffset);
    ctx.fillStyle = color;
    ctx.fillText(labelText, endpoint.x + px * labelOffset, endpoint.y + py * labelOffset);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function zeichnePunkt(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fill();
}

function filenameWithoutExtension(name) {
  return (name || "schablone").replace(/\.[^/.]+$/, "");
}

function updateCalibrationFromLine(methodName, lineReliable, forceLineScale) {
  if (!appState.calibration || !appState.processedCanvas) return;

  const p0 = appState.calibration.p0;
  const p12 = appState.calibration.p12;
  const pixelDist = distance(p0, p12);
  if (!Number.isFinite(pixelDist) || pixelDist < 10) {
    setStatus("Kalibrierlinie zu kurz. Bitte korrigieren.", true);
    return;
  }

  const rulerLengthCm = getRulerLengthCm();
  const rulerLengthMm = getRulerLengthMm();

  let pointsPerPixel;
  if (forceLineScale || !appState.sourceMeta || !appState.sourceMeta.isPdf) {
    pointsPerPixel = mmToPt(rulerLengthMm) / pixelDist;
  } else {
    pointsPerPixel = appState.sourceMeta.pageBreitePt / appState.processedCanvas.width;
  }

  const pxPerMm = 1 / (pointsPerPixel / (72 / 25.4));
  const imageBreiteMm = appState.processedCanvas.width / pxPerMm;
  const imageHöheMm = appState.processedCanvas.height / pxPerMm;

  appState.calibration = {
    ...appState.calibration,
    method: methodName,
    lineReliable,
    forceLineScale,
    pixelDist,
    pxPerMm,
    pointsPerPixel,
    imageBreiteMm,
    imageHöheMm,
    detectedLengthMm: rulerLengthMm,
    isFlipped: appState.calibration.isFlipped || false,
  };

  drawCurrentPreview();
  updateMetrics();
}

async function updateOcrDiagnosticsFromCalibration() {
  if (!appState.calibration || !appState.processedCanvas) {
    return;
  }

  if (appState.outputOcrNormalWords && appState.outputOcrNormalWords.length > 0) {
    appState.ocrBusy = false;
    updateMetrics();
    return;
  }

  const requestId = ++appState.ocrRequestId;
  appState.ocrBusy = true;
  updateMetrics();

  try {
    const normalized = await normalizeImageOrientation(appState.calibration, appState.processedCanvas);
    if (requestId !== appState.ocrRequestId) {
      return;
    }
    appState.outputOcrNormalWords = normalized.ocrWordsNormal || [];
    appState.outputOcrMirroredWords = normalized.ocrWordsMirrored || [];
    appState.outputMirrored = Boolean(normalized.mirrored);

    const detectedLengthMm = appState.calibration.detectedLengthMm || getRulerLengthMm();
    const detectedLengthCm = detectedLengthMm / 10;

    const ocrWords = [...appState.outputOcrNormalWords, ...appState.outputOcrMirroredWords];
    const ocrNumbers = [];
    for (const w of ocrWords) {
      const matches = w.match(/\b\d+\b/g);
      if (matches) {
        ocrNumbers.push(...matches.map(Number));
      }
    }
    const validOcrCms = ocrNumbers.filter(n => n === 10 || n === 12);

    let finalCm = detectedLengthCm;
    let methodRefined = false;
    const closeOcr = validOcrCms.find(n => Math.abs(n - detectedLengthCm) <= 1.5);
    if (closeOcr !== undefined) {
      finalCm = closeOcr;
      methodRefined = true;
    } else {
      const distTo10 = Math.abs(detectedLengthCm - 10);
      const distTo12 = Math.abs(detectedLengthCm - 12);
      finalCm = distTo10 < distTo12 ? 10 : 12;
    }

    if (finalCm !== 10 && finalCm !== 12) {
      finalCm = 12;
    }

    const currentInputVal = getRulerLengthCm();
    if (!appState.userOverrodeLength && currentInputVal !== finalCm) {
      if (finalCm === 10) {
        rulerLengthInput.value = "10";
      } else if (finalCm === 12) {
        rulerLengthInput.value = "12";
      } else {
        rulerLengthInput.value = "custom";
        rulerLengthCustomInput.value = finalCm.toString();
      }
      updateRulerLengthUi();
      updateCalibrationFromLine(
        appState.calibration.method + (methodRefined ? " + OCR-Korrektur" : " (automatisch erkannt)"),
        appState.calibration.lineReliable,
        appState.calibration.forceLineScale
      );
    }
  } catch {

      // Keep the lens center exactly at the cursor for precise alignment near edges.
      const magX = dragPoint.x;
      const magY = dragPoint.y;
    appState.outputMirrored = null;
  } finally {
    if (requestId !== appState.ocrRequestId) {
      return;
    }
    appState.ocrBusy = false;
    updateMetrics();
  }
}

// Global initialization
(function initPreview() {
  previewCtx.fillStyle = "#f4f8f5";
  previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  updateRulerLengthUi();
})();
