# 画像ツール

画像の **背景の透過**（AI で被写体を切り抜いて透過 PNG に）、**色の反転**、**形式の変換** をブラウザの中だけで行うツールです。画像はサーバーへ送信されません。

- **Web:** https://y-kondo-26.github.io/image-tools/

## 機能

- **背景の透過** — AI（IS-Net）が被写体を見つけて背景を透明にします。オン／オフで元に戻せます
- **色の反転** — RGB を反転します（透明度はそのまま）
- **形式の変換** — PNG / JPEG / WebP / AVIF / BMP / ICO で書き出します
  - JPEG・BMP は透過を持てないため、透明な部分を指定した色で塗りつぶします
  - ICO は 16〜256px の複数サイズを 1 ファイルにまとめます（正方形になるよう余白を追加）
  - AVIF・WebP は、ブラウザが書き出しに対応している場合だけ選べます
- **読み込み** — ファイル選択、ドラッグ＆ドロップ、貼り付け（Ctrl+V / ⌘V）。PNG・JPEG・WebP・GIF・BMP・AVIF・SVG・ICO など、ブラウザが表示できる形式（HEIC は Safari のみ）
- 書き出し後のファイルサイズの表示、クリップボードへのコピー（PNG）、形式・品質などの設定の記憶（localStorage）

## 使い方

1. 上記の Web URL を開く
2. 画像をドロップする（クリックして選択、貼り付けでも可）
3. 必要に応じて「背景を透過」「色を反転」をオンにする
4. 形式を選んで **ダウンロード**

背景の透過は、初回だけ AI モデル（約 45 MB）をダウンロードします。2 回目以降はブラウザに保存したものを使います。
WebGPU が使えるブラウザでは GPU で、使えない場合は CPU で処理します。CPU（4 スレッド）の検証環境では 1 枚あたり約 5 秒でした。

## しくみ

外部の API や CDN は使わず、必要なファイルはすべてこのリポジトリから配信しています。

| 処理                     | 実装                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 背景の透過               | [IS-Net](https://github.com/xuebinqin/DIS) を [ONNX Runtime Web](https://onnxruntime.ai/) で実行（Web Worker 内）。WebGPU が使えれば GPU、なければ WebAssembly（CPU） |
| 色の反転・透過の適用     | Canvas の画素を直接処理                                                                                                                                               |
| PNG / JPEG / WebP / AVIF | `canvas.toBlob()`                                                                                                                                                     |
| BMP / ICO                | 自前のエンコーダー（`docs/image-core.js`）                                                                                                                            |

- モデルは Conv の重みを int8 に量子化して 178 MB → 約 45 MB にしています。読み込み時に fp32 へ戻すので、推論の精度は元のモデルとほぼ同じです（`scripts/quantize_model.py`）
- GitHub Pages ではレスポンスヘッダーを設定できないため、Service Worker（`docs/sw.js`）で COOP/COEP ヘッダーを付けて、WebAssembly をマルチスレッドで動かしています。そのため初回訪問時だけページが 1 回リロードされます

## リポジトリ構成

`docs/` 以下が GitHub Pages で公開されるサイト本体です。

| パス                                | 内容                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `docs/index.html`, `docs/style.css` | 画面                                                    |
| `docs/app.js`                       | 画面の処理（読み込み・プレビュー・書き出し）            |
| `docs/image-core.js`                | 画像処理の中核（DOM 非依存。ユニットテストの対象）      |
| `docs/bg-worker.js`                 | 背景の透過を行う Web Worker                             |
| `docs/coi.js`, `docs/sw.js`         | マルチスレッド化のための Service Worker とその登録      |
| `docs/models/`                      | IS-Net（int8 量子化済み）                               |
| `docs/vendor/onnxruntime-web/`      | ONNX Runtime Web                                        |
| `scripts/`                          | モデルの量子化、ONNX Runtime Web の取り込み、E2E テスト |
| `test/`                             | ユニットテスト                                          |

## GitHub Pages の設定

リポジトリの **Settings → Pages → Build and deployment** で次のように設定します。

- **Source:** Deploy from a branch
- **Branch:** `main` / `/docs`

## 開発

```sh
npm test                           # ユニットテスト（GitHub Actions でも実行）
python3 -m http.server -d docs 8000   # http://localhost:8000/ で確認
```

ブラウザでの動作確認（E2E）:

```sh
npm i --no-save playwright && npx playwright install chromium
npm run e2e                  # 合成画像で一通り操作する
npm run e2e -- photo.jpg     # 任意の画像で試す
```

### ONNX Runtime Web の更新

```sh
scripts/vendor-ort.sh 1.30.0   # 使うファイルとライセンス文を docs/vendor/ にコピー
```

### モデルの作り直し

```sh
pip install onnx numpy
curl -L -o isnet-general-use.onnx https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
python scripts/quantize_model.py isnet-general-use.onnx docs/models/isnet-general-use.int8.onnx
```

モデルを差し替えたら、`docs/bg-worker.js` の `MODEL_BYTES` と `CACHE_NAME` も更新してください（`npm test` がサイズの不一致を検出します）。

## ライセンス

このリポジトリのコードは [MIT](./LICENSE) です。同梱しているサードパーティのファイル（ONNX Runtime Web: MIT、IS-Net: Apache-2.0）は [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。
