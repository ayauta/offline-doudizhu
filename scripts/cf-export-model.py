#!/usr/bin/env python3
"""Export the frozen Gate A LightGBM artifact into a portable tree table.

The product runtime must not depend on Python, SciPy, or the LightGBM Python
package, so the frozen booster is flattened into a plain JSON table that a
deterministic TypeScript evaluator can walk. Nothing about the model changes:
this is a transcription, and the transcription is verified against LightGBM's
own predictions on the calibration rows by
`benchmarks/cf-model-equivalence.test.ts`.

Node arrays are flat and indexed within each tree so the evaluator does no
parsing and allocates nothing per decision:

    feature[i]      split feature index, or -1 for a leaf
    threshold[i]    split threshold, unused for leaves
    defaultLeft[i]  1 when a missing value goes left
    missingZero[i]  1 when a literal 0.0 counts as missing (LightGBM's "Zero")
    left[i]         left child index, unused for leaves
    right[i]        right child index, unused for leaves
    value[i]        leaf value, unused for internal nodes

    PYTHONPATH=.local/pylibs python3 scripts/cf-export-model.py \\
        .local/cf-rows/model.txt .local/cf-rows/model.json src/app/ai/cf-model-data.ts
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import lightgbm as lgb


def flatten(node: dict, arrays: dict) -> int:
    index = len(arrays["feature"])
    for key in ("feature", "threshold", "defaultLeft", "missingZero", "left", "right", "value"):
        arrays[key].append(0)
    if "split_index" in node:
        arrays["feature"][index] = node["split_feature"]
        arrays["threshold"][index] = float(node["threshold"])
        arrays["defaultLeft"][index] = 1 if node["default_left"] else 0
        arrays["missingZero"][index] = 1 if node.get("missing_type") == "Zero" else 0
        arrays["value"][index] = 0.0
        left = flatten(node["left_child"], arrays)
        right = flatten(node["right_child"], arrays)
        arrays["left"][index] = left
        arrays["right"][index] = right
    else:
        arrays["feature"][index] = -1
        arrays["value"][index] = float(node["leaf_value"])
    return index


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    model_path, out_path = Path(argv[1]), Path(argv[2])
    model_text = model_path.read_text()
    booster = lgb.Booster(model_str=model_text)
    dump = booster.dump_model()

    trees = []
    for info in dump["tree_info"]:
        arrays = {key: [] for key in
                  ("feature", "threshold", "defaultLeft", "missingZero", "left", "right", "value")}
        flatten(info["tree_structure"], arrays)
        trees.append(arrays)

    payload = {
        "formatVersion": 1,
        "lightgbmVersion": lgb.__version__,
        "modelSha256": hashlib.sha256(model_text.encode()).hexdigest(),
        "objective": dump["objective"],
        "numTrees": len(trees),
        "numFeatures": len(dump["feature_names"]),
        "featureNames": dump["feature_names"],
        "averageOutput": bool(dump["average_output"]),
        "trees": trees,
    }
    text = json.dumps(payload, separators=(",", ":"))
    out_path.write_text(text + "\n")

    # The shipped Worker cannot fetch — `check-boundaries` forbids request APIs
    # anywhere in `src/` — so the artifact ships as a bundled module. It is
    # emitted as one JSON string literal rather than as half a megabyte of
    # numeric array literals so that `tsc` does not have to type-check 94,000
    # numbers on every gate run; the string is the same JSON, and
    # `parseTreeModel` validates it on load.
    if len(argv) >= 4:
        threshold_path = Path(argv[4]) if len(argv) >= 5 else None
        threshold = 0.0
        if threshold_path is not None:
            record = json.loads(threshold_path.read_text())
            if record.get("decision") != "selected" or not isinstance(record.get("selected"), (int, float)):
                raise SystemExit("refusing to package: no threshold was frozen")
            threshold = float(record["selected"])
        ts_path = Path(argv[3])
        ts_path.write_text(
            "/**\n"
            " * The frozen Gate A model, transcribed by `scripts/cf-export-model.py`.\n"
            " *\n"
            " * Generated. Do not edit. `modelSha256` identifies the LightGBM artifact this\n"
            " * table was transcribed from; the shipped Worker parses it on first use and\n"
            " * falls back to production's own move if anything about it is wrong.\n"
            " */\n"
            f'export const CF_MODEL_SHA256 = "{payload["modelSha256"]}";\n'
            f"export const CF_SELECTOR_THRESHOLD = {threshold!r};\n"
            "export const CF_MODEL_JSON = " + json.dumps(text) + ";\n"
        )
        print(f"wrote {ts_path}  {ts_path.stat().st_size / 1024 / 1024:.2f} MiB")
    nodes = sum(len(tree["feature"]) for tree in trees)
    print(f"trees {len(trees)}  nodes {nodes}  features {payload['numFeatures']}")
    print(f"model sha256 {payload['modelSha256']}")
    print(f"wrote {out_path}  {len(text) / 1024 / 1024:.2f} MiB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
