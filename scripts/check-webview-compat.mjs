import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findWebView90CompatibilityViolations,
  findWebView90StylesheetViolations,
} from "./webview-compatibility-rules.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(repositoryRoot, "src");

async function runtimeSources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await runtimeSources(path));
    } else if (entry.isFile() && /\.(?:css|tsx?)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const violations = [];
const tsconfig = JSON.parse(await readFile(join(repositoryRoot, "tsconfig.json"), "utf8"));
const libraries = tsconfig.compilerOptions?.lib;
if (!Array.isArray(libraries) || !libraries.includes("ES2021") || libraries.includes("ES2022")) {
  violations.push(
    "tsconfig.json: compilerOptions.lib must use ES2021, the WebView 90 ECMAScript built-in ceiling",
  );
}

for (const path of await runtimeSources(sourceRoot)) {
  const displayPath = relative(repositoryRoot, path).replaceAll("\\", "/");
  const source = await readFile(path, "utf8");
  violations.push(...(
    path.endsWith(".css")
      ? findWebView90StylesheetViolations(source, displayPath)
      : findWebView90CompatibilityViolations(source, displayPath)
  ));
}

if (violations.length > 0) {
  console.error("WebView 90 compatibility check failed:");
  violations.sort().forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log("WebView 90 compatibility check passed.");
}
