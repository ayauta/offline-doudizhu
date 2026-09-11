import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const distRoot = join(repositoryRoot, "dist");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Build output check failed: ${message}`);
  }
}

const files = await walk(distRoot);
const relativePaths = files.map((path) => relative(distRoot, path).replaceAll("\\", "/"));
for (const required of ["index.html", "embedded.html", "manifest.webmanifest", "sw.js", "icon.svg"]) {
  assert(relativePaths.includes(required), `missing ${required}`);
}
assert(relativePaths.some((path) => /^assets\/.+\.js$/.test(path)), "missing application JavaScript");
assert(relativePaths.some((path) => /^assets\/.+\.css$/.test(path)), "missing application CSS");
const aiWorkerPaths = relativePaths.filter((path) => /^assets\/ai-worker-[^/]+\.js$/.test(path));
assert(aiWorkerPaths.length === 1, "enhanced AI must emit exactly one dedicated worker asset");
assert(!relativePaths.some((path) => path.endsWith(".map")), "source maps must not be emitted");

const manifest = JSON.parse(await readFile(join(distRoot, "manifest.webmanifest"), "utf8"));
assert(manifest.name === "单机斗地主", "unexpected manifest name");
assert(manifest.short_name === "单机斗地主", "unexpected manifest short name");
assert(manifest.display === "standalone", "manifest must use standalone display");
assert(manifest.orientation === "landscape", "manifest must require landscape");
assert(manifest.start_url === "./" && manifest.scope === "./", "manifest URLs must be relative");
assert(Array.isArray(manifest.icons) && manifest.icons.some((icon) => icon.src === "icon.svg"), "manifest icon is missing");

const indexHtml = await readFile(join(distRoot, "index.html"), "utf8");
assert(!/["']\/(?:assets|src)\//.test(indexHtml), "index contains a root-absolute asset URL");
assert(!indexHtml.includes(repositoryRoot), "index leaks a private local path");

const embeddedHtml = await readFile(join(distRoot, "embedded.html"), "utf8");
assert(!/["']\/(?:assets|src)\//.test(embeddedHtml), "embedded entry contains a root-absolute asset URL");
assert(!embeddedHtml.includes(repositoryRoot), "embedded entry leaks a private local path");
assert(!embeddedHtml.includes("sw.js"), "embedded entry directly references the PWA worker");

const worker = await readFile(join(distRoot, "sw.js"), "utf8");
assert(worker.includes("precacheAndRoute"), "worker has no precache route");
if (/\bskipWaiting\s*\(/.test(worker)) {
  assert(worker.includes("SKIP_WAITING"), "worker contains unconditional skipWaiting");
}
assert(!/\bclientsClaim\s*\(/.test(worker), "worker would forcibly claim an open session");

const applicationJavaScript = await Promise.all(
  files
    .filter((path) => /^assets\/.+\.js$/.test(relative(distRoot, path).replaceAll("\\", "/")))
    .map((path) => readFile(path, "utf8")),
);
assert(!applicationJavaScript.some((source) => source.includes("SKIP_WAITING")), "application can force an update into the active session");

const cacheablePaths = relativePaths.filter((path) =>
  path !== "embedded.html" && path !== "sw.js" && !/^workbox-[^/]+\.js$/.test(path),
);
for (const path of cacheablePaths) {
  assert(worker.includes(path), `${path} is absent from the precache manifest`);
}
assert(!worker.includes('url:"embedded.html"') && !worker.includes('url: "embedded.html"'), "embedded entry entered the PWA precache");

for (const match of worker.matchAll(/url\s*:\s*["']([^"']+)["']/g)) {
  const url = match[1];
  assert(url !== undefined && !/^(?:https?:)?\/\//.test(url) && !url.startsWith(".."), `non-local precache URL: ${url}`);
}

for (const path of files.filter((item) => /\.(?:css|html|js|json|svg|webmanifest)$/.test(item))) {
  const contents = await readFile(path, "utf8");
  assert(!contents.includes(repositoryRoot), `${basename(path)} leaks a private local path`);
}

/**
 * Reviewed gzip budgets for the first-load payload.
 *
 * Production tree shaking removes an unused re-export, so no size budget can
 * catch the development-only barrel problem — `scripts/check-boundaries.mjs`
 * owns that through the runtime import closure. These budgets cover the other
 * direction: enhanced policy reaching the main entry anyway, or the payload
 * growing without anyone deciding to spend the bytes.
 *
 * Each limit is anchored to a measurement rather than a round number: the
 * current baseline plus a third of the smallest regression worth catching.
 * The build is deterministic (pinned toolchain, no source maps), so these are
 * hard limits and never flake.
 */
const gzipBudgets = [
  {
    // 20 139 B baseline + 2 587 B (one enhanced module on the main entry) / 3.
    label: "main JavaScript",
    limitBytes: 21_001,
    pattern: /^assets\/main-[^/]+\.js$/,
  },
  {
    // 5 445 B baseline + 1 200 B (the removed computer-level sheet) / 3.
    label: "application CSS",
    limitBytes: 5_845,
    pattern: /^assets\/main-[^/]+\.css$/,
  },
  {
    // 8 355 B baseline + 2 587 B (one enhanced policy module) / 3.
    label: "enhanced AI worker",
    limitBytes: 9_217,
    pattern: /^assets\/ai-worker-[^/]+\.js$/,
  },
];

const gzipReport = [];
for (const { label, limitBytes, pattern } of gzipBudgets) {
  const matches = files.filter((path) => pattern.test(relative(distRoot, path).replaceAll("\\", "/")));
  assert(matches.length === 1, `expected exactly one ${label} asset, found ${matches.length}`);
  const bytes = gzipSync(await readFile(matches[0]), { level: 9 }).length;
  const kib = (value) => (value / 1024).toFixed(2);
  gzipReport.push(`${label} ${kib(bytes)}/${kib(limitBytes)} KiB gzip`);
  assert(
    bytes <= limitBytes,
    `${label} is ${bytes} B gzip, ${bytes - limitBytes} B over the reviewed ${limitBytes} B budget`,
  );
}

console.log(`Build output check passed (${relativePaths.length} files; complete local precache).`);
console.log(`Reviewed gzip budgets: ${gzipReport.join("; ")}.`);
