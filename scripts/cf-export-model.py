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
        .local/cf-rows/model.txt .local/cf-rows/model.json
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
    if len(argv) != 3:
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
    nodes = sum(len(tree["feature"]) for tree in trees)
    print(f"trees {len(trees)}  nodes {nodes}  features {payload['numFeatures']}")
    print(f"model sha256 {payload['modelSha256']}")
    print(f"wrote {out_path}  {len(text) / 1024 / 1024:.2f} MiB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
