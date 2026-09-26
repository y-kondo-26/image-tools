#!/usr/bin/env bash
# ONNX Runtime Web のうち、このツールが使うファイルだけを docs/vendor にコピーする。
# 使い方: scripts/vendor-ort.sh [バージョン]
set -euo pipefail

VERSION="${1:-1.30.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/docs/vendor/onnxruntime-web"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(cd "$TMP" && npm pack "onnxruntime-web@$VERSION" --silent >/dev/null && tar xzf onnxruntime-web-*.tgz)

rm -rf "$DEST"
mkdir -p "$DEST"
# WebGPU 用（WebGPU EP + CPU）と、WebGPU がない環境向けの軽い CPU 専用ビルド
for f in \
  ort.webgpu.min.mjs ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm \
  ort.wasm.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do
  cp "$TMP/package/dist/$f" "$DEST/"
done
# npm パッケージにはライセンス文が入っていないので、同じバージョンのタグから取得する
for f in LICENSE ThirdPartyNotices.txt; do
  curl -fsSL -o "$DEST/$f" "https://raw.githubusercontent.com/microsoft/onnxruntime/v$VERSION/$f"
done
echo "onnxruntime-web $VERSION -> $DEST"
