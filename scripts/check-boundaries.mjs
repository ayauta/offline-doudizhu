import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAIN_FORBIDDEN_PATHS,
  MAIN_RUNTIME_ENTRIES,
  WORKER_ENTRY,
  WORKER_FORBIDDEN_PREFIXES,
  WORKER_REQUIRED_PATHS,
} from "./ai-delivery-rules.mjs";
import { runtimeImportClosure } from "./runtime-import-graph.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(repositoryRoot, "src");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(path));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const violations = [];
const sourceFiles = await walk(sourceRoot);
const sources = new Map();
const requestCapability = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|\bsendBeacon\b/;

for (const path of sourceFiles) {
  const source = await readFile(path, "utf8");
  const displayPath = relative(repositoryRoot, path);
  sources.set(displayPath.replaceAll("\\", "/"), source);
  const segments = displayPath.split(sep);
  const layer = segments[1];
  const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);

  if (requestCapability.test(source)) {
    violations.push(`${displayPath}: application source contains network capability`);
  }

  if (layer === "core") {
    const forbidden = [
      ["DOM/browser global", /\b(?:document|window|navigator|HTMLElement|Element|PointerEvent)\b/],
      ["browser storage", /\b(?:localStorage|sessionStorage|indexedDB)\b/],
      ["ambient randomness", /\bMath\.random\b/],
      ["wall-clock time", /\bDate\.(?:now|parse|UTC)\b|\bnew\s+Date\b/],
      ["timer", /\bset(?:Timeout|Interval)\b/],
      ["CommonJS require", /\brequire\s*\(/],
    ];
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) {
        violations.push(`${displayPath}: forbidden ${label}`);
      }
    }
    for (const specifier of imports) {
      if (specifier.startsWith("node:") || /(?:^|\/)(?:app|ui|platform)(?:\/|$)/.test(specifier)) {
        violations.push(`${displayPath}: forbidden core dependency on ${specifier}`);
      }
      if (specifier === "preact" || specifier.startsWith("preact/")) {
        violations.push(`${displayPath}: renderer dependency entered core`);
      }
    }
  }

  if (layer === "app") {
    const forbidden = /\b(?:document|window|navigator|localStorage|sessionStorage|indexedDB|HTMLElement|PointerEvent|serviceWorker)\b/;
    if (forbidden.test(source)) {
      violations.push(`${displayPath}: app session depends on DOM/browser capability`);
    }
    for (const specifier of imports) {
      if (/(?:^|\/)(?:ui|platform)(?:\/|$)/.test(specifier) || specifier === "preact" || specifier.startsWith("preact/")) {
        violations.push(`${displayPath}: forbidden app dependency on ${specifier}`);
      }
    }
  }

  if (layer === "ui") {
    const forbidden = /\b(?:window|navigator|localStorage|sessionStorage|indexedDB|serviceWorker)\b/;
    if (forbidden.test(source)) {
      violations.push(`${displayPath}: UI accesses a platform-owned browser capability`);
    }
    for (const specifier of imports) {
      if (/(?:^|\/)platform(?:\/|$)/.test(specifier)) {
        violations.push(`${displayPath}: UI imports platform adapter ${specifier}`);
      }
    }
  }

  if (layer === "platform") {
    for (const specifier of imports) {
      if (/(?:^|\/)(?:core|ui)(?:\/|$)/.test(specifier)) {
        violations.push(`${displayPath}: platform adapter imports ${specifier}`);
      }
    }
  }
}

for (const entryPath of MAIN_RUNTIME_ENTRIES) {
  const closure = runtimeImportClosure(sources, entryPath);
  for (const forbiddenPath of MAIN_FORBIDDEN_PATHS) {
    if (closure.has(forbiddenPath)) {
      violations.push(`${entryPath}: main runtime closure reaches enhanced-only ${forbiddenPath}`);
    }
  }
}

const workerClosure = runtimeImportClosure(sources, WORKER_ENTRY);
for (const requiredPath of WORKER_REQUIRED_PATHS) {
  if (!workerClosure.has(requiredPath)) {
    violations.push(`${WORKER_ENTRY}: worker runtime closure is missing ${requiredPath}`);
  }
}
for (const reachedPath of workerClosure) {
  for (const prefix of WORKER_FORBIDDEN_PREFIXES) {
    if (reachedPath.startsWith(prefix)) {
      violations.push(`${WORKER_ENTRY}: worker runtime closure reaches ${reachedPath}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary check failed:");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log(`Architecture boundary check passed (${sourceFiles.length} source files checked).`);
}
