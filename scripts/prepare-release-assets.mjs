import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

const [tag, sourceApk, outputDirectory] = process.argv.slice(2);
if (tag === undefined || sourceApk === undefined || outputDirectory === undefined) {
  throw new Error("Usage: node scripts/prepare-release-assets.mjs <tag> <apk> <output-directory>");
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Unexpected release tag: ${tag}`);
}

await mkdir(outputDirectory, { recursive: true });
const apkName = `offline-doudizhu-${tag}-android.apk`;
const apkDestination = join(outputDirectory, apkName);
await copyFile(sourceApk, apkDestination);
const digest = createHash("sha256").update(await readFile(apkDestination)).digest("hex");
const checksumName = `${apkName}.sha256`;
await writeFile(join(outputDirectory, checksumName), `${digest}  ${basename(apkDestination)}\n`, "utf8");
console.log(`Prepared ${apkName} and ${checksumName}.`);
