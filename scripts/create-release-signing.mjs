import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const outputArgument = process.argv[2];
if (outputArgument === undefined || !isAbsolute(outputArgument)) {
  throw new Error("Usage: node scripts/create-release-signing.mjs <absolute-output-directory>");
}

const repositoryRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const outputDirectory = resolve(outputArgument);
const relativeToRepository = relative(repositoryRoot, outputDirectory);
const isOutsideRepository =
  relativeToRepository === ".." || relativeToRepository.startsWith(`..${sep}`);
if (!isOutsideRepository) {
  throw new Error("Release signing material must be generated outside the repository.");
}

const keystorePath = join(outputDirectory, "offline-doudizhu-release.p12");
const recoveryPath = join(outputDirectory, "offline-doudizhu-release-recovery.json");
for (const path of [keystorePath, recoveryPath]) {
  try {
    await stat(path);
    throw new Error(`Refusing to overwrite existing signing material: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

const javaHome = process.env.JAVA_HOME;
const keytool = javaHome === undefined ? "keytool" : join(javaHome, "bin", "keytool");
const password = randomBytes(32).toString("base64url");
const alias = "offline-doudizhu";

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);

const generate = spawnSync(
  keytool,
  [
    "-genkeypair",
    "-keystore",
    keystorePath,
    "-storetype",
    "PKCS12",
    "-alias",
    alias,
    "-keyalg",
    "RSA",
    "-keysize",
    "4096",
    "-sigalg",
    "SHA256withRSA",
    "-validity",
    "36500",
    "-dname",
    "CN=offline-doudizhu, OU=Release, O=ayauta",
  ],
  {
    encoding: "utf8",
    input: `${password}\n${password}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
if (generate.error !== undefined) {
  await unlink(keystorePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  throw generate.error;
}
if (generate.status !== 0) {
  await unlink(keystorePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  throw new Error(`keytool failed without creating a signing identity: ${generate.stderr}`);
}
await chmod(keystorePath, 0o600);

const certificate = spawnSync(
  keytool,
  ["-list", "-v", "-keystore", keystorePath, "-storetype", "PKCS12", "-alias", alias],
  {
    encoding: "utf8",
    input: `${password}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
if (certificate.error !== undefined) {
  throw certificate.error;
}
if (certificate.status !== 0) {
  throw new Error(`keytool could not verify the generated signing identity: ${certificate.stderr}`);
}
const fingerprint = certificate.stdout.match(/SHA256:\s*([0-9A-F:]+)/)?.[1];
if (fingerprint === undefined) {
  throw new Error("Could not read the generated certificate SHA-256 fingerprint.");
}

const recovery = {
  format: 1,
  project: "ayauta/offline-doudizhu",
  keystoreFile: "offline-doudizhu-release.p12",
  keystoreType: "PKCS12",
  storePassword: password,
  keyAlias: alias,
  keyPassword: password,
  certificateSha256: fingerprint,
};
await writeFile(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, { mode: 0o600 });
await chmod(recoveryPath, 0o600);

const generatedBytes = await readFile(keystorePath);
if (generatedBytes.byteLength < 1_000) {
  throw new Error("Generated keystore is unexpectedly small.");
}

console.log(`Created a long-lived signing identity in ${outputDirectory}.`);
console.log(`Certificate SHA-256: ${fingerprint}`);
console.log("The password was written only to the mode-0600 recovery JSON and was not printed.");
