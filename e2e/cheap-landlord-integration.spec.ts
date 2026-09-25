/**
 * The CHEAP landlord integration prototype, measured in the real browser.
 *
 * Skipped unless `CHEAP_LANDLORD_E2E=1`, because it plays real matches at real
 * product cadence and takes minutes.
 *
 *   CHEAP_LANDLORD_E2E=1 CHEAP_LANDLORD_E2E_ARM=prototype \
 *   CHEAP_LANDLORD_E2E_OUT=.local/cl-e2e-prototype.json \
 *     npx playwright test cheap-landlord-integration
 *
 * Two things separate this from `ai-worker-timing.spec.ts`, and both matter:
 *
 *   - **The human declines the bid, so an AI takes the landlord seat.** The
 *     farmer spec calls landlord every deal on purpose, because that is the
 *     only seat its overlay may act in. This one needs the opposite seating:
 *     the whole point is what the landlord does.
 *   - **The prototype flag is injected at the transport, not read from
 *     settings.** The wrapper adds `cheapLandlord: true` to each outgoing
 *     request. Nothing in `src/app/settings` or `src/app/session` was changed
 *     to make this runnable, so the only product surface under measurement is
 *     the Worker's own handling of the flag. Enabling it from a user-facing
 *     setting is a separate decision, and this file is careful not to pretend
 *     otherwise.
 *
 * The instrumentation is still entirely outside the application, exactly as in
 * the farmer spec: `Worker` is wrapped before any app code loads, and there is
 * no test hook in `src/`.
 */
import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const ENABLED = process.env.CHEAP_LANDLORD_E2E === "1";
const ARM = process.env.CHEAP_LANDLORD_E2E_ARM === "baseline" ? "baseline" : "prototype";
const DEALS = Math.max(1, Number.parseInt(process.env.CHEAP_LANDLORD_E2E_DEALS ?? "6", 10));
const OUT = process.env.CHEAP_LANDLORD_E2E_OUT;

type RoundTrip = {
  sentAt: number;
  receivedAt: number;
  ok: boolean;
  aiType: string | null;
  landlord: boolean | null;
  injected: boolean;
};

/** Precise `performance.memory` inside the page and inside the Worker. */
test.use({ launchOptions: { args: ["--enable-precise-memory-info"] } });

test.skip(!ENABLED, "set CHEAP_LANDLORD_E2E=1 to measure the landlord prototype");

test(`landlord prototype round trips (${ARM})`, async ({ page }) => {
  test.setTimeout(45 * 60 * 1000);
  await page.setViewportSize({ width: 900, height: 400 });

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

  await page.addInitScript((injectForLandlord: boolean) => {
    window.localStorage.setItem(
      "offline-doudizhu.settings",
      JSON.stringify({
        schemaVersion: 1,
        data: { aiType: "master", counterfactualFarmer: false },
      }),
    );
    const scope = globalThis as unknown as { __clTiming?: unknown };
    const sink = {
      workerCreatedAt: null as number | null,
      records: [] as RoundTrip[],
      malformed: 0,
      sent: 0,
      injectedCount: 0,
      landlordSeated: 0,
      injectFlag: injectForLandlord,
      errors: [] as string[],
      firstRequestKeys: null as string[] | null,
    };
    scope.__clTiming = sink;
    const Original = window.Worker;
    // Test-only subclass. The application's own code is not modified.
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (sink.workerCreatedAt === null) {
          sink.workerCreatedAt = performance.now();
        }
        const inFlight = new Map<number, { at: number; aiType: string | null; landlord: boolean | null }>();
        this.addEventListener("error", (event: ErrorEvent) => {
          sink.errors.push(String(event.message ?? "worker error"));
        });
        this.addEventListener("messageerror", () => {
          sink.errors.push("messageerror");
        });
        const post = this.postMessage.bind(this);
        /*
         * The outgoing message is rebuilt, never mutated.
         *
         * `ai-worker-client.ts` posts an `Object.freeze`d request, and this
         * class body is strict mode, so `record.cheapLandlord = true` throws
         * "Cannot add property … object is not extensible". The throw escapes
         * into the client's own try/catch, which reads it as a failed turn: the
         * run reported zero responses and looked like a broken model rather
         * than a broken harness. Spreading into a new object respects the
         * product's immutability instead of fighting it.
         */
        this.postMessage = ((message: unknown, transfer?: Transferable[]) => {
          let outgoing = message;
          const record = message as { requestId?: unknown; aiType?: unknown } | null;
          if (record !== null && typeof record?.requestId === "number") {
            const view = (record as {
              context?: { view?: { seat?: unknown; landlord?: unknown } };
            }).context?.view;
            const landlord = typeof view?.seat === "string" && typeof view?.landlord === "string"
              ? view.seat === view.landlord
              : null;
            if (sink.firstRequestKeys === null) {
              sink.firstRequestKeys = Object.keys(record);
            }
            inFlight.set(record.requestId, {
              at: performance.now(),
              aiType: typeof record.aiType === "string" ? record.aiType : null,
              landlord,
            });
            sink.sent += 1;
            if (landlord === true) sink.landlordSeated += 1;
            if (injectForLandlord && record.aiType === "master") {
              // Master only, which is the scope the confirmation validated; a
              // `casual` request is left alone so the weaker product tier
              // cannot be changed by a measurement.
              outgoing = { ...(record as object), cheapLandlord: true };
              sink.injectedCount += 1;
            }
          }
          return transfer === undefined ? post(outgoing) : post(outgoing, transfer);
        }) as Worker["postMessage"];
        this.addEventListener("message", (event: MessageEvent) => {
          const response = event.data as {
            requestId?: unknown;
            outcome?: { ok?: unknown };
          } | null;
          const id = response?.requestId;
          if (response === null || typeof id !== "number") {
            sink.malformed += 1;
            return;
          }
          const started = inFlight.get(id);
          inFlight.delete(id);
          sink.records.push({
            sentAt: started?.at ?? Number.NaN,
            receivedAt: performance.now(),
            ok: response.outcome?.ok === true,
            aiType: started?.aiType ?? null,
            landlord: started?.landlord ?? null,
            injected: injectForLandlord && started?.aiType === "master",
          });
        });
      }
    };
  }, ARM === "prototype");

  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();

  const result = page.getByRole("heading", { name: /胜利|失败/ });
  const hint = page.getByRole("button", { name: "提示" });
  const play = page.getByRole("button", { name: "出牌" });
  const pass = page.getByRole("button", { name: "不出" });
  // Declining the bid is what seats an AI as the landlord. The deal is re-dealt
  // when everyone declines, so the loop simply tries again.
  const decline = page.getByRole("button", { name: "不叫" });

  for (let deal = 0; deal < DEALS; deal += 1) {
    await expect(decline).toBeVisible({ timeout: 15_000 });
    await decline.click();

    let settled = false;
    for (let step = 0; step < 900; step += 1) {
      if (await result.isVisible()) {
        settled = true;
        break;
      }
      if (await decline.isVisible()) {
        await decline.click();
      } else if (await hint.isVisible()) {
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

  const sink = (await page.evaluate(() => {
    const scope = globalThis as unknown as { __clTiming?: unknown };
    return scope.__clTiming ?? null;
  })) as {
    workerCreatedAt: number | null;
    records: RoundTrip[];
    malformed: number;
    sent: number;
    injectedCount: number;
    landlordSeated: number;
    injectFlag: boolean;
    errors: string[];
    firstRequestKeys: string[] | null;
  } | null;
  expect(sink, "timing sink was not installed").not.toBeNull();
  if (sink === null) {
    throw new Error("unreachable: the sink assertion above already failed");
  }

  // The Worker's own heap, read inside the Worker. `page.evaluate` would report
  // the main thread, which never parses the model at all.
  const workers = page.workers();
  const workerHeap = workers.length === 0
    ? null
    : await workers[0]!.evaluate(() => {
        const memory = (performance as unknown as {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
        }).memory;
        return memory === undefined
          ? null
          : {
              usedJSHeapSize: memory.usedJSHeapSize,
              totalJSHeapSize: memory.totalJSHeapSize,
              jsHeapSizeLimit: memory.jsHeapSizeLimit,
            };
      });
  const pageHeap = await page.evaluate(() => {
    const memory = (performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
    }).memory;
    return memory === undefined
      ? null
      : { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize };
  });

  const landlord = sink.records.filter((record) => record.landlord === true);
  const payload = {
    arm: ARM,
    deals: DEALS,
    workers: workers.length,
    workerCreatedAt: sink.workerCreatedAt,
    sent: sink.sent,
    received: sink.records.length,
    malformed: sink.malformed,
    injected: sink.injectedCount,
    landlordSeated: sink.landlordSeated,
    landlordRoundTrips: landlord.length,
    injectFlag: sink.injectFlag,
    errors: sink.errors,
    firstRequestKeys: sink.firstRequestKeys,
    workerHeap,
    pageHeap,
    records: sink.records,
  };
  if (OUT !== undefined && OUT !== "") {
    writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(
    `[cl-${ARM}] deals ${DEALS} sent ${sink.sent} received ${sink.records.length} ` +
      `landlord-seated ${sink.landlordSeated} injected ${sink.injectedCount} ` +
      `malformed ${sink.malformed} workers ${workers.length} ` +
      `workerHeap ${workerHeap === null ? "n/a" : (workerHeap.usedJSHeapSize / 1048576).toFixed(2) + "MB"}`,
  );
});
