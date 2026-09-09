import { chmod, writeFile } from "node:fs/promises";

const outputPath = process.argv[2];
const encodedKeystore = process.env.OFFLINE_DDZ_KEYSTORE_BASE64;
const requiredCredentials = [
  "OFFLINE_DDZ_KEYSTORE_PASSWORD",
  "OFFLINE_DDZ_KEY_ALIAS",
  "OFFLINE_DDZ_KEY_PASSWORD",
];

if (outputPath === undefined) {
  throw new Error("Usage: node scripts/restore-release-keystore.mjs <output-path>");
}
if (encodedKeystore === undefined || encodedKeystore.trim() === "") {
  throw new Error("OFFLINE_DDZ_KEYSTORE_BASE64 is required.");
}
for (const name of requiredCredentials) {
  if (process.env[name] === undefined || process.env[name] === "") {
    throw new Error(`${name} is required.`);
  }
}

const normalized = encodedKeystore.replaceAll(/\s/g, "");
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
  throw new Error("OFFLINE_DDZ_KEYSTORE_BASE64 is not valid base64 text.");
}
const bytes = Buffer.from(normalized, "base64");
if (bytes.byteLength < 256) {
  throw new Error("Decoded release keystore is unexpectedly small.");
}

await writeFile(outputPath, bytes, { mode: 0o600 });
await chmod(outputPath, 0o600);
console.log("Release keystore restored to the private runner temporary directory.");
