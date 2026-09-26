import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
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
  toMask,
  toModelInput,
} from "../docs/image-core.js";

const px = (...values) => new Uint8ClampedArray(values);

test("invertColors は RGB だけを反転し、2 回で元に戻る", () => {
  const data = px(0, 128, 255, 77, 10, 20, 30, 255);
  invertColors(data);
  assert.deepEqual([...data], [255, 127, 0, 77, 245, 235, 225, 255]);
  invertColors(data);
  assert.deepEqual([...data], [0, 128, 255, 77, 10, 20, 30, 255]);
});

test("applyMask は既存のアルファにマスクを掛ける", () => {
  const data = px(1, 2, 3, 255, 1, 2, 3, 255, 1, 2, 3, 255, 1, 2, 3, 100);
  applyMask(data, px(255, 0, 128, 255));
  assert.deepEqual([data[3], data[7], data[11], data[15]], [255, 0, 128, 100]);
  assert.deepEqual([...data.slice(0, 3)], [1, 2, 3], "RGB は変えない");
  assert.throws(() => applyMask(px(0, 0, 0, 0), px(1, 2)), /mask size mismatch/);
});

test("toModelInput は NCHW・x/255−0.5 に並べ替える", () => {
  const rgba = px(255, 0, 51, 9, 0, 255, 102, 9, 0, 0, 153, 9, 255, 255, 204, 9);
  const out = toModelInput(rgba, 2);
  assert.equal(out.length, 12);
  assert.deepEqual([...out.slice(0, 4)], [0.5, -0.5, -0.5, 0.5]); // R
  assert.deepEqual([...out.slice(4, 8)], [-0.5, 0.5, -0.5, 0.5]); // G
  assert.deepEqual(
    [...out.slice(8, 12)].map((v) => Math.round(v * 100) / 100),
    [-0.3, -0.1, 0.1, 0.3],
  ); // B
  assert.throws(() => toModelInput(px(0, 0, 0, 0), 2), /input size mismatch/);
  assert.equal(MODEL_SIZE, 1024);
});

test("toMask は 0–1 を 0–255 にし、範囲外は切り詰める（正規化はしない）", () => {
  const mask = toMask(new Float32Array([0, 1, 0.5, 1.2, -0.1, 0.02]));
  assert.deepEqual([...mask], [0, 255, 128, 255, 0, 5]);
});

test("maskCoverage は 128 以上の画素の割合", () => {
  assert.equal(maskCoverage(px(0, 127, 128, 255)), 0.5);
  assert.equal(maskCoverage(px()), 0);
});

test("encodeBMP は 24bit・ボトムアップ・4 バイト境界の BMP を作る", () => {
  // 3×2: 上段 = 赤・緑・青、下段 = 白・黒・灰
  const rgba = px(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255);
  const bmp = encodeBMP(rgba, 3, 2);
  const dv = new DataView(bmp.buffer);
  const rowSize = 12; // 3 画素 × 3 バイト = 9 → 12 にパディング
  assert.equal(String.fromCharCode(bmp[0], bmp[1]), "BM");
  assert.equal(dv.getUint32(2, true), 54 + rowSize * 2);
  assert.equal(bmp.length, 54 + rowSize * 2);
  assert.equal(dv.getUint32(10, true), 54);
  assert.equal(dv.getInt32(18, true), 3);
  assert.equal(dv.getInt32(22, true), 2);
  assert.equal(dv.getUint16(28, true), 24);
  // ファイル上の 1 行目は画像の下段（BGR 順）
  assert.deepEqual([...bmp.slice(54, 63)], [255, 255, 255, 0, 0, 0, 128, 128, 128]);
  assert.deepEqual([...bmp.slice(54 + rowSize, 54 + rowSize + 9)], [0, 0, 255, 0, 255, 0, 255, 0, 0]);
});

test("encodeICO は PNG エントリをまとめ、256px は 0 と記録する", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5]);
  const ico = encodeICO([
    { size: 16, png: a },
    { size: 256, png: b },
  ]);
  const dv = new DataView(ico.buffer);
  assert.equal(dv.getUint16(0, true), 0);
  assert.equal(dv.getUint16(2, true), 1);
  assert.equal(dv.getUint16(4, true), 2);
  const header = 6 + 16 * 2;
  // 1 つ目
  assert.equal(ico[6], 16);
  assert.equal(ico[7], 16);
  assert.equal(dv.getUint16(10, true), 1);
  assert.equal(dv.getUint16(12, true), 32);
  assert.equal(dv.getUint32(14, true), 3);
  assert.equal(dv.getUint32(18, true), header);
  // 2 つ目（256px）
  assert.equal(ico[22], 0);
  assert.equal(ico[23], 0);
  assert.equal(dv.getUint32(30, true), 2);
  assert.equal(dv.getUint32(34, true), header + 3);
  assert.deepEqual([...ico.slice(header)], [1, 2, 3, 4, 5]);
});

test("icoSizes は長辺を超えないサイズを返す（最低 16px）", () => {
  assert.deepEqual(icoSizes(300, 200), [16, 24, 32, 48, 64, 128, 256]);
  assert.deepEqual(icoSizes(40, 20), [16, 24, 32]);
  assert.deepEqual(icoSizes(8, 8), [16]);
});

test("outputName は拡張子を差し替える", () => {
  assert.equal(outputName("photo.jpeg", "png"), "photo.png");
  assert.equal(outputName("archive.tar.gz", "png"), "archive.tar.png");
  assert.equal(outputName("noext", "webp"), "noext.webp");
  assert.equal(outputName("写真 1.HEIC", "jpg"), "写真 1.jpg");
  assert.equal(outputName("", "ico"), "image.ico");
  assert.equal(outputName(".png", "bmp"), "image.bmp");
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(46719797), "44.6 MB");
});

test("FORMATS の定義", () => {
  for (const [id, f] of Object.entries(FORMATS)) {
    assert.match(f.mime, /^image\//, id);
    assert.match(f.ext, /^[a-z]+$/, id);
  }
  assert.equal(FORMATS.jpeg.alpha, false);
  assert.equal(FORMATS.png.alpha, true);
});

test("Worker が参照するモデルと ONNX Runtime のファイルが揃っている", () => {
  const worker = readFileSync(new URL("../docs/bg-worker.js", import.meta.url), "utf8");
  const model = /new URL\("\.\/(models\/[^"]+)"/.exec(worker)[1];
  const bytes = Number(/const MODEL_BYTES = (\d+)/.exec(worker)[1]);
  assert.equal(
    statSync(new URL(`../docs/${model}`, import.meta.url)).size,
    bytes,
    "MODEL_BYTES がモデルのサイズと一致しない",
  );
  for (const file of [
    "ort.webgpu.min.mjs",
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort.wasm.min.mjs",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
  ]) {
    assert.ok(existsSync(new URL(`../docs/vendor/onnxruntime-web/${file}`, import.meta.url)), file);
  }
});
