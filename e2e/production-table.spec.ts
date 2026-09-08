import { expect, test, type Locator, type Page } from "@playwright/test";

async function exposedPoint(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Expected a visible card bounding box.");
  }
  return { x: box.x + 5, y: box.y + box.height * 0.58 };
}

async function swipeAcross(page: Page, cards: readonly Locator[]) {
  const points = await Promise.all(cards.map(exposedPoint));
  const first = points[0];
  if (first === undefined) {
    throw new Error("A swipe requires at least one card.");
  }
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 4 });
  }
  await page.mouse.up();
}

async function swipeInOneMove(page: Page, first: Locator, last: Locator) {
  const [firstPoint, lastPoint] = await Promise.all([
    exposedPoint(first),
    exposedPoint(last),
  ]);
  await page.mouse.move(firstPoint.x, firstPoint.y);
  await page.mouse.down();
  await page.mouse.move(lastPoint.x, lastPoint.y);
  await page.mouse.up();
}

async function useDeterministicRandom(page: Page, seed = 2_026_090_4) {
  await page.addInitScript((initialSeed) => {
    let state = initialSeed >>> 0;
    const cryptoPrototype = Crypto.prototype as unknown as {
      getRandomValues(array: Uint32Array): Uint32Array;
    };
    cryptoPrototype.getRandomValues = function (array: Uint32Array): Uint32Array {
      for (let index = 0; index < array.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        array[index] = state;
      }
      return array;
    };
  }, seed);
}

async function useIdentityDeck(page: Page) {
  await page.addInitScript(() => {
    const cryptoPrototype = Crypto.prototype as unknown as {
      getRandomValues(array: Uint32Array): Uint32Array;
    };
    cryptoPrototype.getRandomValues = function (array: Uint32Array): Uint32Array {
      array.fill(0xffff_ffff);
      return array;
    };
  });
}

// Specify a legal deal through the existing randomness boundary, without adding
// production test hooks or exposing the AI hands in the application DOM.
async function useSeatHand(
  page: Page,
  seatCards: readonly number[],
  seatIndex = 0,
) {
  const rest = Array.from({ length: 54 }, (_, id) => id).filter(
    (id) => !seatCards.includes(id),
  );
  const hand = [...seatCards, ...rest.splice(0, 20 - seatCards.length)];
  const deck = Array.from({ length: 51 }, (_, index) =>
    index % 3 === seatIndex ? hand[Math.floor(index / 3)]! : rest.shift()!,
  );
  deck.push(...hand.slice(17));
  const working = Array.from({ length: 54 }, (_, id) => id);
  const samples: number[] = [];
  for (let index = 53; index > 0; index -= 1) {
    const swap = working.indexOf(deck[index]!);
    samples.push(Math.floor(((swap + 0.5) / (index + 1)) * 0x1_0000_0000));
    [working[index], working[swap]] = [working[swap]!, working[index]!];
  }
  await page.addInitScript((values) => {
    let index = 0;
    Crypto.prototype.getRandomValues = function<T extends ArrayBufferView | null>(
      array: T,
    ): T {
      if (array instanceof Uint32Array) {
        array.fill(values[index++] ?? 0xffff_ffff);
      }
      return array;
    };
  }, samples);
}

test("keeps a long AI winning play readable beside the result", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 640, height: 340 });
  const core = Array.from({ length: 4 }, (_, rank) => [
    (rank + 6) * 4,
    (rank + 6) * 4 + 1,
    (rank + 6) * 4 + 2,
  ]).flat();
  const highPairs = [40, 41, 44, 45];
  const ids = [...core, ...highPairs, 48, 49, 20, 21];
  // The right AI sees the core, both high pairs and one 2 before bidding,
  // which reaches its normal call threshold. Its three bottom cards complete
  // a legal four-triple airplane with four pair wings.
  await useSeatHand(page, ids, 1);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "不叫", exact: true }).click();
  for (let step = 0; step < 8; step += 1) {
    await page.clock.fastForward(700);
  }
  await expect(
    page.getByRole("heading", { name: "失败", exact: true }),
  ).toBeVisible();
  const cards = page.locator(".opponent-seat--right .table-card");
  await expect(cards).toHaveCount(20);
  const covered = await cards.evaluateAll((elements) => elements.flatMap((card) =>
    Array.from(card.querySelectorAll("strong, .suit-mark")).flatMap((mark) => {
      const box = mark.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const coveringCard = hit?.closest(".table-card");
      const cardLabel = card.getAttribute("aria-label");
      const coveringLabel = coveringCard?.getAttribute("aria-label") ??
        hit?.className ?? "nothing";
      return coveringCard === card
        ? []
        : [`${cardLabel} covered by ${coveringLabel}`];
    }),
  ));
  expect(covered).toEqual([]);
  const label = page.locator(".opponent-seat--right .pattern-label");
  await expect(label).toHaveText("飞机");
  expect(await label.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    ) === element;
  })).toBe(true);
  await page.getByRole("button", { name: "返回首页" }).click();
  await expect(page.getByRole("button", { name: "开始游戏" })).toBeVisible();
});

async function expectNoViewportOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    width: document.documentElement.scrollWidth,
  }))).toEqual({
    height: await page.evaluate(() => window.innerHeight),
    width: await page.evaluate(() => window.innerWidth),
  });
}

function intersects(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

async function expectCompactDesktopHand(
  page: Page,
  viewportWidth: number,
  expectedCount: 17 | 20,
) {
  const hand = page.getByLabel("你的手牌");
  const cards = hand.getByRole("button");
  await expect(cards).toHaveCount(expectedCount);

  await hand.evaluate((element) =>
    Promise.all(element.getAnimations().map(({ finished }) => finished)),
  );
  const handBox = await hand.boundingBox();
  const firstBox = await cards.first().boundingBox();
  const secondBox = await cards.nth(1).boundingBox();
  const lastBox = await cards.last().boundingBox();
  expect(handBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(lastBox).not.toBeNull();

  expect(firstBox!.width).toBeGreaterThanOrEqual(78);
  expect(firstBox!.width).toBeLessThanOrEqual(86);
  expect(secondBox!.x).toBeLessThan(firstBox!.x + firstBox!.width - 8);
  if (expectedCount === 17) {
    const preferredStepRatio = (secondBox!.x - firstBox!.x) / firstBox!.width;
    expect(preferredStepRatio).toBeGreaterThanOrEqual(0.68);
    expect(preferredStepRatio).toBeLessThanOrEqual(0.72);
  }
  expect(lastBox!.x + lastBox!.width - firstBox!.x).toBeLessThanOrEqual(1_041);
  expect(handBox!.x + handBox!.width / 2).toBeCloseTo(viewportWidth / 2, 0);
}

test("moves from the quiet home into a complete narrow bidding table", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 340 });
  await useDeterministicRandom(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "单机斗地主" })).toBeVisible();
  await expect(page.getByText("一人 · 两位本地 AI · 完全离线")).toBeVisible();
  await expect(page.getByLabel("三张牌背").getByRole("img", { name: "牌背" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "开始游戏" })).toBeVisible();
  await expect(page.getByText(/调试|架构验证|电脑/)).toHaveCount(0);

  const startBox = await page.getByRole("button", { name: "开始游戏" }).boundingBox();
  expect(startBox).not.toBeNull();
  expect(startBox!.x + startBox!.width / 2).toBeCloseTo(320, 0);

  await page.getByRole("button", { name: "开始游戏" }).click();

  await expect(page.getByRole("button", { name: "不叫" })).toBeVisible();
  await expect(page.getByRole("button", { name: "叫地主" })).toBeVisible();
  await expect(page.getByLabel("你的手牌").getByRole("button")).toHaveCount(17);
  await expect(page.getByLabel("三张底牌").getByRole("img", { name: /未揭晓底牌/ })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "出牌" })).toHaveCount(0);
  await expectNoViewportOverflow(page);

  for (const locator of [
    page.getByRole("button", { name: "不叫" }),
    page.getByRole("button", { name: "叫地主" }),
    page.getByLabel("你的手牌"),
  ]) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(641);
    expect(box!.y + box!.height).toBeLessThanOrEqual(341);
  }
});

test("presents opponent counts as borderless noninteractive card-stack status", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 400 });
  await useDeterministicRandom(page, 3);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  for (const side of ["左侧", "右侧"] as const) {
    const seat = page.getByLabel(new RegExp(`${side}玩家，剩余17张牌，农民`));
    const status = seat.locator(".opponent-status");
    await expect(status).toBeVisible();
    await expect(status.locator(".opponent-stack .remaining-count")).toHaveText("17");
    await expect(status.getByText("农民", { exact: true })).toBeVisible();
    await expect(seat.getByRole("button")).toHaveCount(0);
    await expect(seat.locator(".seat-identity")).toHaveCount(0);
    await expect(status).toHaveCSS("border-top-style", "none");
    await expect(status).toHaveCSS("box-shadow", "none");
    await expect(status).toHaveCSS("cursor", "auto");
  }
});

test("centers larger overlapping hands and opponent anchors on desktop", async ({ page }) => {
  await useDeterministicRandom(page, 4);

  for (const viewport of [
    { width: 1_366, height: 768 },
    { width: 1_440, height: 900 },
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: "开始游戏" }).click();

    await expectCompactDesktopHand(page, viewport.width, 17);
    const stageInset = (viewport.width - 1_180) / 2;
    const leftSeat = await page.locator(".opponent-seat--left").boundingBox();
    const rightSeat = await page.locator(".opponent-seat--right").boundingBox();
    expect(leftSeat).not.toBeNull();
    expect(rightSeat).not.toBeNull();
    expect(leftSeat!.x).toBeGreaterThanOrEqual(stageInset + 12);
    expect(rightSeat!.x + rightSeat!.width).toBeLessThanOrEqual(viewport.width - stageInset - 12);

    await page.getByRole("button", { name: "叫地主" }).click();
    await expectCompactDesktopHand(page, viewport.width, 20);
  }
});

test("plays a complete human-landlord round with selection feedback and the final play retained", async ({ page }) => {
  await page.clock.install();
  await useDeterministicRandom(page, 1);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  const hand = page.getByLabel("你的手牌");
  const cards = hand.getByRole("button");
  await expect(cards).toHaveCount(20);
  await expect(page.getByLabel(/左侧玩家，剩余17张牌，农民/)).toBeVisible();
  await expect(page.getByLabel(/右侧玩家，剩余17张牌，农民/)).toBeVisible();
  await expect(page.getByLabel("你的牌数和角色")).toContainText("地主");
  await expect(page.getByLabel("三张底牌").getByRole("img")).toHaveCount(3);
  await expect(page.getByLabel("三张底牌").getByRole("img", { name: /未揭晓/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "不出" })).toHaveCount(0);
  await expect(hand.locator(".playing-card--received")).toHaveCount(3);
  await expect(hand.locator(".playing-card--received").first()).toHaveCSS("animation-name", "bottom-card-received");

  await cards.nth(0).click();
  await cards.nth(2).click();
  await expect(page.getByText("这些牌不能这样出")).toBeVisible();
  await expect(page.getByRole("button", { name: "出牌" })).toBeDisabled();

  await page.getByRole("button", { name: "提示" }).click();
  await expect(page.getByText("这些牌不能这样出")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "出牌" })).toBeEnabled();
  expect(await cards.evaluateAll((elements) =>
    elements.filter((element) => element.getAttribute("aria-pressed") === "true").length,
  )).toBeGreaterThan(0);
  await page.getByRole("button", { name: "出牌" }).click();

  let settled = false;
  for (let step = 0; step < 512; step += 1) {
    const result = page.getByRole("heading", { name: /胜利|失败/ });
    if (await result.isVisible()) {
      settled = true;
      break;
    }
    const hint = page.getByRole("button", { name: "提示" });
    const pass = page.getByRole("button", { name: "不出" });
    if (await hint.isVisible()) {
      await hint.click();
      await page.getByRole("button", { name: "出牌" }).click();
    } else if (await pass.isVisible()) {
      await pass.click();
    }
    await page.clock.fastForward(650);
  }

  expect(settled).toBe(true);
  await expect(page.getByRole("heading", { name: "胜利" })).toBeVisible();
  await expect(page.getByText(/地主获胜|农民获胜/)).toBeVisible();
  await expect(page.getByRole("button", { name: "返回首页" })).toBeVisible();
  await expect(page.getByRole("button", { name: "再来一局" })).toBeVisible();
  await expect(page.locator(".seat-action__play")).not.toHaveCount(0);
  await expect(page.locator(".opponent-status").first()).toHaveCSS("opacity", "0.24");
  const resultBox = await page.locator(".result-message").boundingBox();
  const resultTitle = page.locator(".result-message h1");
  const resultSubtitle = page.locator(".result-message p");
  expect(resultBox).not.toBeNull();
  await expect(resultTitle).toHaveCSS("font-weight", "700");
  await expect(resultTitle).toHaveCSS("letter-spacing", "normal");
  await expect(resultSubtitle).toHaveCSS("margin-top", "14px");
  // Measure related elements in one browser frame; separate remote reads can
  // straddle the result's 4px entry animation and report a false spacing error.
  const resultSpacing = await page.locator(".result-message").evaluate((message) => {
    const title = message.querySelector("h1")!.getBoundingClientRect();
    const subtitle = message.querySelector("p")!.getBoundingClientRect();
    return subtitle.top - title.bottom;
  });
  expect(resultSpacing).toBeCloseTo(14, 0);
  for (const play of await page.locator(".seat-action__play").all()) {
    const playBox = await play.boundingBox();
    expect(playBox).not.toBeNull();
    expect(intersects(playBox!, resultBox!)).toBe(false);
  }
  await expectNoViewportOverflow(page);
});

test("opens the deal as one readable group and removes positional motion when reduced", async ({ page }) => {
  await useDeterministicRandom(page, 41);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();

  await expect(page.getByLabel("你的手牌")).toHaveCSS("animation-name", "hand-open");
  await expect(page.getByLabel("三张底牌")).toHaveCSS("animation-name", "bottom-cards-continue");

  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("button", { name: "结束本局" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "开始游戏" }).click();

  await expect(page.getByLabel("你的手牌")).toHaveCSS("animation-name", "none");
  await expect(page.getByLabel("三张底牌")).toHaveCSS("animation-name", "none");
});

test("keeps a rocket and both passes visible until the trick clears together", async ({ page }) => {
  await page.clock.install();
  await useIdentityDeck(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  await page.getByLabel("你的手牌").getByRole("button", { name: "大王" }).click();
  await page.getByLabel("你的手牌").getByRole("button", { name: "小王" }).click();
  await page.getByRole("button", { name: "出牌" }).click();
  await expect(page.getByText("王炸")).toBeVisible();
  await expect(page.getByLabel("你的出牌区域").getByRole("img")).toHaveCount(2);

  await page.clock.fastForward(520);
  await expect(page.locator(".opponent-seat--right .seat-action__pass")).toHaveText("不出");
  await page.clock.fastForward(520);
  await expect(page.locator(".opponent-seat--left .seat-action__pass")).toHaveText("不出");
  await expect(page.getByText("王炸")).toBeVisible();
  await expect(page.getByRole("button", { name: "提示" })).toHaveCount(0);

  await page.clock.fastForward(400);
  await expect(page.getByText("王炸")).toHaveCount(0);
  await expect(page.locator(".seat-action__pass")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "提示" })).toBeVisible();
  await expect(page.getByRole("button", { name: "出牌" })).toBeDisabled();
});

test("continuously selects and deselects exposed cards without reordering the hand", async ({ page }) => {
  await useIdentityDeck(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  const cards = page.getByLabel("你的手牌").getByRole("button");
  const targets = [cards.nth(3), cards.nth(4), cards.nth(5), cards.nth(6)];
  const idsBefore = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-card-id")),
  );

  await swipeAcross(page, targets);
  for (const card of targets) {
    await expect(card).toHaveAttribute("aria-pressed", "true");
  }

  await swipeAcross(page, targets);
  for (const card of targets) {
    await expect(card).toHaveAttribute("aria-pressed", "false");
  }
  await expect(cards).toHaveCount(20);
  await expect.poll(() => cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-card-id")),
  )).toEqual(idsBefore);
});

test("settles the origin with the rest while continuous deselection is still held", async ({ page }) => {
  await useIdentityDeck(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  const cards = page.getByLabel("你的手牌").getByRole("button");
  const targets = [cards.nth(3), cards.nth(4), cards.nth(5), cards.nth(6), cards.nth(7)];
  await swipeAcross(page, targets);
  for (const card of targets) {
    await expect(card).toHaveAttribute("aria-pressed", "true");
  }

  const points = await Promise.all(targets.map(exposedPoint));
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
  }
  for (const card of targets) {
    await expect(card).toHaveAttribute("aria-pressed", "false");
  }
  await page.waitForTimeout(150);

  const transforms = await Promise.all(targets.map((card) =>
    card.evaluate((element) => getComputedStyle(element).transform)
  ));
  expect(new Set(transforms).size).toBe(1);
  await page.mouse.up();
});

test("recovers every crossed card from one fast pointer move", async ({ page }) => {
  await useIdentityDeck(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  const cards = page.getByLabel("你的手牌").getByRole("button");
  await swipeInOneMove(page, cards.nth(3), cards.nth(6));

  for (const index of [3, 4, 5, 6]) {
    await expect(cards.nth(index)).toHaveAttribute("aria-pressed", "true");
  }
  await expect(cards.nth(2)).toHaveAttribute("aria-pressed", "false");
  await expect(cards.nth(7)).toHaveAttribute("aria-pressed", "false");

  await swipeInOneMove(page, cards.nth(6), cards.nth(3));
  for (const index of [3, 4, 5, 6]) {
    await expect(cards.nth(index)).toHaveAttribute("aria-pressed", "false");
  }

  const [start, outside, reentry, handBox] = await Promise.all([
    exposedPoint(cards.nth(3)),
    exposedPoint(cards.nth(4)),
    exposedPoint(cards.nth(6)),
    page.getByLabel("你的手牌").boundingBox(),
  ]);
  expect(handBox).not.toBeNull();
  const outsideY = handBox!.y - 32;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(outside.x, outsideY);
  await page.mouse.move(reentry.x, outsideY);
  await page.mouse.move(reentry.x, reentry.y);
  await page.mouse.up();

  await expect(cards.nth(3)).toHaveAttribute("aria-pressed", "true");
  await expect(cards.nth(4)).toHaveAttribute("aria-pressed", "false");
  await expect(cards.nth(5)).toHaveAttribute("aria-pressed", "false");
  await expect(cards.nth(6)).toHaveAttribute("aria-pressed", "true");
});

test("naturally narrows and smoothly regroups the hand only after an accepted play", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 360 });
  await useIdentityDeck(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  const hand = page.getByLabel("你的手牌");
  const widthBefore = (await hand.boundingBox())!.width;
  await hand.getByRole("button", { name: "大王" }).click();
  await hand.getByRole("button", { name: "小王" }).click();
  await page.getByRole("button", { name: "出牌" }).click();

  await expect(hand.getByRole("button")).toHaveCount(18);
  expect((await hand.boundingBox())!.width).toBeLessThan(widthBefore - 20);
  await expect.poll(() => hand.getByRole("button").first().evaluate((element) =>
    element.getAnimations().some((animation) => animation.id === "hand-regroup"),
  )).toBe(true);
  expect(await hand.getByRole("button").first().evaluate((element) => {
    const animation = element.getAnimations().find(({ id }) => id === "hand-regroup");
    const timing = animation?.effect?.getTiming();
    return timing === undefined ? null : {
      duration: timing.duration,
      easing: timing.easing,
    };
  })).toEqual({
    duration: 180,
    easing: "cubic-bezier(0.77, 0, 0.175, 1)",
  });
});

test("makes hand regroup immediate when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useIdentityDeck(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "叫地主" }).click();

  const hand = page.getByLabel("你的手牌");
  await hand.getByRole("button", { name: "大王" }).click();
  await hand.getByRole("button", { name: "小王" }).click();
  await page.getByRole("button", { name: "出牌" }).click();

  await expect(hand.getByRole("button")).toHaveCount(18);
  expect(await hand.getByRole("button").first().evaluate((element) =>
    element.getAnimations().some((animation) => animation.id === "hand-regroup"),
  )).toBe(false);
});

test("pauses AI presentation for exit confirmation and resumes the exact match after rotation", async ({ page }) => {
  await page.clock.install();
  await useIdentityDeck(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();
  await page.getByRole("button", { name: "不叫" }).click();
  await expect(page.getByLabel("你的出牌区域")).toContainText("不叫");

  await page.getByRole("button", { name: "返回" }).click();
  const dialog = page.getByRole("dialog", { name: "结束本局确认" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "继续游戏" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "结束本局" })).toBeVisible();
  await page.clock.fastForward(2_000);
  await expect(page.locator(".opponent-seat .seat-action__bid")).toHaveCount(0);

  await dialog.getByRole("button", { name: "继续游戏" }).click();
  await page.clock.fastForward(520);
  await expect(page.locator(".opponent-seat--right .seat-action__bid")).toHaveText("不叫");
  await page.clock.fastForward(520);
  await expect(page.getByLabel(/左侧玩家，剩余20张牌，地主/)).toBeVisible();

  await page.setViewportSize({ width: 400, height: 800 });
  await expect(page.getByRole("heading", { name: "请旋转手机" })).toBeVisible();
  await expect(page.getByText("横屏后即可继续")).toBeVisible();
  await expect(page.locator(".landscape-surface")).not.toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);

  await page.setViewportSize({ width: 800, height: 360 });
  await expect(page.getByLabel(/左侧玩家，剩余20张牌，地主/)).toBeVisible();
  await page.clock.fastForward(520);
  await expect(page.getByLabel("你的手牌").getByRole("button")).toHaveCount(17);
  await expect(page.getByRole("button", { name: /不出|提示/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("button", { name: "结束本局" }).click();
  await expect(page.getByRole("heading", { name: "单机斗地主" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始游戏" })).toBeVisible();
  await expect(page.getByLabel("你的手牌")).toHaveCount(0);
});

test("finishes a human-farmer round and rematches with a fresh deal", async ({ page }) => {
  await page.clock.install();
  await useDeterministicRandom(page, 77);
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏" }).click();

  let assigned = false;
  for (let bidStep = 0; bidStep < 24; bidStep += 1) {
    if (await page.getByLabel("你的牌数和角色").getByText("农民", { exact: true }).isVisible()) {
      assigned = true;
      break;
    }
    const decline = page.locator('[data-control="bid-decline"]');
    if (await decline.isVisible()) {
      await decline.click();
    }
    await page.clock.fastForward(650);
  }
  expect(assigned).toBe(true);

  const hand = page.getByLabel("你的手牌").getByRole("button");
  const firstDeal = await hand.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-card-id")),
  );
  let settled = false;
  let sawNoResponse = false;
  let sawLowCard = false;
  for (let step = 0; step < 512; step += 1) {
    if (await page.getByRole("heading", { name: /胜利|失败/ }).isVisible()) {
      settled = true;
      break;
    }
    const hint = page.getByRole("button", { name: "提示" });
    const pass = page.locator('[data-control="pass"]');
    if (await page.getByText("没有可以压过的牌").isVisible()) {
      sawNoResponse = true;
      await expect(page.getByLabel("当前操作").getByRole("button")).toHaveCount(1);
      await expect(pass).toBeVisible();
    }
    const lowCard = page.locator(".remaining-count--low").first();
    if (await lowCard.isVisible()) {
      sawLowCard = true;
      await expect(lowCard).toHaveText(/^[12]$/);
      await expect(lowCard).toHaveCSS("animation-name", "low-card");
      await expect(page.locator(".opponent-low-announcement").filter({ hasText: /只剩[12]张牌/ }).first()).toHaveAttribute("aria-live", "polite");
    }
    if (await hint.isVisible()) {
      await hint.click();
      await page.getByRole("button", { name: "出牌" }).click();
    } else if (await pass.isVisible()) {
      await pass.click();
    }
    await page.clock.fastForward(650);
  }
  expect(settled).toBe(true);
  expect(sawNoResponse).toBe(true);
  expect(sawLowCard).toBe(true);
  await expect(page.getByRole("heading", { name: "失败" })).toBeVisible();

  await page.setViewportSize({ width: 1_440, height: 900 });
  for (const name of ["返回首页", "再来一局"] as const) {
    const button = page.getByRole("button", { name });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await button.click({
      position: { x: box!.width / 2, y: box!.height / 2 },
      trial: true,
    });
    await button.click({
      position: { x: box!.width / 2, y: box!.height - 4 },
      trial: true,
    });
  }

  await page.getByRole("button", { name: "再来一局" }).click();
  await expect(page.locator('[data-control="bid-decline"]')).toBeVisible();
  await expect(page.locator('[data-control="bid-call"]')).toBeVisible();
  await expect(hand).toHaveCount(17);
  const rematchDeal = await hand.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-card-id")),
  );
  expect(rematchDeal).not.toEqual(firstDeal);
  await expect(page.getByLabel("三张底牌").getByRole("img", { name: /未揭晓底牌/ })).toHaveCount(3);
  await expectNoViewportOverflow(page);
});

test("relaunches the installed build offline at home without claiming recovery", async ({ context, page }) => {
  await useDeterministicRandom(page, 99);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.getByRole("button", { name: "开始游戏" }).click();
  await expect(page.getByLabel("你的手牌")).toBeVisible();

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "单机斗地主" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始游戏" })).toBeVisible();
  await expect(page.getByText(/继续游戏|继续牌局/)).toHaveCount(0);
  await expect(page.getByLabel("你的手牌")).toHaveCount(0);
});

test("starts the embedded build without registering a service worker", async ({ page }) => {
  await useDeterministicRandom(page, 99);
  await page.goto("/embedded.html");

  await expect(page.getByRole("heading", { name: "单机斗地主" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始游戏" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).length,
  )).toBe(0);
});

for (const viewport of [
  { width: 800, height: 360 },
  { width: 900, height: 400 },
  { width: 640, height: 340 },
] as const) {
  test(`fits a selected 20-card hand and its actions at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize(viewport);
    await useIdentityDeck(page);
    await page.goto("/");
    await page.getByRole("button", { name: "开始游戏" }).click();
    await page.getByRole("button", { name: "叫地主" }).click();
    await page.clock.fastForward(600);
    await page.getByRole("button", { name: "提示" }).click();

    await expectNoViewportOverflow(page);
    const cards = await page.getByLabel("你的手牌").getByRole("button").all();
    const actions = await page.getByLabel("当前操作").getByRole("button").all();
    const actionBoxes = await Promise.all(actions.map((action) => action.boundingBox()));
    const exposedRankSize = await page.getByLabel("你的手牌").locator(".playing-card__corner").first().evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).fontSize),
    );
    expect(exposedRankSize).toBeGreaterThanOrEqual(13);
    for (const card of cards) {
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
      for (const actionBox of actionBoxes) {
        expect(actionBox).not.toBeNull();
        expect(intersects(box!, actionBox!)).toBe(false);
      }
    }
  });

  test(`keeps quiet card indices readable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize(viewport);
    await useIdentityDeck(page);
    await page.goto("/");
    await page.getByRole("button", { name: "开始游戏" }).click();
    await page.getByRole("button", { name: "叫地主" }).click();
    await page.clock.fastForward(700);
    const hand = page.getByLabel("你的手牌");
    await expect(hand.getByRole("button")).toHaveCount(20);
    await expect(hand.getByRole("button", { name: "大王", exact: true })).toHaveText("JOKER");
    await expect(hand.getByRole("button", { name: "小王", exact: true })).toHaveText("JOKER");
    await expect(page.locator(".playing-card__center")).toHaveCount(0);
    const violations = await hand.locator(".playing-card").evaluateAll((cards) => cards.flatMap((card, index) => {
      const bounds = card.getBoundingClientRect();
      const edge = cards[index + 1]?.getBoundingClientRect().left ?? bounds.right;
      return Array.from(card.querySelectorAll("strong, .suit-mark, .playing-card__joker-word")).flatMap((mark) => {
        const box = mark.getBoundingClientRect();
        const font = Number.parseFloat(getComputedStyle(mark).fontSize);
        return box.left < bounds.left || box.right > edge - 1 || box.bottom > bounds.bottom ||
          (mark.tagName === "STRONG" && font < 21)
          ? [`${card.getAttribute("aria-label")}: clipped or undersized index`] : [];
      });
    }));
    expect(violations).toEqual([]);
    await hand.getByRole("button", { name: "大王", exact: true }).click({ position: { x: 5, y: 20 } });
    await hand.getByRole("button", { name: "小王", exact: true }).click({ position: { x: 5, y: 20 } });
    await page.getByRole("button", { name: "出牌" }).click();
    await page.clock.fastForward(250);
    const jokers = page.locator(".human-play-zone .table-card");
    await expect(jokers).toHaveCount(2);
    for (const joker of await jokers.all()) {
      await expect(joker).toHaveText("JOKER");
      expect(
        await joker.evaluate((card) =>
          Number.parseFloat(getComputedStyle(card).width),
        ),
      ).toBeGreaterThanOrEqual(38);
      const size = await joker.locator(".playing-card__joker-word").evaluate(
        (word) => Number.parseFloat(getComputedStyle(word).fontSize),
      );
      expect(size).toBeGreaterThanOrEqual(11);
    }
  });
}

for (const count of [12, 20] as const) {
  test(`retains readable ${count}-card public plays on a narrow table`, async ({ page }) => {
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 640, height: 340 });
    const ids = count === 12
      ? Array.from({ length: 12 }, (_, rank) => rank * 4)
      : [
          ...Array.from({ length: 4 }, (_, rank) => [
            rank * 4,
            rank * 4 + 1,
            rank * 4 + 2,
          ]).flat(),
          ...Array.from({ length: 4 }, (_, rank) => [
            (rank + 4) * 4,
            (rank + 4) * 4 + 1,
          ]).flat(),
        ];
    await useSeatHand(page, ids);
    await page.goto("/");
    await page.getByRole("button", { name: "开始游戏" }).click();
    await page.getByRole("button", { name: "叫地主", exact: true }).click();
    await page.clock.fastForward(700);
    for (const id of ids) {
      await page.locator(`[data-card-id="${id}"]`).click({
        position: { x: 5, y: 20 },
      });
    }
    await page.getByRole("button", { name: "出牌" }).click();
    const cards = page.locator(".human-play-zone .table-card");
    await expect(cards).toHaveCount(count);
    const check = async () => {
      const hidden = await cards.evaluateAll((elements) => elements.flatMap((card) =>
        Array.from(card.querySelectorAll("strong, .suit-mark")).flatMap((mark) => {
          const box = mark.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth ||
            hit?.closest(".table-card") !== card ? [card.getAttribute("aria-label")] : [];
        }),
      ));
      expect(hidden).toEqual([]);
    };
    await check();
    if (count === 20) {
      await page.clock.fastForward(700);
      await expect(
        page.getByRole("heading", { name: "胜利", exact: true }),
      ).toBeVisible();
      await check();
      await page.getByRole("button", { name: "再来一局" }).click();
      await expect(
        page.getByRole("button", { name: "叫地主", exact: true }),
      ).toBeVisible();
    }
  });
}
