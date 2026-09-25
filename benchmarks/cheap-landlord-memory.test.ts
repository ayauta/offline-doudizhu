/**
 * What the CHEAP landlord table costs at runtime, measured in stages.
 *
 *     CHEAP_LANDLORD_BUILD=1 node --expose-gc node_modules/vitest/vitest.mjs run \
 *       --config vitest.benchmark.config.ts benchmarks/cheap-landlord-memory.test.ts
 *
 * The browser cannot answer this question here: `performance.memory` is not
 * exposed inside the Worker context in this Chromium build, so `worker.evaluate`
 * returns `null` and the model's own heap is unreadable from the page. §12 of
 * the integration protocol allows a process-level measurement with its caliber
 * stated instead, and this is that measurement.
 *
 * **Caliber**: Node's own `process.memoryUsage()`, after an explicit `gc()`.
 * `heapUsed` is V8's accounted heap; `external`/`arrayBuffers` cover the typed
 * arrays the tree evaluator actually walks. This is a *different runtime* from
 * a browser Worker, and the numbers are not interchangeable with one — they
 * bound the parsed representation's cost, not the product's footprint.
 *
 * A note on the stages: `rss` is reported but never used for a delta. RSS is
 * what the allocator got from the OS and it does not shrink when V8 collects,
 * so a difference between stages is mostly arena reuse. The deltas quoted in
 * the report are on `heapUsed + arrayBuffers`, which do track live data.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel, type TreeModel } from "../src/core/ai/cf-model.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import type { PlayingPlayerView } from "../src/core/ai/index.js";
import { decideEnhancedAi } from "../src/app/ai/decision-handler.js";
import { CHEAP_LANDLORD_MODEL_JSON } from "../src/app/ai/cheap-landlord-model.js";
import { cheapLandlordDecision } from "../src/app/ai/cheap-landlord.js";
import { createPi1Bundle, roleOfSeat, type MixtureSpec, type PolicyBundle } from "./selfplay-policy.js";
import { collectEpisode, type CollectorConfig } from "./selfplay-collector.js";

const ENABLED = process.env.AI_CHEAP_INTEGRATION === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODEL_PATH = join(ROOT, ".local/selfplay-reh/CHEAP/train-input/landlord.model.json");
const CHEAP_SHA256 = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";
const OUT = join(ROOT, ".local", "cheap-integration");

interface Usage {
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

function usage(): Usage {
  const value = process.memoryUsage();
  return {
    rss: value.rss,
    heapUsed: value.heapUsed,
    external: value.external,
    arrayBuffers: value.arrayBuffers ?? 0,
  };
}

/** The quantity that tracks live data, as opposed to allocator arenas. */
const live = (value: Usage): number => value.heapUsed + value.arrayBuffers;

function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc !== undefined) {
    gc();
    gc();
  }
}

const mb = (bytes: number): number => bytes / 1048576;

describe.skipIf(!ENABLED)("CHEAP landlord runtime memory", () => {
  it("separates the parse cost from the retained cost", async () => {
    const report: Record<string, unknown> = {};
    const hasGc = (globalThis as { gc?: () => void }).gc !== undefined;

    collect();
    const baseline = usage();

    const bytes = readFileSync(MODEL_PATH);
    collect();
    const afterRead = usage();

    const text = bytes.toString("utf8");
    collect();
    const afterDecode = usage();

    const raw = JSON.parse(text) as { numFeatures: number };
    collect();
    const afterJsonParse = usage();

    const model: TreeModel = parseTreeModel(raw);
    collect();
    const afterTreeParse = usage();

    // Steady state: real landlord decisions through the product handler, so the
    // retained figure includes anything the scoring path caches.
    const config: CollectorConfig = (() => {
      const bundles = new Map<string, PolicyBundle>([["PI1", createPi1Bundle("master")]]);
      const mixture: MixtureSpec = Object.freeze({
        version: "fas-mixture-v1",
        current: "PI1",
        history: Object.freeze([]),
        weights: Object.freeze({ current: 1, sharedHistory: 0, independentHistory: 0 }),
      });
      return Object.freeze({
        bundles, learningBundleId: "PI1", mixture, epsilon: 0,
        explorationSalt: 0, mixtureSalt: 0, auditProposal: false,
      });
    })();

    let decisions = 0;
    for (let offset = 0; offset < 12; offset += 1) {
      const episode = collectEpisode(config, 915_001 + offset, "L");
      for (const record of episode.records) {
        const view: PlayingPlayerView = record.view;
        if (roleOfSeat(view.seat, view.landlord) !== "landlord") {
          continue;
        }
        const context = Object.freeze({
          kind: "play" as const,
          view,
          legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
        });
        decideEnhancedAi(
          { requestId: 1, aiType: "master", context, seed: 1, cheapLandlord: true },
          {
            deadline: Number.MAX_SAFE_INTEGER,
            now: () => 0,
            landlord: {
              modelSha256: CHEAP_SHA256,
              decide: (context: Parameters<typeof cheapLandlordDecision>[0]) =>
                cheapLandlordDecision(context, { model, modelSha256: CHEAP_SHA256 }),
            },
          },
        );
        decisions += 1;
      }
    }
    collect();
    const afterDecisions = usage();

    const stages = {
      baseline,
      afterRead,
      afterDecode,
      afterJsonParse,
      afterTreeParse,
      afterDecisions,
    };
    report.gcAvailable = hasGc;
    report.decisionsRun = decisions;
    report.modelRawBytes = bytes.length;
    report.stages = Object.fromEntries(
      Object.entries(stages).map(([name, value]) => [
        name,
        { rss: value.rss, heapUsed: value.heapUsed, arrayBuffers: value.arrayBuffers, live: live(value) },
      ]),
    );
    report.liveDeltaBytes = {
      decodeOverRead: live(afterDecode) - live(afterRead),
      jsonParseOverDecode: live(afterJsonParse) - live(afterDecode),
      treeParseOverJson: live(afterTreeParse) - live(afterJsonParse),
      retainedAfterDecisions: live(afterDecisions) - live(baseline),
      peakObserved: Math.max(...Object.values(stages).map(live)) - live(baseline),
    };

    const d = report.liveDeltaBytes as Record<string, number>;
    console.log(`[clm-mem] gc ${hasGc ? "forced" : "UNAVAILABLE (numbers are noisy)"}, ${decisions} decisions`);
    console.log(`[clm-mem] model raw ${bytes.length} B (${mb(bytes.length).toFixed(2)} MB)`);
    console.log(`[clm-mem] read->decode   ${mb(d.decodeOverRead!).toFixed(2)} MB`);
    console.log(`[clm-mem] decode->json   ${mb(d.jsonParseOverDecode!).toFixed(2)} MB`);
    console.log(`[clm-mem] json->tree     ${mb(d.treeParseOverJson!).toFixed(2)} MB`);
    console.log(`[clm-mem] peak over base ${mb(d.peakObserved!).toFixed(2)} MB`);
    console.log(`[clm-mem] retained steady ${mb(d.retainedAfterDecisions!).toFixed(2)} MB`);
    console.log(
      `[clm-mem] rss baseline ${mb(baseline.rss).toFixed(2)} MB -> steady ${mb(afterDecisions.rss).toFixed(2)} MB`,
    );

    if (CHEAP_LANDLORD_MODEL_JSON !== null) {
      const digest = createHash("sha256")
        .update(Buffer.from(CHEAP_LANDLORD_MODEL_JSON, "utf8"))
        .digest("hex");
      expect(digest).toBe(CHEAP_SHA256);
    }
    expect(decisions).toBeGreaterThan(0);

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "memory.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  });
});
