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
  const resultBox = await page.locator(".result-message").boundingBox();
  expect(resultBox).not.toBeNull();
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
      await expect(lowCard).toHaveText(/剩[12]张/);
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
}
