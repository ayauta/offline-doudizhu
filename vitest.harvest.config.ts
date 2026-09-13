import { defineConfig } from "vitest/config";

/**
 * Spec 054 divergence diagnosis. Kept in its own config so the harvest never
 * mixes into `pnpm bench:ai`, whose report is timing-sensitive, and so
 * `pnpm check` (which collects only `tests/**`) stays fast.
 */
export default defineConfig({
  test: {
    environment: "node",
    // `arms.test.ts` is not a `.probe.test.ts` but guards the generated candidate
    // arm that `harvest.ts` measures against, so a harvest must not run without
    // it. `probe.probe.test.ts` drives the harvest itself.
    include: ["benchmarks/diagnosis/*.probe.test.ts", "benchmarks/diagnosis/arms.test.ts"],
    passWithNoTests: false,
    testTimeout: 900_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    disableConsoleIntercept: true,
  },
});
