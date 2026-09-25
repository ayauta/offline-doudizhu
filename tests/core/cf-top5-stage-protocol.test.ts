/**
 * Spec 065 §14 protocol guards — the stage runner must not be able to leave a
 * partial result on disk.
 *
 * Spec 064's Stage 1 died because intermediate results became readable: the
 * runner streamed per-deal totals into a log. The first cut of this round's
 * runner repeated it more quietly, writing one file per arm, so a complete
 * baseline-only result existed while the challenger was still running. Nothing
 * had to go wrong for it to be read; it was simply there.
 *
 * These guards pin the three properties that make the violation impossible
 * rather than merely discouraged.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CfInvalidError } from "../../benchmarks/cf-dataset.js";
import {
  CF_TOP5_FORMAL_RANGES,
  assertNotFormalRange,
  splitCombined,
  writeCombinedAtomic,
} from "../../benchmarks/cf-top5-stage.js";

const RUNNERS = ["benchmarks/cf-top5-stage1.test.ts"];

/** Source text of a runner, for the order-of-operations guards. */
const source = (path: string): string => readFileSync(path, "utf8");

let scratch: string | null = null;
afterEach(() => {
  if (scratch !== null) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

describe("spec065 §14: a formal pool admits exactly one output mode", () => {
  it("refuses a per-arm write anywhere inside either formal pool", () => {
    for (const range of CF_TOP5_FORMAL_RANGES) {
      expect(() => assertNotFormalRange(range.start, 1, "The per-arm mode")).toThrow(CfInvalidError);
      expect(() => assertNotFormalRange(range.end, 1, "The per-arm mode")).toThrow(CfInvalidError);
    }
    // The pools are the preregistered ones, not something retyped nearby.
    expect(CF_TOP5_FORMAL_RANGES.map((r) => [r.name, r.start, r.end])).toEqual([
      ["stage1", 160_001, 160_200],
      ["stage2", 170_001, 171_200],
    ]);
  });

  it("refuses a window that merely overlaps a formal pool", () => {
    // Starting one below the pool still deals a formal card on the next
    // iteration, so "the first deal was outside" must not be enough.
    expect(() => assertNotFormalRange(170_000, 2, "The per-arm mode")).toThrow(/stage2/);
    expect(() => assertNotFormalRange(160_200, 2, "The per-arm mode")).toThrow(/stage1/);
    // …and the fully-covering window too.
    expect(() => assertNotFormalRange(150_000, 30_000, "The per-arm mode")).toThrow(CfInvalidError);
  });

  it("allows retired ranges, which is what a smoke run needs", () => {
    expect(() => assertNotFormalRange(50_001, 30, "The per-arm mode")).not.toThrow();
    expect(() => assertNotFormalRange(100_001, 200, "The per-arm mode")).not.toThrow();
    expect(() => assertNotFormalRange(140_001, 200, "The per-arm mode")).not.toThrow();
  });
});

describe("spec065 §14: the combined result is written once, atomically", () => {
  it("leaves no partial file and no temp fragment behind", () => {
    scratch = mkdtempSync(join(tmpdir(), "cf-top5-"));
    const path = join(scratch, "result.json");
    expect(existsSync(path)).toBe(false);
    writeCombinedAtomic(path, { arms: { baseline: 1, challenger: 2 } });
    expect(existsSync(path)).toBe(true);
    // The destination was never a half-written document, and the temp name is
    // gone — a crash cannot leave a readable fragment where someone watches.
    expect(readdirSync(scratch)).toEqual(["result.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ arms: { baseline: 1, challenger: 2 } });
  });

  it("keeps both arms in the one document, so neither can be read alone", () => {
    const combined = {
      label: "spec065-top5-combined",
      config: {},
      preregisteredUniverse: { start: 160_001, end: 160_200 },
      preregisteredStage2: { start: 170_001, end: 171_200 },
      arms: {
        baseline: { perDealA: [1], perDealB: [2], cost: {} },
        challenger: { perDealA: [1], perDealB: [3], cost: {} },
      },
      completedAt: "t",
    };
    const { baseline, challenger } = splitCombined(combined);
    expect(JSON.stringify(baseline)).toContain("[1]");
    expect(JSON.stringify(challenger)).toContain("[3]");
  });
});

describe("spec065 §14: parallel arms still leave no partial result", () => {
  const COORDINATOR = "scripts/cf-top5-stage-run.mjs";
  const coordinator = (): string => readFileSync(COORDINATOR, "utf8");

  it("has the children write nothing, so no arm can reach disk on its own", () => {
    // The arm mode's whole point: the result leaves through stdout. A child
    // that wrote a file would put a complete one-armed result on disk the
    // moment it finished, which is the violation this protocol exists to stop.
    const runner = source("benchmarks/cf-top5-stage1.test.ts");
    const armAt = runner.indexOf("if (ARM_STDOUT !== undefined) {");
    const combinedAt = runner.indexOf("if (COMBINED !== undefined) {");
    expect(armAt).toBeGreaterThanOrEqual(0);
    const armBlock = runner.slice(armAt, combinedAt);
    expect(armBlock).toContain("process.stdout.write(");
    for (const writer of ["writeFileSync", "writeCombinedAtomic", "renameSync", "mkdirSync"]) {
      expect(armBlock, `the arm mode must not call ${writer}`).not.toContain(writer);
    }
  });

  it("writes the combined file exactly once, after both arms have exited", () => {
    const text = coordinator();
    const writes = text.match(/renameSync\(temporary, outPath\)/g) ?? [];
    expect(writes.length).toBe(1);
    const writeAt = text.indexOf("renameSync(temporary, outPath)");
    // Both arms must be awaited before the write.
    const awaitAt = text.indexOf("await Promise.all(");
    expect(awaitAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(awaitAt);
  });

  it("refuses to leave a surviving .partial behind", () => {
    expect(coordinator()).toContain(".partial");
    expect(coordinator()).toMatch(/process\.exit\(1\)/);
  });

  it("never passes quiet: false through to the arms", () => {
    expect(coordinator()).not.toMatch(/quiet:\s*false/);
    expect(source("benchmarks/cf-top5-stage1.test.ts")).toMatch(/^\s*quiet:\s*true/m);
  });
});

describe("spec065 §14: a one-armed document is not reportable", () => {
  it("refuses to derive paired dumps from a combined file missing an arm", () => {
    // The report path re-checks this itself, so a hand-edited or truncated
    // combined file cannot be turned into a "result". The check is duplicated
    // here against `splitCombined` because that is the function a future
    // caller would reach for.
    const oneArmed = {
      label: "x", config: {},
      preregisteredUniverse: { start: 160_001, end: 160_200 },
      preregisteredStage2: { start: 170_001, end: 171_200 },
      arms: { baseline: { perDealA: [1], perDealB: [1], cost: {} } },
      completedAt: "t",
    } as unknown as Parameters<typeof splitCombined>[0];
    expect(() => splitCombined(oneArmed)).toThrow();
  });

  it("checks both arms are present before deriving anything", () => {
    // A source guard rather than a behavioural one: the runner is env-gated and
    // spawning it with a hand-built one-armed file would cost more than it
    // proves. Note that `splitCombined` also throws on a missing arm — that is
    // the belt; this is the braces, and it is the half that produces a readable
    // error instead of a TypeError.
    for (const path of RUNNERS) {
      const text = source(path);
      const checkAt = text.indexOf("combined.arms?.[arm] === undefined");
      const splitAt = text.indexOf("splitCombined(");
      expect(checkAt, `${path} must check for both arms`).toBeGreaterThanOrEqual(0);
      expect(splitAt, `${path} must derive after the check`).toBeGreaterThan(checkAt);
    }
  });

  it("only writes the derived dumps from the report path, never the run path", () => {
    for (const path of RUNNERS) {
      const text = source(path);
      // The dumps are written after `splitCombined`, which reads the completed
      // document — so they cannot exist before both arms do.
      const dumpAt = text.indexOf(".baseline.json");
      const splitAt = text.indexOf("splitCombined(");
      expect(splitAt).toBeGreaterThanOrEqual(0);
      expect(dumpAt).toBeGreaterThan(splitAt);
      // …and never in the combined mode, which writes exactly one file.
      const combinedAt = text.indexOf("if (COMBINED !== undefined)");
      const reportAt = text.indexOf("if (REPORT");
      if (reportAt >= 0 && reportAt > combinedAt) {
        expect(dumpAt).toBeGreaterThan(reportAt);
      }
    }
  });
});

describe("spec065 §14: the runner cannot regress into a partial-result shape", () => {
  it("writes the combined result exactly once, after both arms have run", () => {
    for (const path of RUNNERS) {
      const text = source(path);
      const writes = text.match(/writeCombinedAtomic\(/g) ?? [];
      expect(writes.length, `${path} must write the combined file exactly once`).toBe(1);
      // …and that single write must come after both arms were computed.
      const writeAt = text.indexOf("writeCombinedAtomic(");
      for (const arm of ['runArm("baseline")', 'runArm("challenger")']) {
        const armAt = text.indexOf(arm);
        expect(armAt, `${path} must run ${arm}`).toBeGreaterThanOrEqual(0);
        expect(writeAt, `${path}: the write must follow ${arm}`).toBeGreaterThan(armAt);
      }
    }
  });

  it("refuses the per-arm *file* mode before it can run an arm on a formal range", () => {
    for (const path of RUNNERS) {
      const text = source(path);
      // Scoped to the branch that writes a file. The stdout arm mode also runs
      // an arm — legitimately, on formal ranges, because it writes nothing and
      // the coordinator is the only writer. The prohibition is on per-arm
      // *files*, so the guard has to name that branch rather than the call.
      const outAt = text.indexOf("if (OUT !== undefined) {");
      const reportAt = text.indexOf("if (REPORT");
      expect(outAt, `${path} must have a per-arm file mode`).toBeGreaterThanOrEqual(0);
      const fileBlock = text.slice(outAt, reportAt > outAt ? reportAt : undefined);
      const guardAt = fileBlock.indexOf("assertNotFormalRange(");
      const runAt = fileBlock.indexOf("runArm(arm)");
      expect(guardAt, `${path}: the file mode must guard before running`).toBeGreaterThanOrEqual(0);
      expect(runAt).toBeGreaterThan(guardAt);
    }
  });

  it("never passes quiet: false in a stage runner", () => {
    for (const path of RUNNERS) {
      expect(source(path), path).not.toMatch(/^\s*quiet:\s*false/m);
      expect(source(path), path).toMatch(/^\s*quiet:\s*true/m);
    }
  });
});
