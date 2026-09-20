/**
 * Real Worker round-trip timing for the counterfactual farmer selector.
 *
 * Skipped unless `AI_CF_TIMING=1`, because it plays real matches at real
 * product cadence and takes minutes.
 *
 *   AI_CF_TIMING=1 AI_CF_ARM=baseline   AI_CF_DEALS=18 \
 *     AI_CF_TIMING_OUT=.local/timing-baseline.json npx playwright test ai-worker-timing
 *
 * The instrumentation is entirely outside the application: `Worker` is wrapped
 * in the page before any app code loads, so a request is timed from
 * `postMessage` to the matching `message` event and the product's own code is
 * untouched. There is no test hook in `src/`, nothing to switch off, and
 * therefore nothing whose on/off behaviour could diverge.
 *
 * Both arms run the same deterministic workload — same seeds, same settings
 * apart from the one flag — so the difference between them is the overlay.
 */
import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const ENABLED = process.env.AI_CF_TIMING === "1";
const ARM = process.env.AI_CF_ARM === "challenger" ? "challenger" : "baseline";
const DEALS = Math.max(1, Number.parseInt(process.env.AI_CF_DEALS ?? "18", 10));
const OUT = process.env.AI_CF_TIMING_OUT;

type TimingRecord = {
  sentAt: number;
  receivedAt: number;
  ok: boolean;
  reason: string | null;
  aiType: string | null;
  flag: boolean;
  /** Whether the acting seat was a farmer, which is where the overlay may act. */
  farmer: boolean | null;
};

test.skip(!ENABLED, "set AI_CF_TIMING=1 to measure Worker round trips");

test(`measures Worker round trips (${ARM})`, async ({ page }) => {
  test.setTimeout(45 * 60 * 1000);
  await page.setViewportSize({ width: 900, height: 400 });

  // Deterministic seeds for both the deal and the AI's rollout sampling, so the
  // two arms see the same games and the only difference is the overlay.
  await page.addInitScript(() => {
    let state = 20_260_921 >>> 0;
    const prototype = Crypto.prototype as unknown as {
      getRandomValues(array: Uint32Array): Uint32Array;
    };
    prototype.getRandomValues = function (array: Uint32Array): Uint32Array {
      for (let index = 0; index < array.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        array[index] = state;
      }
      return array;
    };
  });

  await page.addInitScript((challenger: boolean) => {
    window.localStorage.setItem(
      "offline-doudizhu.settings",
      JSON.stringify({
        schemaVersion: 1,
        data: { aiType: "master", counterfactualFarmer: challenger },
      }),
    );
    const scope = globalThis as unknown as { __aiTiming?: unknown };
    const sink = {
      workerCreatedAt: null as number | null,
      records: [] as TimingRecord[],
      malformed: 0,
      sent: 0,
      received: 0,
      flagged: 0,
      farmerSeated: 0,
    };
    scope.__aiTiming = sink;
    const Original = window.Worker;
    // Test-only subclass. The application's own code is not modified, and
    // nothing here reads or influences a decision.
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (sink.workerCreatedAt === null) {
          sink.workerCreatedAt = performance.now();
        }
        const inFlight = new Map<number, {
          at: number;
          aiType: string | null;
          flag: boolean;
          farmer: boolean | null;
        }>();
        const post = this.postMessage.bind(this);
        this.postMessage = ((message: unknown, transfer?: Transferable[]) => {
          const record = message as { requestId?: unknown; aiType?: unknown } | null;
          if (record !== null && typeof record?.requestId === "number") {
            const flagged = (record as { counterfactualFarmer?: unknown }).counterfactualFarmer === true;
            // Read straight off the posted context, so the split needs no
            // product hook: this is the same redacted view the Worker got.
            const view = (record as {
              context?: { view?: { seat?: unknown; landlord?: unknown } };
            }).context?.view;
            const farmer = typeof view?.seat === "string" && typeof view?.landlord === "string"
              ? view.seat !== view.landlord
              : null;
            inFlight.set(record.requestId, {
              at: performance.now(),
              aiType: typeof record.aiType === "string" ? record.aiType : null,
              flag: flagged,
              farmer,
            });
            sink.sent += 1;
            if (flagged) sink.flagged += 1;
            if (farmer === true) sink.farmerSeated += 1;
          }
          return transfer === undefined ? post(message) : post(message, transfer);
        }) as Worker["postMessage"];
        this.addEventListener("message", (event: MessageEvent) => {
          const response = event.data as {
            requestId?: unknown;
            outcome?: { ok?: unknown; reason?: unknown };
          } | null;
          const id = response?.requestId;
          if (response === null || typeof id !== "number") {
            sink.malformed += 1;
            return;
          }
          const started = inFlight.get(id);
          inFlight.delete(id);
          sink.received += 1;
          sink.records.push({
            sentAt: started?.at ?? Number.NaN,
            receivedAt: performance.now(),
            ok: response.outcome?.ok === true,
            reason: typeof response.outcome?.reason === "string" ? response.outcome.reason : null,
            aiType: started?.aiType ?? null,
            flag: started?.flag ?? false,
            farmer: started?.farmer ?? null,
          });
        });
      }
    };
  }, ARM === "challenger");

  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();

  const result = page.getByRole("heading", { name: /胜利|失败/ });
  const hint = page.getByRole("button", { name: "提示" });
  const play = page.getByRole("button", { name: "出牌" });
  const pass = page.getByRole("button", { name: "不出" });
  // Both bid controls render together, so the human calls landlord every deal.
  // That is deliberate: it seats both AI players as farmers, which is the role
  // the selector is allowed to act in, so a deal yields roughly twice the
  // selector-relevant decisions a mixed seating would.
  const call = page.getByRole("button", { name: "叫地主" });

  for (let deal = 0; deal < DEALS; deal += 1) {
    await expect(call).toBeVisible({ timeout: 15_000 });
    await call.click();

    let settled = false;
    for (let step = 0; step < 900; step += 1) {
      if (await result.isVisible()) {
        settled = true;
        break;
      }
      if (await hint.isVisible()) {
        await hint.click();
        await play.click();
      } else if (await pass.isVisible()) {
        await pass.click();
      }
      await page.waitForTimeout(100);
    }
    expect(settled, `deal ${deal} did not finish`).toBe(true);
    if (deal < DEALS - 1) {
      await page.getByRole("button", { name: "再来一局" }).click();
    }
  }

  const sink = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      __aiTiming?: {
        workerCreatedAt: number | null;
        records: TimingRecord[];
        malformed: number;
        sent: number;
        received: number;
        flagged: number;
        farmerSeated: number;
      };
    };
    return scope.__aiTiming ?? null;
  });
  expect(sink, "timing sink was not installed").not.toBeNull();
  expect(sink!.records.length).toBeGreaterThan(0);

  if (OUT !== undefined && OUT !== "") {
    writeFileSync(OUT, `${JSON.stringify({ arm: ARM, deals: DEALS, sink }, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(
    `[${ARM}] deals ${DEALS} sent ${sink!.sent} received ${sink!.received} ` +
    `flagged ${sink!.flagged} malformed ${sink!.malformed} ` +
    `coldStart ${sink!.workerCreatedAt?.toFixed(1) ?? "n/a"}ms`,
  );
});
