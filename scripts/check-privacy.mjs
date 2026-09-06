import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function runGit(args) {
  return spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}

async function walkIfPresent(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walkIfPresent(path));
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
    return files;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

const candidateResult = runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
if (candidateResult.status !== 0) {
  throw new Error(candidateResult.stderr || "Unable to inspect Git candidate files.");
}

const violations = [];
const candidatePaths = candidateResult.stdout.split("\0").filter(Boolean);
const sensitivePaths = [
  ["private local directory", /(^|\/)\.local\//],
  ["environment file", /(^|\/)\.env(?:\.|$)/],
  ["private key, certificate, or keystore", /\.(?:pem|key|p12|pfx|keystore|jks)$/i],
  ["release-signing recovery file", /(^|\/)[^/]*-release-recovery\.json$/i],
  ["browser test artifact", /(^|\/)(?:test-results|playwright-report)\//],
  ["generated output", /(^|\/)dist\//],
];
for (const path of candidatePaths) {
  for (const [label, pattern] of sensitivePaths) {
    if (pattern.test(path)) {
      violations.push(`${path}: ${label} must not be committed`);
    }
  }
}

for (const sentinel of [
  ".local/toolchains/example",
  ".env",
  ".env.local",
  "secret.pem",
  "secret.key",
  "signing.keystore",
  "signing.jks",
  "offline-doudizhu-release-recovery.json",
  "dist/index.html",
  "test-results/result.json",
  "playwright-report/index.html",
]) {
  if (runGit(["check-ignore", "--quiet", "--", sentinel]).status !== 0) {
    violations.push(`${sentinel}: expected .gitignore protection is missing`);
  }
}

const runtimeFiles = [
  join(repositoryRoot, "index.html"),
  ...(await walkIfPresent(join(repositoryRoot, "src"))),
  ...(await walkIfPresent(join(repositoryRoot, "public"))),
  ...(await walkIfPresent(join(repositoryRoot, "dist"))),
].filter((path) => new Set([".css", ".html", ".js", ".json", ".svg", ".ts", ".tsx", ".webmanifest"]).has(extname(path)));

const secrets = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["common access token", /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
];
const requestCapability = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|\bsendBeacon\b/;

for (const path of runtimeFiles) {
  const displayPath = relative(repositoryRoot, path).replaceAll("\\", "/");
  const contents = await readFile(path, "utf8");
  for (const [label, pattern] of secrets) {
    if (pattern.test(contents)) {
      violations.push(`${displayPath}: contains ${label}`);
    }
  }

  const isGeneratedWorker = /^dist\/(?:sw|workbox-[^/]+)\.js$/.test(displayPath);
  if (!isGeneratedWorker && requestCapability.test(contents)) {
    violations.push(`${displayPath}: contains forbidden application network capability`);
  }

  const withoutDomNamespaces = contents
    .replaceAll("http://www.w3.org/2000/svg", "")
    .replaceAll("http://www.w3.org/1998/Math/MathML", "")
    .replaceAll("http://www.w3.org/1999/xhtml", "");
  if (!isGeneratedWorker && /https?:\/\//.test(withoutDomNamespaces)) {
    violations.push(`${displayPath}: contains a remote runtime URL`);
  }
}

const workerPath = join(repositoryRoot, "dist", "sw.js");
try {
  const worker = await readFile(workerPath, "utf8");
  if (/url\s*:\s*["'](?:https?:)?\/\//.test(worker)) {
    violations.push("dist/sw.js: contains an external precache URL");
  }
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

if (violations.length > 0) {
  console.error("Privacy check failed:");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log(`Privacy check passed (${runtimeFiles.length} runtime files scanned).`);
}
