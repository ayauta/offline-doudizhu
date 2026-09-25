#!/usr/bin/env python3
"""Fit the three role Q models for the full-action self-play research line.

This script fits and transcribes. Every decision that the research proposal
freezes — which action wins, what the reward is, how a batch is split, when a
model is good enough — lives in TypeScript under `benchmarks/`, where it is
unit-tested. What is here is the one thing TypeScript cannot do: run LightGBM.

    PYTHONPATH=.local/pylibs python3 scripts/selfplay-train.py <rows-dir>

Reads, per role in `landlord`, `farmer-next`, `farmer-previous`:

    <rows-dir>/<role>.train.x.f32    float32, row-major, `manifest.json` says how wide
    <rows-dir>/<role>.train.y.f32    float32, one per row

Writes:

    <rows-dir>/<role>.model.json     the flattened tree table the TS evaluator reads
    <rows-dir>/<role>.train-config.json
    <rows-dir>/manifest.out.json

There is no hyperparameter search here on purpose. The configuration is written
below as literals so that "we did not tune it" is checkable by reading.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np

# Frozen by research/full-action-selfplay-v1 as the engineering starting point.
# Not claimed optimal, and deliberately not searched over.
PARAMS = {
    "objective": "regression",
    "metric": "l2",
    "num_iterations": 512,
    "max_depth": 8,
    "num_leaves": 63,
    "learning_rate": 0.05,
    "min_data_in_leaf": 100,
    "lambda_l1": 0.0,
    "lambda_l2": 5.0,
    "max_bin": 255,
    "num_threads": 1,
    "deterministic": True,
    "force_col_wise": True,
    "verbosity": -1,
}
SEED = 20260924
TRAINING_CONFIG_VERSION = "fas-lgbm-v1"
ROLES = ("landlord", "farmer-next", "farmer-previous")


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# The columns that describe the candidate action rather than the position. A
# model fitted without them answers "how good is this position", and comparing
# it against the full model is the sharpest available test of whether the action
# columns carry anything the position columns do not.
ACTION_PREFIXES = ("act_", "post_", "delta_")


def state_only_indices(names: list) -> list:
    return [index for index, name in enumerate(names) if not name.startswith(ACTION_PREFIXES)]


def flatten(booster: lgb.Booster, num_features: int, remap: list | None = None) -> dict:
    """The booster as six flat per-tree node arrays.

    Node arrays are indexed within each tree, so the TypeScript evaluator does no
    parsing and allocates nothing per decision. `defaultLeft` and `missingZero`
    carry LightGBM's own missing-value routing, which is what makes a NaN feature
    mean the same thing on both sides of the boundary.
    """
    dump = booster.dump_model()
    trees = []
    for tree in dump["tree_info"]:
        structure = tree["tree_structure"]
        feature: list[int] = []
        threshold: list[float] = []
        default_left: list[int] = []
        missing_zero: list[int] = []
        left: list[int] = []
        right: list[int] = []
        value: list[float] = []

        def walk(node: dict) -> int:
            index = len(feature)
            feature.append(-1)
            threshold.append(0.0)
            default_left.append(0)
            missing_zero.append(0)
            left.append(0)
            right.append(0)
            value.append(0.0)
            if "split_feature" in node:
                if node["split_feature"] >= num_features:
                    raise SystemExit(
                        f"Tree splits on feature {node['split_feature']}, outside the "
                        f"{num_features}-column schema."
                    )
                feature[index] = (
                    int(node["split_feature"])
                    if remap is None
                    else int(remap[node["split_feature"]])
                )
                threshold[index] = float(node["threshold"])
                default_left[index] = 1 if node.get("default_left", False) else 0
                missing_zero[index] = 1 if node.get("missing_type", "None") == "Zero" else 0
                left[index] = walk(node["left_child"])
                right[index] = walk(node["right_child"])
            else:
                value[index] = float(node["leaf_value"])
            return index

        walk(structure)
        trees.append(
            {
                "feature": feature,
                "threshold": threshold,
                "defaultLeft": default_left,
                "missingZero": missing_zero,
                "left": left,
                "right": right,
                "value": value,
            }
        )
    return {
        "formatVersion": 1,
        "lightgbmVersion": lgb.__version__,
        "modelSha256": "",
        "numTrees": len(trees),
        "numFeatures": num_features,
        "featureNames": [],
        "trees": trees,
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    rows_dir = Path(sys.argv[1])
    manifest = json.loads((rows_dir / "manifest.json").read_text())
    width = int(manifest["featureCount"])
    names = manifest["featureNames"]

    out_manifest = {
        "trainingConfigVersion": TRAINING_CONFIG_VERSION,
        "params": PARAMS,
        "seed": SEED,
        "lightgbmVersion": lgb.__version__,
        "schemaHash": manifest["schemaHash"],
        "featureCount": width,
        "roles": {},
    }

    for role in ROLES:
        x_path = rows_dir / f"{role}.train.x.f32"
        y_path = rows_dir / f"{role}.train.y.f32"
        if not x_path.exists():
            raise SystemExit(f"Missing training rows for role {role}: {x_path}")
        x = np.fromfile(x_path, dtype="<f4").reshape(-1, width)
        y = np.fromfile(y_path, dtype="<f4")
        if x.shape[0] != y.shape[0]:
            raise SystemExit(f"{role}: {x.shape[0]} rows but {y.shape[0]} targets.")
        if x.shape[0] == 0:
            raise SystemExit(f"{role}: no training rows.")

        constant_l2 = float(np.mean((y - y.mean()) ** 2))
        fit = {}

        for label, columns, remap in (
            ("full", list(range(width)), None),
            ("state-only", state_only_indices(names), state_only_indices(names)),
        ):
            train_set = lgb.Dataset(
                x[:, columns], label=y, feature_name=[names[i] for i in columns], free_raw_data=False
            )
            booster = lgb.train(PARAMS, train_set, num_boost_round=PARAMS["num_iterations"])
            model = flatten(booster, width, remap)
            model["featureNames"] = names

            stem = role if label == "full" else f"{role}.stateonly"
            model_path = rows_dir / f"{stem}.model.json"
            model_path.write_text(json.dumps(model, separators=(",", ":")))
            digest = sha256_of(model_path)
            # The digest is of the file without the digest in it, so the recorded
            # value is one a reader can reproduce from disk.
            recorded = json.loads(model_path.read_text())
            recorded["modelSha256"] = digest
            model_path.write_text(json.dumps(recorded, separators=(",", ":")))

            train_l2 = float(np.mean((booster.predict(x[:, columns]) - y) ** 2))
            fit[label] = {
                "columns": len(columns),
                "rows": int(x.shape[0]),
                "modelSha256": digest,
                "modelBytes": model_path.stat().st_size,
                "numTrees": model["numTrees"],
                "trainL2": train_l2,
                "constantBaselineL2": constant_l2,
            }
            print(
                f"[selfplay-train] {role} [{label}]: {x.shape[0]} rows x {len(columns)} cols, "
                f"{model['numTrees']} trees, train L2 {train_l2:.6f} "
                f"(constant baseline {constant_l2:.6f}), "
                f"{model_path.stat().st_size / 1e6:.2f} MB, sha256 {digest[:16]}…"
            )

        (rows_dir / f"{role}.train-config.json").write_text(
            json.dumps(
                {
                    "params": PARAMS,
                    "seed": SEED,
                    "trainingConfigVersion": TRAINING_CONFIG_VERSION,
                    "actionPrefixes": list(ACTION_PREFIXES),
                    "fits": fit,
                },
                indent=2,
            )
        )
        out_manifest["roles"][role] = fit

    (rows_dir / "manifest.out.json").write_text(json.dumps(out_manifest, indent=2))
    print(f"[selfplay-train] wrote {rows_dir / 'manifest.out.json'}")


if __name__ == "__main__":
    main()
