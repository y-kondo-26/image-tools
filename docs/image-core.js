// 画像処理の中核（DOM 非依存）。ページ・Worker・テストの三者から使う。
// すべて RGBA の Uint8ClampedArray（ImageData.data と同じ並び）を扱う。

/** 背景除去モデル（IS-Net）の入力解像度 */
export const MODEL_SIZE = 1024;

/** 書き出し形式。canvas: true はブラウザの canvas.toBlob で書き出す */
export const FORMATS = {
  png: { label: "PNG", ext: "png", mime: "image/png", alpha: true, quality: false, canvas: true },
  jpeg: { label: "JPEG", ext: "jpg", mime: "image/jpeg", alpha: false, quality: true, canvas: true },
  webp: { label: "WebP", ext: "webp", mime: "image/webp", alpha: true, quality: true, canvas: true },
  avif: { label: "AVIF", ext: "avif", mime: "image/avif", alpha: true, quality: true, canvas: true },
  bmp: { label: "BMP", ext: "bmp", mime: "image/bmp", alpha: false, quality: false, canvas: false },
  ico: { label: "ICO", ext: "ico", mime: "image/x-icon", alpha: true, quality: false, canvas: false },
};

/** ICO に含めるサイズの候補 */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** RGB を反転する（アルファはそのまま）。in-place */
export function invertColors(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255 - rgba[i];
    rgba[i + 1] = 255 - rgba[i + 1];
    rgba[i + 2] = 255 - rgba[i + 2];
  }
  return rgba;
}

/** アルファにマスク（0–255、1 画素 1 値）を掛ける。in-place */
export function applyMask(rgba, mask) {
  if (mask.length * 4 !== rgba.length) throw new Error("mask size mismatch");
  for (let p = 0, i = 3; p < mask.length; p++, i += 4) {
    rgba[i] = (rgba[i] * mask[p]) / 255;
  }
  return rgba;
}

/**
 * size×size の RGBA を IS-Net の入力テンソル（NCHW, float32, x/255 − 0.5）に変換する。
 * 前処理は DIS 公式実装に合わせている。
 */
export function toModelInput(rgba, size = MODEL_SIZE) {
  const plane = size * size;
  if (rgba.length !== plane * 4) throw new Error("input size mismatch");
  const out = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out[p] = rgba[i] / 255 - 0.5;
    out[p + plane] = rgba[i + 1] / 255 - 0.5;
    out[p + 2 * plane] = rgba[i + 2] / 255 - 0.5;
  }
  return out;
}

/**
 * モデル出力（sigmoid 済み 0–1）を 0–255 のマスクにする。
 * min–max 正規化はしない: 被写体のない画像で微小な値が引き伸ばされ、誤った切り抜きになるため。
 */
export function toMask(values) {
  const mask = new Uint8ClampedArray(values.length);
  for (let i = 0; i < values.length; i++) mask[i] = values[i] * 255;
  return mask;
}

/** マスクのうち前景（128 以上）が占める割合 */
export function maskCoverage(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= 128) n++;
  return mask.length ? n / mask.length : 0;
}

/** 24bit BMP（ボトムアップ、アルファなし）にエンコードする。透明部分は事前に塗りつぶしておくこと */
export function encodeBMP(rgba, width, height) {
  const rowSize = (width * 3 + 3) & ~3;
  const imageSize = rowSize * height;
  const buf = new Uint8Array(54 + imageSize);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42; // "B"
  buf[1] = 0x4d; // "M"
  dv.setUint32(2, buf.length, true);
  dv.setUint32(10, 54, true); // 画素データの位置
  dv.setUint32(14, 40, true); // BITMAPINFOHEADER
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true); // 正 = ボトムアップ
  dv.setUint16(26, 1, true); // プレーン数
  dv.setUint16(28, 24, true); // bpp
  dv.setUint32(34, imageSize, true);
  dv.setInt32(38, 2835, true); // 72 dpi
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    let o = 54 + (height - 1 - y) * rowSize;
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      buf[o++] = rgba[i + 2];
      buf[o++] = rgba[i + 1];
      buf[o++] = rgba[i];
    }
  }
  return buf;
}

/** PNG 圧縮のエントリ（{ size, png: Uint8Array }）を ICO コンテナにまとめる */
export function encodeICO(entries) {
  const headerSize = 6 + 16 * entries.length;
  const total = entries.reduce((n, e) => n + e.png.length, headerSize);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint16(2, 1, true); // 種別: アイコン
  dv.setUint16(4, entries.length, true);
  let offset = headerSize;
  entries.forEach((e, k) => {
    const d = 6 + 16 * k;
    buf[d] = e.size >= 256 ? 0 : e.size; // 幅（0 は 256 の意味）
    buf[d + 1] = e.size >= 256 ? 0 : e.size; // 高さ
    dv.setUint16(d + 4, 1, true); // カラープレーン
    dv.setUint16(d + 6, 32, true); // bpp
    dv.setUint32(d + 8, e.png.length, true);
    dv.setUint32(d + 12, offset, true);
    buf.set(e.png, offset);
    offset += e.png.length;
  });
  return buf;
}

/** 元画像の長辺を超えない ICO サイズの一覧（最低でも 16px は含める） */
export function icoSizes(width, height) {
  const max = Math.max(width, height);
  const sizes = ICO_SIZES.filter((s) => s <= max);
  return sizes.length ? sizes : [ICO_SIZES[0]];
}

/** 元のファイル名の拡張子を差し替える */
export function outputName(fileName, ext) {
  const base = (fileName || "").replace(/\.[^./\\]*$/, "").trim() || "image";
  return `${base}.${ext}`;
}

/** バイト数を読みやすい表記にする */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
