import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBrowserTestArguments } from "./browser-test-options.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function run(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const { skipBuild, testArguments } = parseBrowserTestArguments(
  process.argv.slice(2),
);

if (!skipBuild) {
  run(join(repositoryRoot, "node_modules/vite/bin/vite.js"), ["build"]);
}
run(join(repositoryRoot, "node_modules/@playwright/test/cli.js"), ["test", ...testArguments]);
