import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readJson(relativePath: string): Promise<unknown> {
  const contents = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return JSON.parse(contents) as unknown;
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(new URL(relativePath, import.meta.url), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("repository configuration", () => {
  it("identifies a private static Web/PWA package", async () => {
    const packageConfig = await readJson("../../package.json");

    expect(packageConfig).toMatchObject({
      description: "Offline, accessible Dou Dizhu Web/PWA",
      license: "Apache-2.0",
      name: "offline-doudizhu",
      private: true,
    });
    expect(packageConfig).not.toHaveProperty("author");
  });

  it("removes retired platform configuration and keeps Web entry files", async () => {
    await expect(exists("../../game.json")).resolves.toBe(false);
    await expect(exists("../../project.config.example.json")).resolves.toBe(false);
    await expect(exists("../../tsconfig.wechat.json")).resolves.toBe(false);
    await expect(exists("../../index.html")).resolves.toBe(true);
    await expect(exists("../../vite.config.ts")).resolves.toBe(true);
  });
});
