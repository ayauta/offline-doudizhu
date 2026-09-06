import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

function fail(message) {
  console.error(`Release tag check failed: ${message}`);
  process.exit(1);
}

if (tag === undefined || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  fail(`expected a vMAJOR.MINOR.PATCH tag, received ${JSON.stringify(tag)}`);
}

const packageConfig = JSON.parse(
  await readFile(new URL("package.json", `file://${repositoryRoot}/`), "utf8"),
);
const androidBuild = await readFile(
  new URL("android/app/build.gradle.kts", `file://${repositoryRoot}/`),
  "utf8",
);
const versionName = androidBuild.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
const versionCode = Number(androidBuild.match(/versionCode\s*=\s*(\d+)/)?.[1]);

if (packageConfig.version !== tag.slice(1)) {
  fail(`package.json version ${packageConfig.version} does not match ${tag}`);
}
if (versionName !== packageConfig.version) {
  fail(`Android versionName ${versionName} does not match ${packageConfig.version}`);
}
if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
  fail(`Android versionCode must be a positive integer, received ${versionCode}`);
}

console.log(`Release tag ${tag} matches Web ${packageConfig.version} and Android code ${versionCode}.`);
