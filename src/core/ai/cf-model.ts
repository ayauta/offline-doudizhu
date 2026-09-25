/**
 * Deterministic tree-table evaluator for the frozen Gate A model.
 *
 * It lives in `src/core` because the shipped Worker now scores rows itself: the
 * product has no Python, no SciPy and no LightGBM runtime, so the booster is
 * transcribed into flat node arrays by `scripts/cf-export-model.py` and walked
 * here. Nothing in this file is learned or tuned.
 *
 * The product has no Python, no SciPy and no LightGBM runtime, so the booster
 * is transcribed into flat node arrays by `scripts/cf-export-model.py` and
 * walked here. Nothing in this file is learned or tuned: it is the arithmetic
 * of a decision tree, and `benchmarks/cf-model-equivalence.test.ts` holds it to
 * LightGBM's own predictions on the calibration rows rather than to a reading
 * of the format documentation.
 *
 * The traversal mirrors LightGBM exactly:
 *   - a NaN feature goes to `defaultLeft` when `missingZero` is clear;
 *   - a literal 0.0 is also missing when the split declared `Zero`;
 *   - otherwise the comparison is `value <= threshold`, so equality goes left.
 *
 * The last one is the kind of detail that silently changes a decision: the
 * floating-point thresholds in this model are frequently the tiny
 * `1.0000000180025095e-35` sentinel LightGBM emits for "greater than zero", and
 * a `<` instead of a `<=` would move every exactly-zero feature to the other
 * side of the tree.
 */

export type TreeArrays = Readonly<{
  /** Split feature index, or -1 when the node is a leaf. */
  feature: readonly number[];
  threshold: readonly number[];
  defaultLeft: readonly number[];
  missingZero: readonly number[];
  left: readonly number[];
  right: readonly number[];
  value: readonly number[];
}>;

export type TreeModel = Readonly<{
  formatVersion: number;
  lightgbmVersion: string;
  /** Checksum of the LightGBM artifact this table was transcribed from. */
  modelSha256: string;
  numTrees: number;
  numFeatures: number;
  featureNames: readonly string[];
  trees: readonly TreeArrays[];
}>;

export function parseTreeModel(raw: unknown): TreeModel {
  const record = raw as Partial<TreeModel>;
  if (
    typeof record !== "object" || record === null ||
    !Array.isArray(record.trees) || record.trees.length === 0 ||
    typeof record.numFeatures !== "number" ||
    !Array.isArray(record.featureNames)
  ) {
    throw new Error("Model table is missing required fields.");
  }
  const numFeatures = record.numFeatures;
  const featureNames = record.featureNames as readonly string[];
  for (const tree of record.trees as readonly TreeArrays[]) {
    const size = tree.feature.length;
    if (
      tree.threshold.length !== size || tree.defaultLeft.length !== size ||
      tree.missingZero.length !== size || tree.left.length !== size ||
      tree.right.length !== size || tree.value.length !== size
    ) {
      throw new Error("Model table has ragged node arrays.");
    }
    for (const feature of tree.feature) {
      if (feature >= numFeatures) {
        throw new Error(`Model table references feature ${feature} beyond the schema.`);
      }
    }
  }
  return Object.freeze({
    formatVersion: record.formatVersion ?? 0,
    lightgbmVersion: record.lightgbmVersion ?? "unknown",
    modelSha256: record.modelSha256 ?? "",
    numTrees: (record.numTrees ?? record.trees.length) as number,
    numFeatures,
    featureNames: Object.freeze([...featureNames]),
    trees: record.trees as readonly TreeArrays[],
  });
}

function leafOf(tree: TreeArrays, row: readonly number[]): number {
  let node = 0;
  for (;;) {
    const feature = tree.feature[node];
    if (feature === undefined) {
      throw new Error(`Model table node ${node} is out of range.`);
    }
    if (feature < 0) {
      return tree.value[node] ?? 0;
    }
    const value = row[feature] ?? Number.NaN;
    let goLeft: boolean;
    if (Number.isNaN(value)) {
      goLeft = tree.defaultLeft[node] === 1;
    } else if (tree.missingZero[node] === 1 && value === 0) {
      goLeft = tree.defaultLeft[node] === 1;
    } else {
      // `<=`, not `<`: LightGBM routes an exact tie to the left child.
      goLeft = value <= (tree.threshold[node] ?? 0);
    }
    node = (goLeft ? tree.left[node] : tree.right[node]) ?? 0;
  }
}

/** The model's raw score: the sum of one leaf value per tree, with no offset. */
export function scoreTrees(model: TreeModel, row: readonly number[]): number {
  let total = 0;
  for (const tree of model.trees) {
    total += leafOf(tree, row);
  }
  return total;
}

/** Guard against a row that does not match the schema the model was built on. */
export function assertRowMatchesSchema(model: TreeModel, row: readonly number[]): void {
  if (row.length !== model.numFeatures) {
    throw new Error(`Row has ${row.length} features; the model expects ${model.numFeatures}.`);
  }
}
