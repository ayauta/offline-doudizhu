import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function run(label, scriptPath, args = []) {
  console.log(`\n[check] ${label}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("strict TypeScript", join(repositoryRoot, "node_modules/typescript/bin/tsc"), ["--noEmit"]);
run("deterministic tests", join(repositoryRoot, "node_modules/vitest/vitest.mjs"), ["run"]);
run("production build", join(repositoryRoot, "node_modules/vite/bin/vite.js"), ["build"]);
run("build output", join(repositoryRoot, "scripts/check-bundle.mjs"));
run("architecture boundaries", join(repositoryRoot, "scripts/check-boundaries.mjs"));
run("privacy", join(repositoryRoot, "scripts/check-privacy.mjs"));
run("Chromium acceptance", join(repositoryRoot, "scripts/run-browser-tests.mjs"), ["--skip-build"]);
