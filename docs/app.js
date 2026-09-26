import {
  FORMATS,
  MODEL_SIZE,
  applyMask,
  encodeBMP,
  encodeICO,
  formatBytes,
  icoSizes,
  invertColors,
  maskCoverage,
  outputName,
} from "./image-core.js";

const $ = (selector) => document.querySelector(selector);

const els = {
  dropzone: $("#dropzone"),
  fileInput: $("#file-input"),
  workspace: $("#workspace"),
  resultCanvas: $("#result-canvas"),
  sourceCanvas: $("#source-canvas"),
  viewButtons: document.querySelectorAll("[data-view]"),
  info: $("#image-info"),
  removeBg: $("#opt-remove-bg"),
  invert: $("#opt-invert"),
  bgStatus: $("#bg-status"),
  bgProgress: $("#bg-progress"),
  bgText: $("#bg-status-text"),
  bgInfo: $("#bg-info"),
  formatInputs: document.querySelectorAll('input[name="format"]'),
  formatNote: $("#format-note"),
  qualityField: $("#quality-field"),
  quality: $("#quality"),
  qualityValue: $("#quality-value"),
  bgField: $("#bg-field"),
  bgColor: $("#bg-color"),
  fileName: $("#file-name"),
  download: $("#download-btn"),
  exportSize: $("#export-size"),
  exportSizeWrap: $("#export-size-wrap"),
  copy: $("#copy-btn"),
  change: $("#change-image"),
  toast: $("#toast"),
};

const state = {
  name: "",
  type: "",
  size: 0,
  width: 0,
  height: 0,
  original: null, // ImageData（元画像）
  mask: null, // Uint8ClampedArray（元画像と同じ解像度の不透明度）
  busy: false,
  version: 0, // 結果画像が変わるたびに増える
};

const SETTINGS_KEY = "image-tools-settings";
const MAX_PIXELS = 50_000_000;

// ---------- 画像の読み込み ----------

async function openFile(file) {
  if (!file) return;
  if (state.busy) {
    toast("処理中です。終わってからもう一度お試しください。");
    return;
  }
  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch {
    const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
    toast(
      heic
        ? "HEIC/HEIF はこのブラウザでは読み込めません（Safari なら読み込めます）。"
        : "この画像は読み込めませんでした。形式を確認してください。",
    );
    return;
  }
  const { source, width, height, release } = decoded;
  try {
    if (width * height > MAX_PIXELS) {
      toast(`画像が大きすぎます（${width} × ${height}）。5,000 万画素までの画像を使ってください。`);
      return;
    }
    const canvas = els.sourceCanvas;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    Object.assign(state, {
      name: file.name || "image",
      type: file.type,
      size: file.size,
      width,
      height,
      original: ctx.getImageData(0, 0, width, height),
      mask: null,
    });
  } finally {
    release();
  }

  els.removeBg.checked = false;
  els.invert.checked = false;
  els.bgInfo.textContent = "";
  els.fileName.value = outputName(state.name, currentFormat().ext);
  els.info.textContent = `${width} × ${height} px · ${typeLabel(file)} · ${formatBytes(file.size)}`;
  renderFormatOptions();
  els.dropzone.hidden = true;
  els.workspace.hidden = false;
  setView("result");
  render();
}

async function decodeImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    // SVG など createImageBitmap が扱えない形式は <img> で読む
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth || 1024;
    const height = img.naturalHeight || 1024;
    return { source: img, width, height, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function typeLabel(file) {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name || "")?.[1] || "";
  const fromType = (file.type.split("/")[1] || "").replace(/^x-|\+xml$/g, "");
  return (fromName || fromType || "画像").toUpperCase();
}

// ---------- 描画 ----------

function render() {
  if (!state.original) return;
  const { width, height } = state;
  const image = new ImageData(new Uint8ClampedArray(state.original.data), width, height);
  if (els.removeBg.checked && state.mask) applyMask(image.data, state.mask);
  if (els.invert.checked) invertColors(image.data);
  const canvas = els.resultCanvas;
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(image, 0, 0);
  state.version++;
  scheduleEstimate();
}

function setView(view) {
  els.resultCanvas.hidden = view !== "result";
  els.sourceCanvas.hidden = view !== "source";
  els.viewButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
}

/** 大きく縮小するときは半分ずつ縮めて、ブラウザによる画質差（ジャギー）を抑える */
function resize(source, width, height) {
  let current = source;
  let w = source.width;
  let h = source.height;
  while (w / 2 >= width && h / 2 >= height) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    current = drawTo(current, w, h);
  }
  return drawTo(current, width, height);
}

function drawTo(source, width, height) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// ---------- 背景の透過 ----------

let worker = null;
let jobId = 0;
const jobs = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./bg-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      showProgress(data);
      return;
    }
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.type === "result") job.resolve(data);
    else job.reject(new Error(data.message));
  };
  worker.onerror = (event) => {
    for (const job of jobs.values()) job.reject(new Error(event.message || "Worker を起動できませんでした"));
    jobs.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function runModel(pixels) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject });
    getWorker().postMessage({ type: "run", id, pixels }, [pixels.buffer]);
  });
}

async function removeBackground() {
  setBusy(true);
  const original = state.original;
  try {
    // モデル入力: 1024×1024 に縮小し、透明部分は白で埋める
    const input = makeCanvas(MODEL_SIZE, MODEL_SIZE);
    const ctx = input.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
    ctx.drawImage(resize(els.sourceCanvas, MODEL_SIZE, MODEL_SIZE), 0, 0);
    const result = await runModel(ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data);
    if (state.original !== original) return;

    state.mask = upscaleMask(result.mask);
    const engine = result.backend === "webgpu" ? "GPU（WebGPU）" : `CPU（${result.threads} スレッド）`;
    els.bgInfo.textContent = `${engine}で処理 · ${(result.ms / 1000).toFixed(1)} 秒`;
    if (maskCoverage(result.mask) < 0.005) {
      toast("被写体を見つけられませんでした。人物・動物・物など、はっきりした被写体のある画像で試してください。");
    }
    render();
  } catch (err) {
    els.removeBg.checked = false;
    console.error(err);
    toast(`背景を透過できませんでした: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

/** 1024×1024 のマスクを元画像の解像度に拡大する */
function upscaleMask(mask) {
  const small = makeCanvas(MODEL_SIZE, MODEL_SIZE);
  const sctx = small.getContext("2d");
  const image = sctx.createImageData(MODEL_SIZE, MODEL_SIZE);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    image.data[i] = image.data[i + 1] = image.data[i + 2] = mask[p];
    image.data[i + 3] = 255;
  }
  sctx.putImageData(image, 0, 0);
  const { width, height } = state;
  const data = resize(small, width, height)
    .getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const out = new Uint8ClampedArray(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = data[i];
  return out;
}

let progressTimer = 0;

function setBusy(busy) {
  state.busy = busy;
  els.removeBg.disabled = busy;
  els.change.disabled = busy;
  els.bgStatus.hidden = !busy;
  clearInterval(progressTimer);
  if (busy) {
    showProgress({ phase: "start" });
  }
}

function showProgress({ phase, loaded, total }) {
  clearInterval(progressTimer);
  const bar = els.bgProgress.firstElementChild;
  if (phase === "download") {
    els.bgProgress.classList.remove("indeterminate");
    bar.style.width = `${total ? Math.min(loaded / total, 1) * 100 : 0}%`;
    els.bgText.textContent = `AI モデルをダウンロード中… ${formatBytes(loaded)} / ${formatBytes(total)}（初回のみ）`;
    return;
  }
  els.bgProgress.classList.add("indeterminate");
  bar.style.width = "";
  const label = { start: "準備中…", init: "AI エンジンを準備中…", run: "背景を解析中…" }[phase] || "処理中…";
  els.bgText.textContent = label;
  if (phase === "run") {
    const started = Date.now();
    progressTimer = setInterval(() => {
      els.bgText.textContent = `${label} ${Math.round((Date.now() - started) / 1000)} 秒`;
    }, 1000);
  }
}

// ---------- 書き出し ----------

function currentFormatId() {
  return document.querySelector('input[name="format"]:checked')?.value || "png";
}

function currentFormat() {
  return FORMATS[currentFormatId()];
}

function exportKey() {
  return [state.version, currentFormatId(), els.quality.value, els.bgColor.value].join("|");
}

async function encode() {
  const id = currentFormatId();
  const format = FORMATS[id];
  const source = els.resultCanvas;
  const quality = format.quality ? Number(els.quality.value) / 100 : undefined;
  if (id === "ico") return encodeIco(source);
  if (format.alpha) return canvasToBlob(source, format.mime, quality, format.label);

  // 透過を持てない形式: 透明部分を指定色で塗りつぶす
  const canvas = makeCanvas(source.width, source.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = els.bgColor.value;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  if (id === "bmp") {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return new Blob([encodeBMP(data, canvas.width, canvas.height)], { type: format.mime });
  }
  return canvasToBlob(canvas, format.mime, quality, format.label);
}

async function encodeIco(source) {
  const entries = [];
  for (const size of icoSizes(source.width, source.height)) {
    const scale = Math.min(size / source.width, size / source.height);
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const square = makeCanvas(size, size);
    square.getContext("2d").drawImage(resize(source, w, h), Math.floor((size - w) / 2), Math.floor((size - h) / 2));
    const png = await canvasToBlob(square, "image/png");
    entries.push({ size, png: new Uint8Array(await png.arrayBuffer()) });
  }
  return new Blob([encodeICO(entries)], { type: FORMATS.ico.mime });
}

function canvasToBlob(canvas, mime, quality, label = mime) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob && blob.type === mime) resolve(blob);
        else reject(new Error(`このブラウザは ${label} の書き出しに対応していません`));
      },
      mime,
      quality,
    );
  });
}

// 書き出しサイズを先に計算しておき、ダウンロード時はそれをそのまま使う
let estimate = { key: "", promise: null };
let estimateTimer = 0;

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  els.exportSize.textContent = "";
  els.exportSizeWrap.hidden = true;
  if (!state.original) return;
  estimateTimer = setTimeout(() => {
    getExport()
      .then(({ key, blob }) => {
        if (key !== exportKey()) return;
        els.exportSize.textContent = formatBytes(blob.size);
        els.exportSizeWrap.hidden = false;
      })
      .catch(() => {});
  }, 250);
}

function getExport() {
  const key = exportKey();
  if (estimate.key !== key) {
    estimate = { key, promise: encode().then((blob) => ({ key, blob })) };
    estimate.promise.catch(() => {
      if (estimate.key === key) estimate = { key: "", promise: null };
    });
  }
  return estimate.promise;
}

async function downloadResult() {
  els.download.disabled = true;
  try {
    const { blob } = await getExport();
    const name = outputName(els.fileName.value || state.name, currentFormat().ext);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    toast(err.message);
  } finally {
    els.download.disabled = false;
  }
}

async function copyResult() {
  try {
    const blob = canvasToBlob(els.resultCanvas, "image/png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("PNG としてクリップボードにコピーしました。");
  } catch {
    toast("このブラウザではクリップボードにコピーできませんでした。");
  }
}

function updateFormatUI() {
  renderFormatOptions();
  if (els.fileName.value) els.fileName.value = outputName(els.fileName.value, currentFormat().ext);
  saveSettings();
  scheduleEstimate();
}

/** 形式に応じた設定項目と説明を表示する（ICO の説明は画像サイズで変わる） */
function renderFormatOptions() {
  const id = currentFormatId();
  const format = FORMATS[id];
  els.qualityField.hidden = !format.quality;
  els.bgField.hidden = format.alpha;
  const notes = {
    png: "透過を保ったまま、画質を落とさずに保存します。",
    jpeg: "透過は保存できません。透明な部分は下の色で塗りつぶします。",
    webp: "透過を保てます。品質を下げるほどファイルが小さくなります。",
    avif: "透過を保てます。高い圧縮率が特長です。",
    bmp: "透過は保存できません。透明な部分は下の色で塗りつぶします。",
    ico: `${icoSizes(state.width || 256, state.height || 256).join("・")} px のアイコンを 1 つのファイルにまとめます（正方形になるよう余白を追加）。`,
  };
  els.formatNote.textContent = notes[id];
}

// ---------- 設定の記憶 ----------

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ format: currentFormatId(), quality: els.quality.value, bgColor: els.bgColor.value }),
    );
  } catch {
    // 保存できなくても動作には影響しない
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const input = [...els.formatInputs].find((i) => i.value === saved.format && !i.disabled);
    if (input) input.checked = true;
    if (saved.quality) els.quality.value = saved.quality;
    if (saved.bgColor) els.bgColor.value = saved.bgColor;
  } catch {
    // 無視
  }
  els.qualityValue.textContent = els.quality.value;
}

/** canvas で書き出せない形式（Safari の WebP など）は選択肢から外す */
async function detectFormats() {
  const probe = makeCanvas(1, 1);
  await Promise.all(
    [...els.formatInputs].map(async (input) => {
      const format = FORMATS[input.value];
      if (!format.canvas) return;
      const supported = await new Promise((resolve) =>
        probe.toBlob((b) => resolve(b?.type === format.mime), format.mime),
      );
      if (!supported) {
        input.disabled = true;
        input.closest("label").hidden = true;
        if (input.checked) els.formatInputs[0].checked = true;
      }
    }),
  );
}

// ---------- 通知 ----------

let toastTimer = 0;

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 5000);
}

// ---------- イベント ----------

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.change.addEventListener("click", () => els.fileInput.click());

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  openFile([...e.dataTransfer.files].find((f) => f.type.startsWith("image/")) || e.dataTransfer.files[0]);
});
document.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (!file) return;
  e.preventDefault();
  openFile(file);
});

els.viewButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

els.removeBg.addEventListener("change", () => {
  if (els.removeBg.checked && !state.mask) removeBackground();
  else render();
});
els.invert.addEventListener("change", render);

els.formatInputs.forEach((input) => input.addEventListener("change", updateFormatUI));
els.quality.addEventListener("input", () => {
  els.qualityValue.textContent = els.quality.value;
  saveSettings();
  scheduleEstimate();
});
els.bgColor.addEventListener("input", () => {
  saveSettings();
  scheduleEstimate();
});
els.download.addEventListener("click", downloadResult);
if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
  els.copy.addEventListener("click", copyResult);
} else {
  els.copy.hidden = true;
}

await detectFormats();
loadSettings();
updateFormatUI();
