# Third-party notices

このリポジトリには、以下のサードパーティのファイルが含まれています。

## ONNX Runtime Web 1.30.0

- ファイル: `docs/vendor/onnxruntime-web/`
- ライセンス: MIT License — Copyright (c) Microsoft Corporation
- 入手元: https://www.npmjs.com/package/onnxruntime-web （ソース: https://github.com/microsoft/onnxruntime ）
- ライセンス文: `docs/vendor/onnxruntime-web/LICENSE`
- 同梱コンポーネントの表示: `docs/vendor/onnxruntime-web/ThirdPartyNotices.txt`

## IS-Net（isnet-general-use）

- ファイル: `docs/models/isnet-general-use.int8.onnx`
- ライセンス: Apache License 2.0
- 作者: Xuebin Qin, Hang Dai, Xiaobin Hu, Deng-Ping Fan, Ling Shao, Luc Van Gool — "Highly Accurate Dichotomous Image Segmentation" (ECCV 2022)
- 入手元: 学習済みモデル https://github.com/xuebinqin/DIS 、ONNX 変換版 https://github.com/danielgatis/rembg （MIT License）のリリース `v0.0.0` の `isnet-general-use.onnx`
- ライセンス文: `docs/models/LICENSE-IS-Net.txt`
- 変更点: 元のモデルから次の変更を加えています（`scripts/quantize_model.py`）
  - Conv の重みを、出力チャンネルごとの対称スケールで int8 に量子化し、読み込み時に fp32 へ戻すノード（Cast・Mul）を追加
  - 使用しない補助出力（side outputs）を削除
