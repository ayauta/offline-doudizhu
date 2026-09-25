#!/usr/bin/env node
/**
 * Switch `src/app/ai/cheap-landlord-model.ts` between its two states.
 *
 *     node scripts/cheap-landlord-embed.mjs            # write the frozen table (default)
 *     node scripts/cheap-landlord-embed.mjs --stub     # write the empty stub
 *
 * The default is the **embedded** table, because the release candidate has to
 * be a build that actually packages the confirmed model: a green `pnpm build`
 * against a stubbed table would prove nothing about what ships. `--stub` exists
 * only to reproduce the pre-integration baseline for a size measurement, and
 * `scripts/cheap-landlord-run.mjs` still wraps a command so a measurement
 * cannot leave the stub behind in a tracked file.
 *
 * The file is **tracked**, and this script owns it. That is deliberate, and it
 * is the third design tried:
 *
 *   - A `resolve.alias` entry never fired. Aliases are matched against the
 *     specifier as written, and the Worker imports the module relatively.
 *   - A `resolveId` plugin never fired either: rolldown resolves a relative
 *     specifier before consulting user hooks. It looked like it worked, because
 *     the harness and the build failed in different ways and only one of them
 *     was checked at a time. The prototype build came out byte-identical to the
 *     default build, which is how the second failure was caught.
 *
 * Overwriting the file needs no bundler cooperation, so the same bytes reach
 * the Worker, the harness and `vitest` or `vite` alike. The cost is that the
 * prototype state shows up as a modified tracked file — which is the honest
 * representation of what it is, and `cheap-landlord-run.mjs` restores it in a
 * `finally` so a crash cannot leave it behind.
 *
 * Nothing here trains, quantizes or rewrites the model: the JSON is copied byte
 * for byte from the confirmed artifact, and the script refuses to write it
 * unless the digest is the confirmed one.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "src/app/ai/cheap-landlord-model.ts");

/** Frozen by the joint dual-environment confirmation. */
export const EXPECTED_SHA256 = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";

const SOURCE = join(ROOT, ".local/selfplay-reh/CHEAP/train-input/landlord.model.json");

const HEADER = `/**
 * The CHEAP landlord model, as the shipped Worker sees it.
 *
 * **Generated. Do not edit.** \`scripts/cheap-landlord-embed.mjs\` owns this file
 * and switches it between two states:
 *
 *   - **embedded** (default): the frozen 2.0 MB table, byte for byte as the
 *     joint dual-environment confirmation measured it. This is what ships.
 *   - **stub** (\`--stub\`): the table is \`null\`, so the landlord branch is
 *     never installed. It exists only for measurement — the pre-integration
 *     build size is taken with it — and never for a release.
 *
 * The digest is not a placeholder in either state. It is the value the joint
 * dual-environment confirmation froze, and the Worker refuses a table that does
 * not hash to it, so "the model failed to load" and "the model was never
 * shipped" stay distinguishable in a trace instead of both reading as a silent
 * fallback.
 */

export const CHEAP_LANDLORD_MODEL_SHA256 =
  "${EXPECTED_SHA256}";

export const CHEAP_LANDLORD_MODEL_JSON: string | null = null;
`;

function writeStub() {
  writeFileSync(TARGET, HEADER);
  console.log(`restored the stub at ${TARGET}`);
}

function writeEmbedded() {
  const bytes = readFileSync(SOURCE);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== EXPECTED_SHA256) {
    console.error(
      `Refusing to embed: ${SOURCE} hashes to ${digest}, not the confirmed ${EXPECTED_SHA256}.`,
    );
    process.exit(1);
  }
  // Parse before writing so a malformed table fails here, where the message can
  // say so, rather than inside the Worker where it would look like a policy
  // that declined.
  const model = JSON.parse(bytes.toString("utf8"));
  if (model.numFeatures !== 403) {
    console.error(`Refusing to embed: the model declares ${model.numFeatures} features, not 403.`);
    process.exit(1);
  }
  const body = HEADER.replace(
    "export const CHEAP_LANDLORD_MODEL_JSON: string | null = null;",
    `export const CHEAP_LANDLORD_MODEL_JSON: string | null =\n  ${JSON.stringify(bytes.toString("utf8"))};`,
  );
  writeFileSync(TARGET, body);
  console.log(
    `embedded ${bytes.length} raw bytes (${model.numTrees} trees, ${model.numFeatures} features) into ${TARGET}`,
  );
}

if (process.argv.includes("--stub")) {
  writeStub();
} else {
  writeEmbedded();
}
