import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
const requestCapability = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|\bsendBeacon\b/;

for (const path of sourceFiles) {
  const source = await readFile(path, "utf8");
  const displayPath = relative(repositoryRoot, path);
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

if (violations.length > 0) {
  console.error("Architecture boundary check failed:");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log(`Architecture boundary check passed (${sourceFiles.length} source files checked).`);
}
