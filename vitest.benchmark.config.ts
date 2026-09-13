import { defineConfig } from "vitest/config";

/**
 * The AI benchmark is deliberately outside `pnpm check` (spec 051: it runs
 * "during tuning or release—not on every edit"). It measures wall-clock time,
 * so it must never share a CPU with another test file.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["benchmarks/**/*.test.ts"],
    passWithNoTests: false,
    // A backstop only. A fixed timeout next to a fixed deal target is how the
    // previous harness lost an 82-second run's entire report; the runner stops
    // itself cleanly via AI_BENCH_SECONDS long before this fires.
    testTimeout: 900_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    // Progress lines must stream, not buffer until the test ends.
    disableConsoleIntercept: true,
  },
});
