// 背景除去 Worker: IS-Net を ONNX Runtime Web でメインスレッド外で動かす。
// WebGPU が使えればそれを、なければ WebAssembly（CPU）を使う。

import { MODEL_SIZE, toModelInput, toMask } from "./image-core.js";

const MODEL_URL = new URL("./models/isnet-general-use.int8.onnx", import.meta.url).href;
const MODEL_BYTES = 46719797; // Content-Length が取れない場合の進捗表示用
const CACHE_PREFIX = "image-tools-model-";
const CACHE_NAME = `${CACHE_PREFIX}isnet-int8-v1`;
const ORT_DIR = new URL("./vendor/onnxruntime-web/", import.meta.url).href;

let enginePromise = null;

self.onmessage = async ({ data }) => {
  if (data.type !== "run") return;
  try {
    enginePromise ??= createEngine();
    const { ort, session, backend, threads } = await enginePromise;
    postMessage({ type: "progress", phase: "run" });

    const started = performance.now();
    const input = toModelInput(new Uint8ClampedArray(data.pixels), MODEL_SIZE);
    const tensor = new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const mask = toMask(outputs[session.outputNames[0]].data);
    const ms = performance.now() - started;

    postMessage({ type: "result", id: data.id, mask, backend, threads, ms }, [mask.buffer]);
  } catch (err) {
    enginePromise = null; // 次回は作り直す
    postMessage({ type: "error", id: data.id, message: String(err?.message || err) });
  }
};

async function createEngine() {
  const model = await loadModel();
  postMessage({ type: "progress", phase: "init" });
  // マルチスレッドの WASM は SharedArrayBuffer が必要（= cross-origin isolated のときだけ）
  const threads = self.crossOriginIsolated ? Math.min(self.navigator.hardwareConcurrency || 4, 8) : 1;

  if (await hasWebGPU()) {
    try {
      const ort = await importOrt("ort.webgpu.min.mjs", threads);
      const session = await ort.InferenceSession.create(model, { executionProviders: ["webgpu"] });
      return { ort, session, backend: "webgpu", threads };
    } catch (err) {
      console.warn("WebGPU を使えないため CPU で処理します", err);
    }
  }
  const ort = await importOrt("ort.wasm.min.mjs", threads);
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  return { ort, session, backend: "wasm", threads };
}

async function importOrt(file, threads) {
  const ort = await import(ORT_DIR + file);
  ort.env.wasm.wasmPaths = ORT_DIR;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = "error";
  return ort;
}

async function hasWebGPU() {
  try {
    return Boolean(self.navigator.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/** モデルを取得する。2 回目以降は Cache Storage から読む */
async function loadModel() {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(MODEL_URL);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null; // Cache Storage が使えない環境（プライベートモードなど）
  }

  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`モデルを取得できませんでした（HTTP ${res.status}）`);
  const length = Number(res.headers.get("Content-Length"));
  const total = !res.headers.get("Content-Encoding") && length > 0 ? length : MODEL_BYTES;

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    postMessage({ type: "progress", phase: "download", loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  if (cache) {
    try {
      await cache.put(MODEL_URL, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
      }
    } catch {
      // 容量不足などでキャッシュできなくても処理は続ける
    }
  }
  return bytes;
}
