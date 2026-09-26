"""IS-Net の Conv 重みを int8 に量子化して、ブラウザ配信用のモデルを作る。

各 Conv の重み W（fp32）を、出力チャンネルごとの対称スケールで
    Mul(Cast(W_int8, to=float), scale)
に置き換える。入力はすべて定数なので、ONNX Runtime はセッション作成時に
定数畳み込みで fp32 の重みへ戻す。ファイルは約 1/4 になり、推論は fp32 のまま。
補助出力（side outputs）は使わないので削除する。

使い方:
    pip install onnx numpy
    curl -L -o isnet-general-use.onnx \
      https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
    python scripts/quantize_model.py isnet-general-use.onnx docs/models/isnet-general-use.int8.onnx
"""

import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def main(src: str, dst: str) -> None:
    model = onnx.load(src)
    graph = model.graph
    inits = {t.name: t for t in graph.initializer}
    conv_weights = sorted({n.input[1] for n in graph.node if n.op_type == "Conv" and n.input[1] in inits})

    new_nodes = []
    for name in conv_weights:
        w = numpy_helper.to_array(inits[name]).astype(np.float32)
        flat = w.reshape(w.shape[0], -1)
        scale = np.abs(flat).max(axis=1) / 127.0
        scale[scale == 0] = 1.0
        q = np.clip(np.round(flat / scale[:, None]), -127, 127).astype(np.int8).reshape(w.shape)
        graph.initializer.remove(inits[name])
        graph.initializer.extend(
            [
                numpy_helper.from_array(q, name + "_q"),
                numpy_helper.from_array(scale.reshape((-1,) + (1,) * (w.ndim - 1)).astype(np.float32), name + "_scale"),
            ]
        )
        new_nodes += [
            helper.make_node("Cast", [name + "_q"], [name + "_f"], to=TensorProto.FLOAT, name=name + "_cast"),
            helper.make_node("Mul", [name + "_f", name + "_scale"], [name], name=name + "_dequant"),
        ]

    while len(graph.output) > 1:
        graph.output.pop()
    nodes = new_nodes + list(graph.node)
    del graph.node[:]
    graph.node.extend(nodes)

    onnx.checker.check_model(model)
    onnx.save(model, dst)
    print(f"quantized {len(conv_weights)} conv weights -> {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: quantize_model.py <input.onnx> <output.onnx>")
    main(sys.argv[1], sys.argv[2])
