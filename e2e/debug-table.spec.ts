import { expect, test, type Locator, type Page } from "@playwright/test";

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Expected a visible card bounding box.");
  }
  return { x: box.x + 6, y: box.y + box.height / 2 };
}

async function swipeAcross(page: Page, cards: readonly Locator[]) {
  const points = await Promise.all(cards.map(center));
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

test("renders 17 semantic cards and supports discrete actions", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "单机斗地主" })).toBeVisible();
  const cards = page.locator(".playing-card");
  await expect(cards).toHaveCount(17);
  await expect(page.getByRole("button", { name: "不出" })).toBeVisible();
  await expect(page.getByRole("button", { name: "提示" })).toBeVisible();
  await expect(page.getByRole("button", { name: "出牌" })).toBeVisible();

  const first = cards.first();
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "不出" }).click();
  await expect(page.getByText(/上次：不出（调试）/)).toBeVisible();
  await page.getByRole("button", { name: "提示" }).click();
  await expect(page.getByText(/上次：提示（调试）/)).toBeVisible();
  await page.getByRole("button", { name: "出牌" }).click();
  await expect(page.getByText(/上次：出牌（调试）· 共 3 次/)).toBeVisible();
});

test("continuously selects and deselects cards without moving their order", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator(".playing-card");
  const targets = [cards.nth(0), cards.nth(1), cards.nth(2), cards.nth(3)];
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
  await expect(cards).toHaveCount(17);
  await expect.poll(() => cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-card-id")),
  )).toEqual(idsBefore);
});

test("portrait exposes only the rotate gate", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 400 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "请旋转手机" })).toBeVisible();
  await expect(page.locator(".table-screen")).not.toBeVisible();
  await expect(page.locator(".playing-card").first()).not.toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
});

for (const viewport of [
  { height: 360, width: 800 },
  { height: 400, width: 900 },
  { height: 340, width: 640 },
]) {
  test(`keeps essential controls inside ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const essential = page.locator(".playing-card, .action-button");
    for (const element of await essential.all()) {
      const box = await element.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    await expect.poll(() => page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      width: document.documentElement.scrollWidth,
    }))).toEqual({ height: viewport.height, width: viewport.width });
  });
}

test("relaunches the installed build while the browser context is offline", async ({ context, page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "单机斗地主" })).toBeVisible();
  await expect(page.locator(".playing-card")).toHaveCount(17);
});
