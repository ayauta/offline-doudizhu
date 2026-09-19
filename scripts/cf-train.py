#!/usr/bin/env python3
"""Gate A v1: fit the single frozen LightGBM and score the calibration rows.

This script does exactly two things — fit, and predict. Every decision that the
preregistration freezes (which candidate wins, when to override, how a group
reduces to one number, what a threshold's lower bound is) lives in
`benchmarks/cf-selector.ts`, where it is unit-tested. Keeping the boundary this
narrow is what makes the frozen artifact readable: this file has no thresholds,
no gates and no statistics in it.

There is no hyperparameter search here on purpose. The configuration is written
out below as literals so that "we did not tune it" is verifiable by reading.

    PYTHONPATH=.local/pylibs python3 scripts/cf-train.py <rows-dir>

Reads  <rows-dir>/train.rows.json and <rows-dir>/calibration.rows.json
Writes <rows-dir>/model.txt, train-config.json, calibration.scores.json
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np

# Frozen by docs/specs/062-counterfactual-policy-improvement/spec.md §16.2.
# Do not edit without invalidating the corpus and the preregistration.
PARAMS = {
    "objective": "regression",
    "metric": "l2",
    "num_iterations": 256,
    "max_depth": 6,
    "num_leaves": 31,
    "learning_rate": 0.05,
    "min_data_in_leaf": 100,
    "lambda_l1": 0.0,
    "lambda_l2": 5.0,
    "feature_fraction": 1.0,
    "bagging_fraction": 1.0,
    "bagging_freq": 0,
    "max_bin": 63,
    "num_threads": 1,
    "deterministic": True,
    "force_col_wise": True,
    "verbosity": -1,
}
SEED = 20260920
TRAINING_CONFIG_VERSION = "gateA-v1-frozen"


def load(path: Path) -> dict:
    with path.open() as handle:
        return json.load(handle)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    directory = Path(argv[1])
    train = load(directory / "train.rows.json")
    calibration = load(directory / "calibration.rows.json")

    if train["schemaHash"] != calibration["schemaHash"]:
        raise SystemExit("train and calibration were built from different schemas")
    if train["featureNames"] != calibration["featureNames"]:
        raise SystemExit("train and calibration disagree on feature ordering")

    def matrix(rows: list[dict]) -> np.ndarray:
        return np.asarray([row["x"] for row in rows], dtype=np.float64)

    x_train = matrix(train["rows"])
    y_train = np.asarray([row["y"] for row in train["rows"]], dtype=np.float64)
    w_train = np.asarray([row["w"] for row in train["rows"]], dtype=np.float64)

    print(f"train rows {len(y_train)}  features {x_train.shape[1]}")
    print(f"  labels +1 {int((y_train > 0).sum())}  0 {int((y_train == 0).sum())}  -1 {int((y_train < 0).sum())}")
    print(f"  weight mean {w_train.mean():.6f} min {w_train.min():.6f} max {w_train.max():.6f}")

    dataset = lgb.Dataset(
        x_train,
        label=y_train,
        weight=w_train,
        feature_name=list(train["featureNames"]),
        free_raw_data=False,
    )
    booster = lgb.train({**PARAMS, "seed": SEED, "data_random_seed": SEED}, dataset)

    model_text = booster.model_to_string()
    (directory / "model.txt").write_text(model_text)
    model_sha = hashlib.sha256(model_text.encode()).hexdigest()

    x_calibration = matrix(calibration["rows"])
    predictions = booster.predict(x_calibration)
    scores = {
        row["id"]: float(value)
        for row, value in zip(calibration["rows"], predictions)
    }
    (directory / "calibration.scores.json").write_text(
        json.dumps({"scores": scores, "modelSha256": model_sha}, sort_keys=True) + "\n"
    )

    config = {
        "trainingConfigVersion": TRAINING_CONFIG_VERSION,
        "lightgbmVersion": lgb.__version__,
        "numpyVersion": np.__version__,
        "params": {**PARAMS, "seed": SEED, "data_random_seed": SEED},
        "schemaHash": train["schemaHash"],
        "featureNames": train["featureNames"],
        "objective": "E[label | legal observation, candidate, a0], L2",
        "trainedOn": "non-a0 candidate rows of the train split only",
        "rowWeights": "1/(roots_in_group * alternatives_at_root), normalised to mean 1",
        "rowOrder": "corpus order: group ascending, snapshot order, candidate order",
        "trainRows": len(y_train),
        "calibrationRows": len(calibration["rows"]),
        "modelSha256": model_sha,
    }
    (directory / "train-config.json").write_text(json.dumps(config, indent=2) + "\n")

    print(f"model sha256 {model_sha}")
    print(f"calibration rows scored {len(scores)}")
    print(f"score mean {float(np.mean(predictions)):.6f} sd {float(np.std(predictions)):.6f} "
          f"min {float(np.min(predictions)):.6f} max {float(np.max(predictions)):.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
