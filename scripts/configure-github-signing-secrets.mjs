import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [directoryArgument, repository = "ayauta/offline-doudizhu"] = process.argv.slice(2);
if (directoryArgument === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error(
    "Usage: node scripts/configure-github-signing-secrets.mjs <signing-directory> [owner/repository]",
  );
}

const directory = resolve(directoryArgument);
const keystore = await readFile(join(directory, "offline-doudizhu-release.p12"));
const recovery = JSON.parse(
  await readFile(join(directory, "offline-doudizhu-release-recovery.json"), "utf8"),
);
if (recovery.project !== repository || recovery.keystoreFile !== "offline-doudizhu-release.p12") {
  throw new Error("Recovery metadata does not match the requested repository and keystore.");
}

const javaHome = process.env.JAVA_HOME;
const keytool = javaHome === undefined ? "keytool" : join(javaHome, "bin", "keytool");
const certificate = spawnSync(
  keytool,
  [
    "-list",
    "-v",
    "-keystore",
    join(directory, recovery.keystoreFile),
    "-storetype",
    recovery.keystoreType,
    "-alias",
    recovery.keyAlias,
  ],
  {
    encoding: "utf8",
    input: `${recovery.storePassword}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
if (certificate.error !== undefined) {
  throw certificate.error;
}
if (certificate.status !== 0) {
  throw new Error(`The local signing identity could not be verified: ${certificate.stderr}`);
}
const actualFingerprint = certificate.stdout.match(/SHA256:\s*([0-9A-F:]+)/)?.[1];
if (actualFingerprint !== recovery.certificateSha256) {
  throw new Error("The keystore certificate does not match the recovery fingerprint.");
}

const secretValues = new Map([
  ["OFFLINE_DDZ_KEYSTORE_BASE64", keystore.toString("base64")],
  ["OFFLINE_DDZ_KEYSTORE_PASSWORD", recovery.storePassword],
  ["OFFLINE_DDZ_KEY_ALIAS", recovery.keyAlias],
  ["OFFLINE_DDZ_KEY_PASSWORD", recovery.keyPassword],
]);

for (const [name, value] of secretValues) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Recovery data is missing ${name}.`);
  }
  const result = spawnSync("gh", ["secret", "set", name, "--repo", repository], {
    encoding: "utf8",
    input: value,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`gh secret set ${name} failed: ${result.stderr}`);
  }
  console.log(`Configured ${name}.`);
}

console.log(`Configured all Android signing secrets for ${repository}; no secret values were printed.`);
